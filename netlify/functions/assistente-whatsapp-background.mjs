// Assistente da Nexus no WhatsApp: conversa livre com os corretores da equipe, como uma funcionária.
// Consulta negócios, pagamentos, embarques, cadastros e cotações direto no banco e lança coisas simples
// (pagamento recebido, carga entregue, item do checklist, tarefa, documento pendente) — sempre pedindo
// confirmação antes de gravar. O whatsapp-webhook confere que o número é de um corretor e chama esta
// função em segundo plano; o histórico fica em nexus_assistente_msgs.
import { randomUUID } from "node:crypto";
import { SUPABASE_URL, TIPO_LABEL, aplicarDocumentoNoNegocio, registrarUsoIA, transcreverAudio as transcrever, salvarNoDrive, nomeArquivoDoc, nomePastaContrato } from "./_documento-lib.mjs";

const MODELO = "claude-sonnet-5-5";
const MAX_VOLTAS = 8;
const HISTORICO_HORAS = 12, HISTORICO_MAX = 24;

const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = () => ({ apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}` });
async function db(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...H(), "Content-Type": "application/json", ...(opts.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`banco ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

// Número BR que a Z-API manda no formato antigo (55 + DDD + 8 dígitos) ganha o 9 do celular.
function telefoneEnvio(t) {
  const d = String(t || "").replace(/\D/g, "");
  return d.length === 12 && d.startsWith("55") && /[6-9]/.test(d[4]) ? d.slice(0, 4) + "9" + d.slice(4) : d;
}
async function responder(telefone, mensagem) {
  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN } = process.env;
  for (const phone of [...new Set([telefone, telefoneEnvio(telefone)])]) {
    const r = await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN },
      body: JSON.stringify({ phone, message: mensagem }),
    }).catch(e => ({ ok: false, status: 0, text: async () => String(e) }));
    const corpo = await r.text();
    console.log("Z-API envio", phone, r.status, corpo.slice(0, 300));
    if (r.ok && !/error/i.test(corpo)) return;
  }
}

const hoje = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Campo_Grande" });
const fmtDate = iso => iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—";
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

// ---------- dados ----------
let cache = null;
async function dados() {
  if (cache) return cache;
  const [negocios, cadastros, equipe, cfg] = await Promise.all([
    db("nexus_negocios?deleted_at=is.null&select=*&order=numero_contrato.desc"),
    db("nexus_cadastros?select=id,nome,apelido,tipo,categoria_comprador"),
    db("nexus_equipe?select=user_id,nome,telefone,telefones_extra"),
    db("nexus_config?id=eq.1&select=fundersul_saca,fundems_saca,funrural_pct"),
  ]);
  cache = { negocios, cadastros, equipe, config: cfg[0] || {} };
  return cache;
}
const cad = (d, id) => d.cadastros.find(c => c.id === id);
const nomeCad = (d, id) => cad(d, id)?.nome || "";
const vendedorDe = (d, n) => nomeCad(d, n.produtor_id);
const compradorDe = (d, n) => n.cliente_id ? nomeCad(d, n.cliente_id) : (n.contraparte || "");
const corretorDe = (d, n) => d.equipe.find(e => e.user_id === n.corretor_id)?.nome || "";

// Mesma conta de preço líquido do painel (precoLiquidoNegocio).
function precoLiquido(d, n) {
  if (n.preco_liquido != null && n.preco_liquido !== "") return Number(n.preco_liquido);
  const comp = n.cliente_id ? cad(d, n.cliente_id) : null;
  const sacas = Number(n.quantidade || 0), total = Number(n.preco || 0) * sacas;
  const comFF = !comp || (comp.categoria_comprador !== "Cooperativa" && comp.categoria_comprador !== "Cerealista");
  const ff = comFF ? (Number(d.config.fundersul_saca || 0) + Number(d.config.fundems_saca || 0)) * sacas : 0;
  const funrural = (n.funrural_forma || "Comercialização") === "Comercialização" ? total * Number(d.config.funrural_pct || 0) / 100 : 0;
  const comissao = n.comissao_pagador === "Comprador" ? 0 : Number(n.comissao || 0);
  return sacas ? (total - comissao - total * 0.002 - ff - funrural) / sacas : 0;
}
const cargasDe = n => Array.isArray(n.cargas) ? n.cargas : [];
const entregue = n => cargasDe(n).reduce((s, c) => s + Number(c.sacas || 0), 0);
function parcelas(n) {
  const extras = n.pagamentos_extra || [];
  if (!extras.length || n.pagamento_dias_apos_entrega != null) return [{ data: n.data_pagamento, pago: !!n.check_pagamento }];
  const completa = extras[0].data === n.data_pagamento;
  const outras = extras.map(p => ({ data: p.data, valor: p.valor, unidade: p.unidade, pago: !!p.pago })).slice(completa ? 1 : 0);
  return [{ data: n.data_pagamento, pago: !!n.check_pagamento }, ...outras];
}
const CHECK = { confirmacao: "check_confirmacao", contrato: "check_contrato", nota_fiscal: "check_nota_fiscal", contra_nota: "check_contra_nota", liberacao_embarque: "check_liberacao_embarque", embarque_entrega: "check_embarque_entrega", comissao: "check_comissao" };
function pendencias(n) {
  const p = Object.entries(CHECK).filter(([, c]) => c !== "check_comissao" && !n[c]).map(([k]) => k);
  if (!parcelas(n).every(x => x.pago)) p.push("pagamento");
  return p;
}
function resumo(d, n) {
  return {
    contrato: n.numero_contrato, grao: n.grao, safra: n.safra, vendedor: vendedorDe(d, n), comprador: compradorDe(d, n), corretor: corretorDe(d, n),
    sacas: Number(n.quantidade || 0), preco: Number(n.preco || 0), preco_liquido: Math.round(precoLiquido(d, n) * 100) / 100,
    comissao: Number(n.comissao || 0), data: n.data, data_pagamento: n.data_pagamento, status: n.status, modalidade: n.modalidade,
    entregue_sacas: Math.round(entregue(n) * 100) / 100, embarque_finalizado: !!n.embarque_finalizado, pendencias: pendencias(n),
  };
}
function acharNegocio(d, numero) {
  const m = String(numero || "").match(/(?:(\d{4})\D+)?0*(\d{1,4})\s*$/);
  if (!m) return null;
  return d.negocios.find(n => {
    const c = String(n.numero_contrato || "").match(/^CT-(\d{4})-0*(\d+)$/i);
    return c && c[2] === m[2] && (!m[1] || c[1] === m[1]);
  }) || null;
}
function casaTexto(d, n, texto) {
  const alvo = norm(texto).split(/\s+/).filter(Boolean);
  const alvoTxt = norm([n.numero_contrato, vendedorDe(d, n), compradorDe(d, n), cad(d, n.produtor_id)?.apelido, n.grao, n.safra, n.local_origem].join(" "));
  return alvo.every(p => alvoTxt.includes(p));
}

