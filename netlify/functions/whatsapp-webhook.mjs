const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Chave de comparação de telefone BR: DDD + 8 dígitos locais, sem código do país e sem
// o "9" extra do celular — a Z-API/WhatsApp às vezes manda o número sem esse "9" (formato
// antigo), então comparar só "os últimos 11 dígitos" desalinha tudo e nunca bate. Normalizando
// os dois lados pro mesmo formato (DDD+8) resolve nos dois sentidos.
function ultimosDigitos(tel) {
  let d = String(tel || "").replace(/\D/g, "");
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length === 11) d = d.slice(0, 2) + d.slice(3);
  return d.slice(-10);
}

function normalizarTexto(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

function parseNumeroBR(str) {
  if (!str) return 0;
  let s = String(str).trim().replace(/[^\d.,]/g, "");
  if (s.includes(",")) {
    // vírgula presente: ponto é separador de milhar, vírgula é decimal (ex: 1.234,56)
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    // só pontos, no padrão de milhar (ex: 3.000, 1.234.567): não é decimal
    s = s.replace(/\./g, "");
  }
  return Number(s) || 0;
}

function normalizarChave(s) {
  return normalizarTexto(s).replace(/\s+/g, "");
}

const CAMPO_ALIASES = {
  produtor: "produtor", vendedor: "produtor",
  comprador: "comprador", cliente: "comprador",
  grao: "grao", produto: "grao",
  safra: "safra",
  quantidade: "quantidade", qtd: "quantidade", sacas: "quantidade",
  preco: "preco", precobruto: "preco",
  precoliquido: "precoLiquido", precoliq: "precoLiquido",
  modalidade: "modalidade",
  armazem: "localOrigem", local: "localOrigem", localorigem: "localOrigem", localretirada: "localOrigem", localentrega: "localOrigem",
  comissao: "comissaoSaca", comissaosaca: "comissaoSaca",
  funrural: "funruralForma", funfural: "funruralForma",
  datapgto: "dataPagamento", datapagamento: "dataPagamento",
};
function parseNumeroLinhaSemDoisPontos(linha) {
  const palavras = linha.split(/\s+/).filter(Boolean);
  for (let n = Math.min(3, palavras.length - 1); n >= 1; n--) {
    const candidato = normalizarChave(palavras.slice(0, n).join(""));
    if (CAMPO_ALIASES[candidato]) {
      return { chave: CAMPO_ALIASES[candidato], valor: palavras.slice(n).join(" ").trim() };
    }
  }
  return null;
}

function parseMensagem(texto) {
  const linhas = texto.split("\n").map(l => l.trim()).filter(Boolean);
  const campos = {};
  for (const linha of linhas.slice(1)) {
    const idx = linha.indexOf(":");
    if (idx !== -1) {
      const chave = CAMPO_ALIASES[normalizarChave(linha.slice(0, idx))];
      const valor = linha.slice(idx + 1).trim();
      if (chave && valor) campos[chave] = valor;
      continue;
    }
    const semDoisPontos = parseNumeroLinhaSemDoisPontos(linha);
    if (semDoisPontos && semDoisPontos.valor) campos[semDoisPontos.chave] = semDoisPontos.valor;
  }
  return campos;
}

function parseDataBR(str) {
  const m = String(str || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = "20" + y;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function acharCadastro(cadastros, tipo, nomeDigitado) {
  if (!nomeDigitado) return null;
  const alvo = normalizarTexto(nomeDigitado);
  const alvoPalavras = alvo.split(/\s+/).filter(Boolean);
  const candidatos = cadastros.filter(c => c.tipo === tipo);
  return candidatos.find(c => normalizarTexto(c.nome) === alvo)
    // todas as palavras digitadas aparecem no nome cadastrado (ex: "Antonio Martins" bate com "Antônio R. Martins")
    || candidatos.find(c => {
      const nomePalavras = normalizarTexto(c.nome).split(/\s+/).filter(Boolean);
      return alvoPalavras.every(p => nomePalavras.includes(p));
    })
    || candidatos.find(c => normalizarTexto(c.nome).includes(alvo) || alvo.includes(normalizarTexto(c.nome)))
    || null;
}

async function enviarWhatsapp({ instanceId, token, clientToken, telefone, mensagem }) {
  await fetch(`https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Token": clientToken },
    body: JSON.stringify({ phone: telefone, message: mensagem }),
  }).catch(() => {});
}

function fmtNum(v) { return Number(v || 0).toLocaleString("pt-BR"); }
function fmtMoney(v) { return "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(iso) { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }

// Mesma conta de preço líquido usada no resto do app.
function aplicaFundersulFundems(comprador) {
  return !comprador || (comprador.categoria_comprador !== "Cooperativa" && comprador.categoria_comprador !== "Cerealista");
}
function precoLiquidoNegocio(n, comprador, config) {
  const sacas = Number(n.quantidade || 0);
  const total = Number(n.preco || 0) * sacas;
  const senar = total * 0.002;
  const comFundersulFundems = aplicaFundersulFundems(comprador);
  const fundersulTotal = comFundersulFundems ? Number(config.fundersul_saca || 0) * sacas : 0;
  const fundemsTotal = comFundersulFundems ? Number(config.fundems_saca || 0) * sacas : 0;
  const funruralForma = n.funrural_forma || "Comercialização";
  const funrural = funruralForma === "Comercialização" ? total * Number(config.funrural_pct || 0) / 100 : 0;
  const comissaoDoVendedor = n.comissao_pagador === "Comprador" ? 0 : Number(n.comissao || 0);
  const liquidoEstimado = total - comissaoDoVendedor - senar - fundersulTotal - fundemsTotal - funrural;
  const informado = n.preco_liquido != null && n.preco_liquido !== "";
  return informado ? Number(n.preco_liquido) : (sacas ? liquidoEstimado / sacas : 0);
}

// "/extrato": qualquer produtor com esse telefone (principal ou extra) cadastrado recebe
// de volta a lista dos negócios dele. Não passa pelo filtro de corretor — é o próprio
// produtor consultando os dados dele mesmo, sem acesso a nada de outra pessoa.
async function acharMeusProdutores(payload, adminHeaders) {
  const remetente = ultimosDigitos(payload.phone);
  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?tipo=eq.Produtor&select=id,nome,telefone,telefones_extra`, { headers: adminHeaders });
  const produtores = await cadResp.json();
  return produtores.filter(p => [p.telefone, ...(p.telefones_extra || [])].some(t => t && ultimosDigitos(t) === remetente));
}

const MENSAGEM_NAO_ENCONTRADO = "Não encontrei nenhum cadastro de produtor com esse número de telefone. Fale com seu corretor pra verificar.";

const MENSAGEM_AJUDA = `🤖 *Comandos disponíveis*\n\n` +
  `/extrato — lista suas negociações com a Nexus\n` +
  `/confirmacao [nº do contrato] — link da Confirmação de Negócio completa, pronta pra salvar como PDF\n` +
  `/pagamento — seus próximos pagamentos em aberto\n` +
  `/embarque — suas janelas de embarque/entrega pendentes\n` +
  `/ajuda — mostra esta lista`;

async function responderConfirmacao(payload, adminHeaders, zapi, argumento) {
  const meusProdutores = await acharMeusProdutores(payload, adminHeaders);
  if (meusProdutores.length === 0) {
    await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: MENSAGEM_NAO_ENCONTRADO });
    return;
  }
  const idsProdutores = meusProdutores.map(p => p.id);
  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?produtor_id=in.(${idsProdutores.join(",")})&deleted_at=is.null&cliente_id=not.is.null&select=id,numero_contrato,data&order=data.desc`, { headers: adminHeaders });
  const negocios = await negResp.json();
  if (!Array.isArray(negocios) || negocios.length === 0) {
    await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: "Ainda não encontrei nenhuma negociação com comprador definido no seu nome pra gerar a Confirmação." });
    return;
  }
  let alvo;
  if (argumento) {
    const alvoNorm = normalizarTexto(argumento);
    alvo = negocios.find(n => normalizarTexto(n.numero_contrato || "") === alvoNorm) || negocios.find(n => normalizarTexto(n.numero_contrato || "").includes(alvoNorm));
    if (!alvo) {
      await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: `Não encontrei o contrato "${argumento}" no seu nome. Digite /extrato pra ver a lista dos seus contratos.` });
      return;
    }
  } else {
    alvo = negocios[0];
  }
  const link = `https://painel.nexuscommoditiesms.com.br/.netlify/functions/confirmacao-publica?id=${alvo.id}`;
  const aviso = argumento ? "" : ` (a mais recente — pra outro contrato, digite /confirmacao seguido do número)`;
  await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: `📄 Confirmação de Negócio ${alvo.numero_contrato || ""}${aviso}\n\nAbra o link pelo celular e use "Salvar/Imprimir como PDF":\n${link}` });
}