// ---------- ferramentas ----------
const FERRAMENTAS = [
  { name: "buscar_negocios", description: "Lista negócios (contratos) da Nexus com filtros. Use para perguntas como 'quais contratos do Jonis', 'milho 27/27 fechados', 'negócios do Maycon este mês'. Devolve um resumo por contrato (sacas, preço, preço líquido, comissão, datas, status, entregue, pendências do checklist).",
    input_schema: { type: "object", properties: {
      texto: { type: "string", description: "Palavras para buscar no nº do contrato, vendedor, comprador, grão, safra ou local (todas precisam aparecer)." },
      grao: { type: "string" }, safra: { type: "string", description: "Ex.: 2026/2026, 2025/2026, 2027/2027" },
      status: { type: "string", enum: ["Negociação", "Fechado", "Finalizado"] },
      corretor: { type: "string", description: "Nome do corretor responsável." },
      de: { type: "string", description: "Data do negócio a partir de (AAAA-MM-DD)." }, ate: { type: "string", description: "Data do negócio até (AAAA-MM-DD)." },
      limite: { type: "integer", description: "Máximo de contratos (padrão 30)." } } } },
  { name: "totais_negocios", description: "Soma sacas, valor e comissão dos negócios filtrados, agrupando por grão e safra. Use para 'quanto temos negociado de milho 27/27', 'comissão do mês', 'volume do Lucas'.",
    input_schema: { type: "object", properties: {
      texto: { type: "string" }, grao: { type: "string" }, safra: { type: "string" }, status: { type: "string", enum: ["Negociação", "Fechado", "Finalizado"] },
      corretor: { type: "string" }, de: { type: "string" }, ate: { type: "string" } } } },
  { name: "detalhe_negocio", description: "Tudo de um contrato: partes, preço, comissão, modalidade, local, janela de embarque, parcelas de pagamento (com pago/não pago), cargas entregues, checklist, observações e anexos salvos.",
    input_schema: { type: "object", properties: { contrato: { type: "string", description: "Número do contrato: '141', 'CT 141' ou 'CT-2026-141'." } }, required: ["contrato"] } },
  { name: "agenda_pagamentos", description: "Pagamentos de contratos com data num período (a receber pelo produtor), com indicação de pago ou não.",
    input_schema: { type: "object", properties: { de: { type: "string" }, ate: { type: "string" }, so_pendentes: { type: "boolean" } }, required: ["de", "ate"] } },
  { name: "embarques_pendentes", description: "Contratos com embarque/entrega ainda não finalizado: janela, quanto já foi entregue e quanto falta.",
    input_schema: { type: "object", properties: { texto: { type: "string" } } } },
  { name: "buscar_cadastro", description: "Dados de um produtor, comprador ou transportadora: telefone, e-mail, CPF/CNPJ, inscrição estadual, endereço, dados bancários, fazendas (com IE).",
    input_schema: { type: "object", properties: { nome: { type: "string" } }, required: ["nome"] } },
  { name: "cotacoes", description: "Cotações do mercado no painel (CBOT, B3, Paranaguá, dólar) e os preços do dia que a Nexus está passando aos clientes.",
    input_schema: { type: "object", properties: {} } },
  { name: "tarefas_abertas", description: "Tarefas/lembretes em aberto da equipe.", input_schema: { type: "object", properties: {} } },

  { name: "marcar_pagamento", description: "GRAVA: marca pagamento recebido de um contrato (todas as parcelas, ou só a parcela de uma data). Só chame depois que o corretor confirmou com 'sim'.",
    input_schema: { type: "object", properties: { contrato: { type: "string" }, data_parcela: { type: "string", description: "AAAA-MM-DD da parcela; vazio = todas." }, pago: { type: "boolean", description: "true marca pago (padrão), false desmarca." } }, required: ["contrato"] } },
  { name: "registrar_carga", description: "GRAVA: registra uma carga entregue num contrato (data e quantidade em kg ou sacas). Recalcula a data de pagamento quando o contrato paga X dias após a entrega. Só chame depois que o corretor confirmou com 'sim'.",
    input_schema: { type: "object", properties: { contrato: { type: "string" }, data: { type: "string" }, quantidade: { type: "number" }, unidade: { type: "string", enum: ["kg", "sc"] }, documento: { type: "string", description: "Nº do ticket ou NF (opcional)." } }, required: ["contrato", "data", "quantidade", "unidade"] } },
  { name: "marcar_checklist", description: "GRAVA: marca ou desmarca um item do checklist do contrato (confirmacao, contrato, nota_fiscal, contra_nota, liberacao_embarque, embarque_entrega, comissao). Só chame depois que o corretor confirmou com 'sim'.",
    input_schema: { type: "object", properties: { contrato: { type: "string" }, item: { type: "string", enum: Object.keys(CHECK) }, feito: { type: "boolean" } }, required: ["contrato", "item", "feito"] } },
  { name: "criar_tarefa", description: "GRAVA: cria uma tarefa/lembrete na agenda da equipe. Só chame depois que o corretor confirmou com 'sim'.",
    input_schema: { type: "object", properties: { titulo: { type: "string" }, prazo: { type: "string", description: "AAAA-MM-DD" }, responsavel: { type: "string" }, obs: { type: "string" } }, required: ["titulo"] } },
  { name: "criar_cadastro_produtor", description: "GRAVA: cria o cadastro de um PRODUTOR rural no painel (e a fazenda, se tiver nome/IE), com os dados lidos dos documentos que o corretor mandou. Antes, mostre o resumo dos dados e pergunte 'Confirma?'. Se já existir produtor com o mesmo CPF/CNPJ ou nome, a ferramenta avisa e não duplica: use completar_cadastro.",
    input_schema: { type: "object", properties: { dados: { type: "object", description: "Dados do produtor (deixe de fora o que não tem).", properties: {
      nome: { type: "string" }, cpf: { type: "string" }, cnpj: { type: "string" }, rg: { type: "string" }, data_nascimento: { type: "string", description: "AAAA-MM-DD" },
      inscricao_estadual: { type: "string" }, fazenda: { type: "string" }, municipio_fazenda: { type: "string", description: "ex.: São Gabriel do Oeste/MS" },
      endereco: { type: "string" }, numero: { type: "string" }, complemento: { type: "string" }, bairro: { type: "string" }, cidade: { type: "string" }, uf: { type: "string" }, cep: { type: "string" },
      telefone: { type: "string" }, email: { type: "string" },
      banco: { type: "string" }, agencia: { type: "string" }, conta: { type: "string" }, tipo_conta: { type: "string" }, pix: { type: "string" }, titular_conta: { type: "string" } } } }, required: ["dados"] } },
  { name: "completar_cadastro", description: "GRAVA: completa um cadastro que já existe (busca pelo nome, CPF ou CNPJ), preenchendo só os campos que estão vazios — a não ser que o corretor peça pra trocar (sobrescrever = true). Também cria a fazenda se ela ainda não existir. Só chame depois do 'sim'.",
    input_schema: { type: "object", properties: { quem: { type: "string", description: "Nome, CPF ou CNPJ do cadastro" }, dados: { type: "object", description: "Dados do produtor (deixe de fora o que não tem).", properties: {
      nome: { type: "string" }, cpf: { type: "string" }, cnpj: { type: "string" }, rg: { type: "string" }, data_nascimento: { type: "string", description: "AAAA-MM-DD" },
      inscricao_estadual: { type: "string" }, fazenda: { type: "string" }, municipio_fazenda: { type: "string", description: "ex.: São Gabriel do Oeste/MS" },
      endereco: { type: "string" }, numero: { type: "string" }, complemento: { type: "string" }, bairro: { type: "string" }, cidade: { type: "string" }, uf: { type: "string" }, cep: { type: "string" },
      telefone: { type: "string" }, email: { type: "string" },
      banco: { type: "string" }, agencia: { type: "string" }, conta: { type: "string" }, tipo_conta: { type: "string" }, pix: { type: "string" }, titular_conta: { type: "string" } } }, sobrescrever: { type: "boolean" } }, required: ["quem", "dados"] } },
  { name: "salvar_documento_pendente", description: "Salva no Google Drive (pasta do contrato) o documento que o corretor mandou e que ficou esperando o número do contrato. Pode chamar direto quando o corretor disser de qual contrato é (ex.: '141' ou 'sim' confirmando o palpite).",
    input_schema: { type: "object", properties: { documento_id: { type: "string" }, contrato: { type: "string" } }, required: ["documento_id", "contrato"] } },
];
const GRAVA = new Set(["marcar_pagamento", "registrar_carga", "marcar_checklist", "criar_tarefa", "criar_cadastro_produtor", "completar_cadastro"]);

// ---------- cadastro de produtor ----------
const soDig = s => String(s || "").replace(/\D/g, "");
function fmtCpfCnpj(v) {
  const d = soDig(v);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return String(v || "").trim();
}
// Dados da IA → colunas de nexus_cadastros (mesmo formato do painel: CPF com pontos, cidade "Cidade - UF").
function colunasCadastro(dd) {
  const banco = [dd.banco, dd.agencia && `Ag ${dd.agencia}`, dd.conta && `${/poupan/i.test(dd.tipo_conta || "") ? "CP" : "CC"} ${dd.conta}`, dd.pix && `PIX ${dd.pix}`, dd.titular_conta && `Titular: ${dd.titular_conta}`].filter(Boolean).join(" · ");
  const uf = (dd.uf || "").toUpperCase().slice(0, 2);
  const col = {
    nome: dd.nome && dd.nome.trim(), cpf: dd.cpf && fmtCpfCnpj(dd.cpf), cnpj: dd.cnpj && fmtCpfCnpj(dd.cnpj), inscricao_estadual: dd.inscricao_estadual,
    data_nascimento: /^\d{4}-\d{2}-\d{2}$/.test(dd.data_nascimento || "") ? dd.data_nascimento : null,
    endereco: dd.endereco, endereco_numero: dd.numero, complemento: dd.complemento, bairro: dd.bairro, cep: dd.cep && soDig(dd.cep).replace(/(\d{5})(\d{3})/, "$1-$2"),
    cidade: dd.cidade ? (uf && !/ - [A-Z]{2}$/.test(dd.cidade) ? `${dd.cidade} - ${uf}` : dd.cidade) : null, uf: uf || null,
    telefone: dd.telefone && soDig(dd.telefone).replace(/^55(?=\d{10,11}$)/, ""), email: dd.email, propriedade: dd.fazenda,
    dados_bancarios: banco || null,
  };
  return Object.fromEntries(Object.entries(col).filter(([, v]) => v != null && v !== ""));
}
async function acharCadastro(quem, dd = {}) {
  const lista = await db("nexus_cadastros?select=id,nome,tipo,cpf,cnpj,apelido");
  const docs = [soDig(dd.cpf), soDig(dd.cnpj), soDig(quem)].filter(d => d.length >= 11);
  return lista.find(c => docs.length && docs.some(d => d === soDig(c.cpf) || d === soDig(c.cnpj)))
    || lista.find(c => norm(c.nome) === norm(quem || dd.nome))
    || null;
}
async function garantirFazenda(produtorId, dd) {
  if (!dd.fazenda && !dd.inscricao_estadual) return null;
  const faz = await db(`nexus_fazendas?produtor_id=eq.${produtorId}&select=id,nome,inscricao_estadual`);
  if (faz.some(f => (dd.inscricao_estadual && soDig(f.inscricao_estadual) === soDig(dd.inscricao_estadual)) || (dd.fazenda && norm(f.nome) === norm(dd.fazenda)))) return null;
  await db("nexus_fazendas", { method: "POST", body: JSON.stringify({ produtor_id: produtorId, nome: dd.fazenda || "Fazenda", municipio_uf: dd.municipio_fazenda || null, inscricao_estadual: dd.inscricao_estadual || null }) });
  return dd.fazenda || "Fazenda";
}
const AFIRMATIVO = /^\s*(sim|s|ss|isso|ok|okay|pode|pode sim|confirmo|confirma|confirmado|manda|beleza|blz|certo|positivo|isso mesmo|pode fazer|pode lançar|pode lancar|faz|faça|faca|👍)\b/i;