async function responderPagamento(payload, adminHeaders, zapi) {
  const meusProdutores = await acharMeusProdutores(payload, adminHeaders);
  if (meusProdutores.length === 0) {
    await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: MENSAGEM_NAO_ENCONTRADO });
    return;
  }
  const idsProdutores = meusProdutores.map(p => p.id);
  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?produtor_id=in.(${idsProdutores.join(",")})&deleted_at=is.null&check_pagamento=is.false&data_pagamento=not.is.null&select=numero_contrato,grao,data_pagamento&order=data_pagamento.asc`, { headers: adminHeaders });
  const negocios = await negResp.json();
  if (!Array.isArray(negocios) || negocios.length === 0) {
    await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: "Você não tem nenhum pagamento em aberto com data definida no momento." });
    return;
  }
  const linhas = negocios.slice(0, 15).map(n => `• ${n.numero_contrato || "—"} — ${n.grao || ""} — ${fmtDate(n.data_pagamento)}`).join("\n");
  await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: `💰 Pagamentos em aberto\n\n${linhas}` });
}

async function responderEmbarque(payload, adminHeaders, zapi) {
  const meusProdutores = await acharMeusProdutores(payload, adminHeaders);
  if (meusProdutores.length === 0) {
    await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: MENSAGEM_NAO_ENCONTRADO });
    return;
  }
  const idsProdutores = meusProdutores.map(p => p.id);
  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?produtor_id=in.(${idsProdutores.join(",")})&deleted_at=is.null&status=neq.Pago&status=neq.Entregue&data_fim_embarque=not.is.null&select=numero_contrato,grao,modalidade,data_inicio_embarque,data_fim_embarque&order=data_fim_embarque.asc`, { headers: adminHeaders });
  const negocios = await negResp.json();
  if (!Array.isArray(negocios) || negocios.length === 0) {
    await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: "Você não tem nenhuma janela de embarque/entrega pendente no momento." });
    return;
  }
  const linhas = negocios.slice(0, 15).map(n => {
    const rotulo = (n.modalidade || "FOB") === "CIF" ? "Entrega" : "Embarque";
    return `• ${n.numero_contrato || "—"} — ${n.grao || ""} — ${rotulo}: ${fmtDate(n.data_inicio_embarque)} a ${fmtDate(n.data_fim_embarque)}`;
  }).join("\n");
  await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: `🚚 Embarques/entregas pendentes\n\n${linhas}` });
}