function filtrar(d, f = {}) {
  return d.negocios.filter(n =>
    (!f.texto || casaTexto(d, n, f.texto)) &&
    (!f.grao || norm(n.grao) === norm(f.grao)) &&
    (!f.safra || norm(n.safra).replace(/\s/g, "") === norm(f.safra).replace(/\s/g, "")) &&
    (!f.status || n.status === f.status) &&
    (!f.corretor || norm(corretorDe(d, n)).includes(norm(f.corretor))) &&
    (!f.de || (n.data || "") >= f.de) && (!f.ate || (n.data || "") <= f.ate));
}

async function auditar(corretor, negocioId, acao, alteracoes) {
  await db("nexus_audit_log", { method: "POST", body: JSON.stringify({ tabela: "nexus_negocios", registro_id: negocioId, acao: `assistente_whatsapp:${acao}`, usuario_id: corretor.user_id, alteracoes }) }).catch(() => {});
}

function somarDias(iso, dias) { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + Number(dias))).toISOString().slice(0, 10); }
// Mesma regra do painel (dataPagamentoPorEntrega).
function dataPagamentoPorEntrega(n) {
  if (n.pagamento_dias_apos_entrega == null) return null;
  const dias = Number(n.pagamento_dias_apos_entrega);
  const base = n.embarque_finalizado_em ? new Date(n.embarque_finalizado_em).toLocaleDateString("en-CA") : (n.data_fim_embarque || null);
  if (n.pagamento_base === "total") {
    let b = base;
    if (!n.embarque_finalizado_em) {
      const cs = cargasDe(n).filter(c => c.data);
      b = cs.length && Number(n.quantidade || 0) - entregue(n) <= 0.5 ? cs.map(c => c.data).sort().pop() : (n.data_fim_embarque || null);
    }
    return b ? somarDias(b, dias) : null;
  }
  const datas = cargasDe(n).filter(c => c.data).map(c => somarDias(c.data, dias));
  if (!n.embarque_finalizado_em && Number(n.quantidade || 0) - entregue(n) > 0.5 && n.data_fim_embarque) datas.push(somarDias(n.data_fim_embarque, dias));
  if (!datas.length && n.embarque_finalizado_em) datas.push(somarDias(base, dias));
  return datas.length ? datas.sort().pop() : null;
}