async function responderExtrato(payload, adminHeaders, zapi) {
  const meusProdutores = await acharMeusProdutores(payload, adminHeaders);
  if (meusProdutores.length === 0) {
    await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: "Não encontrei nenhum cadastro de produtor com esse número de telefone. Fale com seu corretor pra verificar." });
    return;
  }

  const idsProdutores = meusProdutores.map(p => p.id);
  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?produtor_id=in.(${idsProdutores.join(",")})&deleted_at=is.null&select=*&order=data.desc`, { headers: adminHeaders });
  const negocios = await negResp.json();

  if (!Array.isArray(negocios) || negocios.length === 0) {
    await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: `Olá, ${meusProdutores[0].nome}! Ainda não encontrei nenhuma negociação registrada em seu nome.` });
    return;
  }

  const idsCompradores = [...new Set(negocios.map(n => n.cliente_id).filter(Boolean))];
  let compradores = [];
  if (idsCompradores.length) {
    const compResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${idsCompradores.join(",")})&select=id,nome,categoria_comprador`, { headers: adminHeaders });
    compradores = await compResp.json();
  }
  const cfgResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_config?id=eq.1&select=fundersul_saca,fundems_saca,funrural_pct`, { headers: adminHeaders });
  const cfgRows = await cfgResp.json().catch(() => []);
  const config = cfgRows[0] || {};

  const MAX_ITENS = 15;
  const listados = negocios.slice(0, MAX_ITENS);
  const nomesProdutores = meusProdutores.map(p => p.nome).join(", ");

  const linhas = listados.map(n => {
    const comprador = compradores.find(c => c.id === n.cliente_id);
    const precoLiquido = precoLiquidoNegocio(n, comprador, config);
    const nomeComprador = comprador ? comprador.nome : (n.contraparte || "—");
    return `• ${n.numero_contrato || "—"} — ${n.grao || ""}${n.safra ? " " + n.safra : ""} — ${fmtNum(n.quantidade)} sc — ${n.status || "—"}\n   ${nomeComprador} · Líquido: ${fmtMoney(precoLiquido)}/sc`;
  }).join("\n\n");

  const totalSacas = negocios.reduce((s, n) => s + Number(n.quantidade || 0), 0);
  const rodape = negocios.length > MAX_ITENS ? `\n\n(mostrando os ${MAX_ITENS} mais recentes de ${negocios.length} negócios)` : "";

  const mensagem = `📋 Extrato — ${nomesProdutores}\n\n${linhas}\n\n— — —\nTotal: ${negocios.length} negócio${negocios.length === 1 ? "" : "s"} · ${fmtNum(totalSacas)} sc${rodape}`;
  await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem });
}

// Recebe o webhook "ao receber mensagem" da Z-API. Dois comandos:
// - "/extrato": qualquer produtor com telefone cadastrado recebe de volta a lista dos
//   próprios negócios (sem depender de ser corretor).
// - "NOVA NEGOCIAÇÃO" (na primeira linha), vindo de um corretor conhecido (telefone
//   cadastrado em nexus_equipe): cria um rascunho de negócio a partir dos campos
//   "Chave: valor" das linhas seguintes.
// Protegido por um secret na querystring — sem ele, ignora a chamada.
export default async (req) => {
  const url = new URL(req.url);
  const { WHATSAPP_WEBHOOK_SECRET, ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  if (!WHATSAPP_WEBHOOK_SECRET || url.searchParams.get("secret") !== WHATSAPP_WEBHOOK_SECRET) {
    return json({ ok: false }, 401);
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }, 500);

  let payload;
  try { payload = await req.json(); } catch (e) { console.log("DEBUG payload inválido:", String(e)); return json({ ok: true }); }
  console.log("DEBUG payload recebido:", JSON.stringify(payload));

  if (payload.fromMe || payload.isGroup || !payload.text?.message || !payload.phone) {
    console.log("DEBUG ignorado por: fromMe/isGroup/sem texto/sem phone", { fromMe: payload.fromMe, isGroup: payload.isGroup, temTexto: !!payload.text?.message, temPhone: !!payload.phone });
    return json({ ok: true, ignorado: true });
  }

  const texto = payload.text.message;
  const adminHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const zapi = { instanceId: ZAPI_INSTANCE_ID, token: ZAPI_TOKEN, clientToken: ZAPI_CLIENT_TOKEN };

  const primeiraLinhaOriginal = (texto.split("\n")[0] || "").trim();
  const palavras = primeiraLinhaOriginal.split(/\s+/).filter(Boolean);
  const comando = normalizarTexto(palavras[0] || "");
  const argumento = palavras.slice(1).join(" ").trim();

  if (comando === "/extrato") { await responderExtrato(payload, adminHeaders, zapi); return json({ ok: true }); }
  if (comando === "/confirmacao") { await responderConfirmacao(payload, adminHeaders, zapi, argumento); return json({ ok: true }); }
  if (comando === "/pagamento" || comando === "/pagamentos") { await responderPagamento(payload, adminHeaders, zapi); return json({ ok: true }); }
  if (comando === "/embarque" || comando === "/embarques") { await responderEmbarque(payload, adminHeaders, zapi); return json({ ok: true }); }
  if (comando === "/ajuda" || comando === "/menu" || comando === "/help") {
    await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: MENSAGEM_AJUDA });
    return json({ ok: true });
  }

  const primeiraLinha = normalizarTexto(primeiraLinhaOriginal);
  if (!primeiraLinha.startsWith("nova negociacao")) {
    console.log("DEBUG primeira linha não bateu com o gatilho:", JSON.stringify(primeiraLinha));
    return json({ ok: true, ignorado: true });
  }

  const equipeResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?select=user_id,nome,telefone`, { headers: adminHeaders });
  const equipe = await equipeResp.json();
  const remetente = ultimosDigitos(payload.phone);
  console.log("DEBUG remetente:", remetente, "equipe:", JSON.stringify(equipe.map(e => ({ nome: e.nome, telefone: e.telefone, ultimosDigitos: ultimosDigitos(e.telefone) }))));
  const corretor = equipe.find(e => e.telefone && ultimosDigitos(e.telefone) === remetente);
  if (!corretor) {
    console.log("DEBUG número não bateu com nenhum corretor cadastrado");
    return json({ ok: true, ignorado: true });
  }

  const campos = parseMensagem(texto);

  const cfgResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_config?id=eq.1&select=comissao_pct_corretora,comissao_pct_corretor`, { headers: adminHeaders });
  const cfgRows = await cfgResp.json().catch(() => []);
  const pctCorretora = Number(cfgRows[0]?.comissao_pct_corretora ?? 70);
  const pctCorretor = Number(cfgRows[0]?.comissao_pct_corretor ?? 30);

  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?select=id,nome,tipo`, { headers: adminHeaders });
  const cadastros = await cadResp.json();
  const produtor = acharCadastro(cadastros, "Produtor", campos.produtor);
  const comprador = acharCadastro(cadastros, "Comprador", campos.comprador);

  const ano = new Date().getFullYear();
  const prefixo = `CT-${ano}-`;
  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?numero_contrato=like.${encodeURIComponent(prefixo + "*")}&select=numero_contrato`, { headers: adminHeaders });
  const negRows = await negResp.json();
  const max = (Array.isArray(negRows) ? negRows : []).reduce((m, r) => {
    const seq = parseInt((r.numero_contrato || "").slice(prefixo.length), 10);
    return isNaN(seq) ? m : Math.max(m, seq);
  }, 0);
  const numeroContrato = `${prefixo}${String(max + 1).padStart(3, "0")}`;

  const modalidade = normalizarTexto(campos.modalidade).startsWith("cif") ? "CIF" : "FOB";
  const grao = campos.grao ? campos.grao.trim().charAt(0).toUpperCase() + campos.grao.trim().slice(1).toLowerCase() : "—";
  const funruralForma = normalizarTexto(campos.funruralForma).includes("folha") ? "Folha de Pagamento" : "Comercialização";
  const quantidade = parseNumeroBR(campos.quantidade);
  const comissaoSaca = campos.comissaoSaca ? parseNumeroBR(campos.comissaoSaca) : null;
  const comissaoTotal = comissaoSaca != null ? quantidade * comissaoSaca : null;
  const dataPagamento = parseDataBR(campos.dataPagamento);

  const negocioPayload = {
    numero_contrato: numeroContrato,
    grao,
    safra: campos.safra || "",
    quantidade,
    preco: parseNumeroBR(campos.preco),
    preco_liquido: campos.precoLiquido ? parseNumeroBR(campos.precoLiquido) : null,
    modalidade,
    local_origem: campos.localOrigem || "",
    produtor_id: produtor?.id || null,
    cliente_id: comprador?.id || null,
    contraparte: comprador ? comprador.nome : (campos.comprador || "—"),
    corretor_id: corretor.user_id,
    status: "Rascunho",
    data: new Date().toISOString().slice(0, 10),
    data_pagamento: dataPagamento,
    comissao_saca: comissaoSaca,
    comissao: comissaoTotal ?? 0,
    comissao_corretora: comissaoTotal != null ? comissaoTotal * pctCorretora / 100 : null,
    comissao_corretor: comissaoTotal != null ? comissaoTotal * pctCorretor / 100 : null,
    comissao_pagador: "Vendedor",
    funrural_forma: funruralForma,
    obs: `[Criado via WhatsApp por ${corretor.nome}]\n${texto}`,
  };

  const insResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(negocioPayload),
  });
  const insRows = await insResp.json().catch(() => []);
  const ok = insResp.ok && insRows[0];

  const linhaProdutor = produtor ? produtor.nome : `"${campos.produtor || "—"}" (não achei — selecione no painel)`;
  const linhaComprador = comprador ? comprador.nome : `"${campos.comprador || "—"}" (não achei — selecione no painel)`;
  const resposta = ok
    ? `✅ Rascunho ${numeroContrato} criado!\nProdutor: ${linhaProdutor}\nComprador: ${linhaComprador}\n${grao}${campos.safra ? " " + campos.safra : ""} — ${campos.quantidade || "?"} sc a ${campos.preco || "?"}${campos.precoLiquido ? " (líq. " + campos.precoLiquido + ")" : ""} (${modalidade})${campos.localOrigem ? "\nArmazém: " + campos.localOrigem : ""}${comissaoSaca != null ? "\nComissão: " + campos.comissaoSaca + "/sc" : ""}${dataPagamento ? "\nPagamento: " + campos.dataPagamento : ""}\nComplete e confirme no painel.`
    : "⚠️ Não consegui criar o rascunho da negociação agora. Tenta de novo ou avisa o Alisson.";
  await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: resposta });

  return json({ ok: !!ok, numeroContrato: ok ? numeroContrato : null });
};