async function executar(nome, input, ctx) {
  const d = await dados();
  if (GRAVA.has(nome) && !AFIRMATIVO.test(ctx.ultimaMensagem)) {
    return { erro: "Ainda não confirmado. Descreva exatamente o que vai gravar e pergunte ao corretor se pode (ele precisa responder 'sim')." };
  }
  switch (nome) {
    case "buscar_negocios": {
      const lista = filtrar(d, input);
      return { total: lista.length, contratos: lista.slice(0, input.limite || 30).map(n => resumo(d, n)) };
    }
    case "totais_negocios": {
      const grupos = {};
      for (const n of filtrar(d, input)) {
        const k = `${n.grao} ${n.safra || ""}`.trim();
        const g = grupos[k] ||= { contratos: 0, sacas: 0, valor_bruto: 0, comissao: 0 };
        g.contratos++; g.sacas += Number(n.quantidade || 0); g.valor_bruto += Number(n.quantidade || 0) * Number(n.preco || 0); g.comissao += Number(n.comissao || 0);
      }
      for (const g of Object.values(grupos)) { g.preco_medio = g.sacas ? Math.round(g.valor_bruto / g.sacas * 100) / 100 : 0; g.valor_bruto = Math.round(g.valor_bruto); g.comissao = Math.round(g.comissao * 100) / 100; }
      return grupos;
    }
    case "detalhe_negocio": {
      const n = acharNegocio(d, input.contrato);
      if (!n) return { erro: "Contrato não encontrado." };
      const anexos = await fetch(`${SUPABASE_URL}/storage/v1/object/list/nexus-anexos`, { method: "POST", headers: { ...H(), "Content-Type": "application/json" }, body: JSON.stringify({ prefix: n.id, limit: 50 }) }).then(r => r.json()).catch(() => []);
      return { ...resumo(d, n), local: n.local_origem, janela_embarque: [n.data_inicio_embarque, n.data_fim_embarque], pagamento_dias_apos_entrega: n.pagamento_dias_apos_entrega, pagamento_base: n.pagamento_base,
        comissao_pagador: n.comissao_pagador, comissao_recebida_em: n.comissao_recebida_em, funrural: n.funrural_forma, frete_saca: n.frete_saca, transportadora: nomeCad(d, n.transportadora_id) || null,
        parcelas: parcelas(n), cargas: cargasDe(n), checklist: Object.fromEntries(Object.entries(CHECK).map(([k, c]) => [k, !!n[c]])), obs: n.obs,
        anexos: Array.isArray(anexos) ? anexos.map(a => a.name.replace(/^\d+_/, "")) : [] };
    }
    case "agenda_pagamentos": {
      const out = [];
      for (const n of d.negocios) for (const p of parcelas(n)) {
        if (!p.data || p.data < input.de || p.data > input.ate || (input.so_pendentes && p.pago)) continue;
        out.push({ data: p.data, contrato: n.numero_contrato, vendedor: vendedorDe(d, n), comprador: compradorDe(d, n), grao: n.grao, parcela: p.valor ? `${p.valor} ${p.unidade}` : `${n.quantidade} sc (total)`, pago: p.pago });
      }
      return out.sort((a, b) => a.data.localeCompare(b.data));
    }
    case "embarques_pendentes": {
      return d.negocios.filter(n => !n.embarque_finalizado && n.status !== "Negociação" && (!input.texto || casaTexto(d, n, input.texto)))
        .map(n => ({ contrato: n.numero_contrato, vendedor: vendedorDe(d, n), comprador: compradorDe(d, n), grao: n.grao, modalidade: n.modalidade, janela: [n.data_inicio_embarque, n.data_fim_embarque], sacas: Number(n.quantidade || 0), entregue: Math.round(entregue(n) * 100) / 100 }))
        .sort((a, b) => String(a.janela[1] || "9").localeCompare(String(b.janela[1] || "9")));
    }
    case "buscar_cadastro": {
      const alvo = norm(input.nome).split(/\s+/).filter(Boolean);
      const lista = await db("nexus_cadastros?select=id,nome,apelido,tipo,telefone,telefones_extra,email,cpf,cnpj,inscricao_estadual,cidade,uf,endereco,endereco_numero,bairro,cep,propriedade,dados_bancarios,dados_bancarios_secundaria,categoria_comprador,obs");
      const achados = lista.filter(c => alvo.every(p => norm(`${c.nome} ${c.apelido || ""}`).includes(p))).slice(0, 5);
      if (!achados.length) return { erro: "Nenhum cadastro com esse nome." };
      const fazendas = await db(`nexus_fazendas?produtor_id=in.(${achados.map(c => c.id).join(",")})&select=produtor_id,nome,municipio_uf,inscricao_estadual,area_estimada`);
      return achados.map(({ id, ...c }) => ({ ...c, fazendas: fazendas.filter(f => f.produtor_id === id).map(({ produtor_id, ...f }) => f) }));
    }
    case "cotacoes": {
      const [cot, dolar, precos] = await Promise.all([
        db("nexus_cotacoes?select=produto,mes,codigo,ultima,pct,preco_saca_brl,premio,observacao,updated_at"),
        db("nexus_dolar?id=eq.1&select=atual,variacao,ptax,updated_at"),
        db("nexus_preco_whatsapp?select=texto,soja_disp,soja_fut,soja_fut_ref,milho_disp,milho_fut,milho_fut_ref,obs,atualizado_em&order=atualizado_em.desc&limit=1"),
      ]);
      return { cotacoes: cot, dolar: dolar[0], precos_do_dia_nexus: precos[0] || null };
    }
    case "tarefas_abertas":
      return await db("nexus_tarefas?status=neq.Conclu%C3%ADdo&select=titulo,responsavel,prazo,status,obs&order=prazo.asc.nullslast&limit=40");

    case "marcar_pagamento": {
      const n = acharNegocio(d, input.contrato);
      if (!n) return { erro: "Contrato não encontrado." };
      const pago = input.pago !== false;
      const upd = {};
      if (!input.data_parcela) {
        upd.check_pagamento = pago;
        upd.pagamentos_extra = (n.pagamentos_extra || []).map(p => { const q = { ...p }; if (pago) q.pago = true; else delete q.pago; return q; });
      } else {
        if (input.data_parcela === n.data_pagamento) upd.check_pagamento = pago;
        const extras = (n.pagamentos_extra || []).map(p => p.data === input.data_parcela ? (pago ? { ...p, pago: true } : (({ pago: _, ...r }) => r)(p)) : p);
        if (extras.some((p, i) => p !== (n.pagamentos_extra || [])[i])) upd.pagamentos_extra = extras;
        if (!Object.keys(upd).length) return { erro: "Não achei parcela nessa data.", parcelas: parcelas(n) };
      }
      await db(`nexus_negocios?id=eq.${n.id}`, { method: "PATCH", body: JSON.stringify(upd) });
      await auditar(ctx.corretor, n.id, "marcar_pagamento", upd);
      cache = null;
      return { ok: true, contrato: n.numero_contrato, gravado: upd };
    }
    case "registrar_carga": {
      const n = acharNegocio(d, input.contrato);
      if (!n) return { erro: "Contrato não encontrado." };
      const sacas = input.unidade === "kg" ? input.quantidade / 60 : input.quantidade;
      const cargas = [...cargasDe(n), { id: randomUUID(), data: input.data, sacas: Math.round(sacas * 1000) / 1000, doc: input.documento || null }];
      const upd = { cargas };
      const dp = dataPagamentoPorEntrega({ ...n, cargas });
      if (dp) upd.data_pagamento = dp;
      await db(`nexus_negocios?id=eq.${n.id}`, { method: "PATCH", body: JSON.stringify(upd) });
      await auditar(ctx.corretor, n.id, "registrar_carga", upd);
      cache = null;
      const total = entregue({ cargas });
      return { ok: true, contrato: n.numero_contrato, entregue_sacas: Math.round(total * 100) / 100, de: Number(n.quantidade || 0), nova_data_pagamento: dp || null };
    }
    case "marcar_checklist": {
      const n = acharNegocio(d, input.contrato);
      if (!n) return { erro: "Contrato não encontrado." };
      const upd = { [CHECK[input.item]]: !!input.feito };
      if (input.item === "embarque_entrega" && input.feito && !n.embarque_finalizado) Object.assign(upd, { embarque_finalizado: true, embarque_finalizado_em: new Date().toISOString() });
      await db(`nexus_negocios?id=eq.${n.id}`, { method: "PATCH", body: JSON.stringify(upd) });
      await auditar(ctx.corretor, n.id, "marcar_checklist", upd);
      cache = null;
      return { ok: true, contrato: n.numero_contrato, gravado: upd };
    }
    case "criar_tarefa": {
      const t = await db("nexus_tarefas", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ titulo: input.titulo, prazo: input.prazo || null, responsavel: input.responsavel || ctx.corretor.nome, obs: input.obs || null, status: "A fazer", created_by: ctx.corretor.user_id }) });
      return { ok: true, tarefa: t?.[0]?.titulo };
    }
    case "criar_cadastro_produtor": {
      const dd = input.dados || {};
      if (!dd.nome) return { erro: "Falta o nome do produtor." };
      const existente = await acharCadastro(dd.nome, dd);
      if (existente) return { erro: `Já existe cadastro: ${existente.nome} (${existente.tipo}). Use completar_cadastro para preencher o que falta.` };
      const col = colunasCadastro(dd);
      const obs = [dd.rg && `RG: ${dd.rg}`, `Cadastrado pelo WhatsApp (assistente) a pedido de ${ctx.corretor.nome}.`].filter(Boolean).join("\n");
      const novo = (await db("nexus_cadastros", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...col, tipo: "Produtor", owner_id: ctx.corretor.user_id, created_by: ctx.corretor.user_id, obs }) }))[0];
      const fazenda = await garantirFazenda(novo.id, dd);
      await db("nexus_audit_log", { method: "POST", body: JSON.stringify({ tabela: "nexus_cadastros", registro_id: novo.id, acao: "assistente_whatsapp:criar_cadastro", usuario_id: ctx.corretor.user_id, alteracoes: col }) }).catch(() => {});
      return { ok: true, criado: novo.nome, campos: Object.keys(col), fazenda_criada: fazenda };
    }
    case "completar_cadastro": {
      const dd = input.dados || {};
      const c = await acharCadastro(input.quem, dd);
      if (!c) return { erro: "Não achei esse cadastro. Para um produtor novo, use criar_cadastro_produtor." };
      const atual = (await db(`nexus_cadastros?id=eq.${c.id}&select=*`))[0];
      const col = colunasCadastro(dd);
      delete col.nome;
      const upd = Object.fromEntries(Object.entries(col).filter(([k]) => input.sobrescrever || atual[k] == null || atual[k] === ""));
      if (dd.rg && !String(atual.obs || "").includes(dd.rg)) upd.obs = [atual.obs, `RG: ${dd.rg}`].filter(Boolean).join("\n");
      if (Object.keys(upd).length) await db(`nexus_cadastros?id=eq.${c.id}`, { method: "PATCH", body: JSON.stringify(upd) });
      const fazenda = await garantirFazenda(c.id, dd);
      await db("nexus_audit_log", { method: "POST", body: JSON.stringify({ tabela: "nexus_cadastros", registro_id: c.id, acao: "assistente_whatsapp:completar_cadastro", usuario_id: ctx.corretor.user_id, alteracoes: upd }) }).catch(() => {});
      return { ok: true, cadastro: c.nome, preenchidos: Object.keys(upd), ja_tinham_valor: Object.keys(col).filter(k => !(k in upd)), fazenda_criada: fazenda };
    }
    case "salvar_documento_pendente": {
      const doc = (await db(`nexus_assistente_docs?id=eq.${encodeURIComponent(input.documento_id)}&telefone=eq.${ctx.telefone}&select=*`))[0];
      if (!doc) return { erro: "Documento pendente não encontrado." };
      if (doc.salvo_em) return { erro: "Esse documento já foi salvo." };
      const n = acharNegocio(d, input.contrato);
      if (!n) return { erro: "Contrato não encontrado." };
      const arq = await fetch(`${SUPABASE_URL}/storage/v1/object/nexus-anexos/${doc.storage_path}`, { headers: H() });
      if (!arq.ok) return { erro: "Não achei mais o arquivo guardado." };
      const base64 = Buffer.from(await arq.arrayBuffer()).toString("base64");
      const neg = { ...n, vendedor: vendedorDe(d, n), comprador: compradorDe(d, n) };
      const ext = { "application/pdf": "pdf", "image/png": "png", "image/webp": "webp" }[doc.mime] || "jpg";
      const salvo = await salvarNoDrive({ base64, mime: doc.mime, nome_arquivo: `${nomeArquivoDoc(doc.leitura || {}, neg)}.${ext}`, contrato: n.numero_contrato, nome_pasta: nomePastaContrato(neg), data_negocio: n.data });
      if (!salvo.ok) return { erro: "Drive: " + salvo.erro };
      // move a cópia de "pendentes" pros anexos da negociação
      const nomeStorage = salvo.nome.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.\- ()]/g, "_");
      await fetch(`${SUPABASE_URL}/storage/v1/object/move`, { method: "POST", headers: { ...H(), "Content-Type": "application/json" }, body: JSON.stringify({ bucketId: "nexus-anexos", sourceKey: doc.storage_path, destinationKey: `${n.id}/${Date.now()}_${nomeStorage}` }) }).catch(() => {});
      await db(`nexus_assistente_docs?id=eq.${doc.id}`, { method: "PATCH", body: JSON.stringify({ salvo_em: new Date().toISOString() }) });
      const atualizado = await aplicarDocumentoNoNegocio({ negocioId: n.id, leitura: doc.leitura, nomeArquivo: salvo.nome, origem: "whatsapp", usuarioId: ctx.corretor.user_id }).catch(e => [`não consegui atualizar o checklist (${e.message})`]);
      cache = null;
      return { ok: true, tipo: TIPO_LABEL[doc.leitura?.tipo] || "Documento", contrato: n.numero_contrato, nome: salvo.nome, link: salvo.url, checklist_atualizado: atualizado };
    }
  }
  return { erro: "Ferramenta desconhecida." };
}

const SISTEMA = `Você é a assistente da Nexus Commodities, corretora de grãos (soja, milho, sorgo) em São Gabriel do Oeste/MS, e conversa pelo WhatsApp com os corretores da equipe, como uma funcionária do escritório: prestativa, direta e cuidadosa.

Como trabalhar:
- Responda em português, curto e no estilo WhatsApp: frases simples, *negrito* com um asterisco de cada lado, listas com "•". Nada de tabelas nem markdown com # ou **.
- Use as ferramentas para buscar os dados. Nunca invente números, nomes, datas ou contratos; se não achar, diga que não achou.
- Contrato pode vir como "141", "CT 141" ou "CT-2026-141" — tudo é o mesmo.
- No negócio, o vendedor é o produtor rural e o comprador é a cerealista/cooperativa/trading. Sacas de 60 kg. Valores em R$ no formato brasileiro (R$ 1.234,56).
- Preço médio é sempre por grão e safra; nunca misture safras ou grãos numa média.
- Ferramentas que GRAVAM (marcar_pagamento, registrar_carga, marcar_checklist, criar_tarefa): antes de chamar, diga exatamente o que vai gravar (contrato, partes, valores, datas) e pergunte "Confirma?". Só chame depois que o corretor responder "sim". Depois, diga o que foi gravado.
- Documentos: quando o histórico mostrar um documento pendente (com o id) e o corretor disser de qual contrato é (ou "sim" para o palpite), chame salvar_documento_pendente direto e mande o link.
- Cadastro de produtor: o histórico mostra os dados lidos de cada documento de cadastro (CNH, IE, comprovante de endereço, dados bancários). Quando o corretor pedir para criar o cadastro, junte os dados de todos os documentos daquele produtor, mostre um resumo (nome, CPF/CNPJ, nascimento, IE, fazenda e município, endereço, banco/PIX, telefone se ele informou) e pergunte "Confirma?". Com o "sim", chame criar_cadastro_produtor; se já existir, ofereça completar_cadastro. Pergunte o telefone/WhatsApp do produtor se ninguém informou.
- Para criar uma negociação nova, oriente o corretor a mandar a mensagem começando com "Nova negociação" no formato que ele já usa, ou criar pelo painel.
- Se pedirem algo que você não consegue fazer, diga com franqueza e sugira o caminho no painel (painel.nexuscommoditiesms.com.br).`;

async function chamarClaude(messages) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODELO, max_tokens: 4096,
      thinking: { type: "between_tools" }, output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      system: SISTEMA, tools: FERRAMENTAS, messages,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("IA: " + (j.error?.message || r.status));
  await registrarUsoIA("assistente-whatsapp", MODELO, j.usage);
  return j;
}

export default async (req) => {
  const p = await req.json().catch(() => null);
  if (!p || p.secret !== process.env.WHATSAPP_WEBHOOK_SECRET || !p.phone || !(p.texto || p.audioUrl)) return;
  const telefone = p.phone;
  try {
    let ouvido = "";
    if (!p.texto && p.audioUrl) {
      try { p.texto = ouvido = await transcrever(p.audioUrl, p.audioMime, p.audioSegundos); }
      catch (e) { await responder(telefone, `🎤 Desculpa, ${e.message}`); return; }
      if (!ouvido) { await responder(telefone, "🎤 Não consegui entender o áudio. Pode repetir ou mandar por escrito?"); return; }
    }
    const d = await dados();
    const digitos = s => { let x = String(s || "").replace(/\D/g, ""); if (x.length >= 12 && x.startsWith("55")) x = x.slice(2); if (x.length === 11) x = x.slice(0, 2) + x.slice(3); return x.slice(-10); };
    const corretor = d.equipe.find(e => [e.telefone, ...(e.telefones_extra || [])].some(t => t && digitos(t) === digitos(telefone)));
    if (!corretor) return;

    const desde = new Date(Date.now() - HISTORICO_HORAS * 3600e3).toISOString();
    const hist = (await db(`nexus_assistente_msgs?telefone=eq.${telefone}&created_at=gte.${desde}&select=role,texto&order=created_at.desc&limit=${HISTORICO_MAX}`)).reverse();
    while (hist.length && hist[0].role !== "user") hist.shift(); // a conversa tem que começar pelo corretor
    const messages = [];
    for (const m of hist) {
      const ultima = messages[messages.length - 1];
      if (ultima && ultima.role === m.role) ultima.content += "\n\n" + m.texto; else messages.push({ role: m.role, content: m.texto });
    }
    const entrada = `[${hoje()} · ${corretor.nome}${ouvido ? " · por áudio" : ""}] ${p.texto}`;
    if (messages.length && messages[messages.length - 1].role === "user") messages[messages.length - 1].content += "\n\n" + entrada; else messages.push({ role: "user", content: entrada });
    await db("nexus_assistente_msgs", { method: "POST", body: JSON.stringify({ telefone, role: "user", texto: entrada }) });

    const ctx = { corretor, telefone, ultimaMensagem: p.texto };
    let resposta = "";
    for (let volta = 0; volta < MAX_VOLTAS; volta++) {
      const j = await chamarClaude(messages);
      if (j.stop_reason === "refusal") { resposta = "Desculpa, não consigo ajudar com isso por aqui. Tenta pelo painel ou fala com o Álisson."; break; }
      messages.push({ role: "assistant", content: j.content });
      const usos = j.content.filter(b => b.type === "tool_use");
      if (!usos.length) { resposta = j.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim(); break; }
      const resultados = [];
      for (const u of usos) {
        let out;
        try { out = await executar(u.name, u.input || {}, ctx); } catch (e) { out = { erro: e.message }; }
        console.log("FERRAMENTA", u.name, JSON.stringify(u.input), "→", JSON.stringify(out).slice(0, 500));
        resultados.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out), ...(out?.erro ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: resultados });
    }
    if (!resposta) resposta = "Não consegui terminar essa. Pode reformular ou pedir em partes?";
    await db("nexus_assistente_msgs", { method: "POST", body: JSON.stringify({ telefone, role: "assistant", texto: resposta }) });
    await responder(telefone, ouvido ? `🎤 _Entendi: "${ouvido.length > 300 ? ouvido.slice(0, 300) + "…" : ouvido}"_\n\n${resposta}` : resposta);
  } catch (e) {
    console.log("ERRO assistente:", e.message);
    await responder(telefone, `Deu um erro aqui do meu lado (${e.message}). Tenta de novo em instantes ou usa o painel.`);
  }
};
