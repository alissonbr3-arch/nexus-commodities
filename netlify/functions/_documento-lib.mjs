// Parte comum dos "Documentos pela IA": leitura do arquivo pelo Claude, nome no padrão da pasta
// e gravação no Google Drive (via Apps Script da conta da Nexus). Usada pelo painel
// (documento-ia.mjs) e pelo WhatsApp da Nexus (documento-whatsapp-background.mjs).

import { randomUUID } from "node:crypto";

export const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const MODELO = "claude-haiku-5-5";

// Preço por milhão de tokens em US$ (entrada, saída, leitura de cache). Gravação de cache = 1,25 × entrada.
const PRECOS = { "claude-haiku-5-5": [0.10, 0.50, 0.01], "claude-sonnet-5-5": [2, 10, 0.10] };
// Anota cada chamada à IA em nexus_ia_uso (base do resumo mensal de gasto que vai pro WhatsApp).
export async function registrarUsoIA(origem, modelo, u) {
  if (!u) return;
  const [pin, pout, pcache] = PRECOS[modelo] || [0, 0, 0];
  const linha = {
    origem, modelo, input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
    cache_read_tokens: u.cache_read_input_tokens || 0, cache_write_tokens: u.cache_creation_input_tokens || 0,
  };
  linha.custo_usd = (linha.input_tokens * pin + linha.output_tokens * pout + linha.cache_read_tokens * pcache + linha.cache_write_tokens * pin * 1.25) / 1e6;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await fetch(`${SUPABASE_URL}/rest/v1/nexus_ia_uso`, {
    method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(linha),
  }).catch(() => {});
}

// Custo que não é por token (ex.: transcrição de áudio, cobrada por minuto).
export async function registrarCustoUsd(origem, modelo, custo_usd) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await fetch(`${SUPABASE_URL}/rest/v1/nexus_ia_uso`, {
    method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ origem, modelo, custo_usd }),
  }).catch(() => {});
}

export const TIPOS = ["confirmacao", "contrato", "pagamento", "nota_produtor", "contra_nota", "nota_fiscal", "romaneio", "liberacao_embarque", "outro"];
export const TIPO_LABEL = { confirmacao: "Confirmação (Nexus)", contrato: "Contrato do comprador", pagamento: "Comprovante de pagamento", nota_produtor: "NFP (nota do produtor)", contra_nota: "Contra nota", nota_fiscal: "Nota fiscal", romaneio: "Romaneio / ticket", liberacao_embarque: "Liberação de embarque", outro: "Outro documento" };

const FERRAMENTA = {
  name: "classificar_documento",
  description: "Registra o que é o documento e a que contrato da Nexus ele pertence.",
  input_schema: {
    type: "object",
    properties: {
      tipo: { type: "string", enum: TIPOS, description: "confirmacao = Confirmação de Compra e Venda emitida pela Nexus (cabeçalho Nexus, número CT-2026-xxx); contrato = contrato de compra e venda emitido pelo comprador (cerealista, cooperativa, trading), com número próprio do comprador; pagamento = comprovante de pagamento, PIX, TED, transferência; nota_produtor = NFP / nota fiscal de produtor rural emitida pelo vendedor; contra_nota = contra nota / NF de entrada emitida pelo comprador referenciando a NFP; nota_fiscal = outra NF-e; romaneio = ticket de balança / romaneio de carga com peso; liberacao_embarque = liberação/autorização de embarque ou de retirada; outro = qualquer outra coisa." },
      assinado: { type: "boolean", description: "true se o documento tem assinatura (manuscrita, digital ou DocuSign) das partes." },
      contrato_numero: { type: ["string", "null"], description: "Número do contrato da lista (ex.: CT-2026-108) a que o documento pertence, ou null se não der pra saber." },
      confianca: { type: "string", enum: ["alta", "media", "baixa"], description: "Confiança na escolha do contrato." },
      motivo: { type: "string", description: "Uma frase curta em português explicando como chegou no contrato (ex.: 'pagador Total Grãos, favorecido Cesar Tozetto, milho, valor bate com o saldo')." },
      numero_documento: { type: ["string", "null"], description: "Número da nota (NFP, contra nota ou NF), sem pontos; no contrato do comprador, o número do contrato dele como está escrito (ex.: 0056-27). null se não houver." },
      nfp_referenciada: { type: ["string", "null"], description: "Na contra nota: número da NFP referenciada." },
      valor: { type: ["number", "null"], description: "Valor em reais (pagamento: valor pago; nota: valor total)." },
      data: { type: ["string", "null"], description: "Data do documento no formato AAAA-MM-DD (data do pagamento, emissão da nota, pesagem)." },
      peso_kg: { type: ["number", "null"], description: "Peso líquido em kg (romaneio, NFP, contra nota)." },
      parcela: { type: ["string", "null"], enum: ["PARTE", "SALDO", null], description: "No pagamento: SALDO se o comprovante diz que é saldo/quitação, PARTE se diz adiantamento/parcial; null se não diz." },
      grao: { type: ["string", "null"], description: "Grão do documento (Soja, Milho, Sorgo...)." },
      nome_sugerido: { type: "string", description: "Nome curto e descritivo pro arquivo, em português, sem extensão (usado quando tipo = outro)." },
    },
    required: ["tipo", "assinado", "contrato_numero", "confianca", "motivo", "nome_sugerido"],
  },
};

// contratos: [{ numero, vendedor, comprador, grao, safra, quantidade, preco, data, status }]
// dica: texto que o corretor mandou junto (legenda no WhatsApp), se houver.
export async function lerComIA({ base64, mime, nomeOriginal, contratos, dica, timeoutMs = 24000, origem = "documento-painel" }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, erro: "Falta a chave da IA (ANTHROPIC_API_KEY) no Netlify." };
  const lista = (contratos || []).slice(0, 400).map(c =>
    `${c.numero} | vendedor: ${c.vendedor} | comprador: ${c.comprador} | ${c.grao || ""} ${c.safra || ""} | ${c.quantidade || "?"} sc | R$ ${c.preco || "?"}/sc | data ${c.data || "?"} | ${c.status || ""}`).join("\n");
  const bloco = mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mime, data: base64 } };
  const texto = `Você trabalha na Nexus Commodities, corretora de grãos em São Gabriel do Oeste/MS. O vendedor é o produtor rural e o comprador é a cerealista/cooperativa/trading. Leia o documento anexo (nome do arquivo: "${nomeOriginal || ""}") e classifique.${dica ? `\n\nO corretor mandou junto este texto (pode indicar o contrato, ex.: "141" = CT-2026-141): "${dica}"` : ""}

Contratos da Nexus (mais recentes primeiro):
${lista || "(nenhum)"}

Para achar o contrato, cruze nomes do vendedor e do comprador (pagador e favorecido no comprovante; emitente e destinatário nas notas), grão, quantidade, valor e datas. Se o próprio documento citar o número do contrato (CT-2026-xxx ou "CTR 108"), use. Só escolha um contrato com confiança "alta" se as partes baterem.`;

  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), timeoutMs);
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controle.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELO, max_tokens: 1024,
        thinking: { type: "disabled" }, // classificação simples: sem raciocínio fica mais rápido e a ferramenta forçada funciona
        tools: [FERRAMENTA], tool_choice: { type: "tool", name: FERRAMENTA.name },
        messages: [{ role: "user", content: [bloco, { type: "text", text: texto }] }],
      }),
    });
  } catch (e) {
    return { ok: false, erro: e.name === "AbortError" ? "A IA demorou demais pra ler. Tente de novo." : "Erro ao falar com a IA: " + e.message };
  } finally { clearTimeout(timer); }
  const j = await r.json();
  if (!r.ok) return { ok: false, erro: "IA: " + (j.error?.message || r.status) };
  await registrarUsoIA(origem, MODELO, j.usage);
  const uso = (j.content || []).find(b => b.type === "tool_use");
  if (!uso) return { ok: false, erro: "A IA não conseguiu classificar o documento." };
  return { ok: true, leitura: uso.input };
}

export async function salvarNoDrive({ base64, mime, nome_arquivo, contrato, nome_pasta, data_negocio }) {
  const url = process.env.DRIVE_SCRIPT_URL, token = process.env.DRIVE_SCRIPT_TOKEN;
  if (!url || !token) return { ok: false, erro: "Falta ligar o Google Drive (DRIVE_SCRIPT_URL e DRIVE_SCRIPT_TOKEN no Netlify)." };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ token, base64, mime, nome_arquivo, contrato: contrato || null, nome_pasta: nome_pasta || null, data_negocio: data_negocio || null }),
    redirect: "follow",
  });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return { ok: false, erro: "O Google Drive respondeu algo inesperado." }; }
}

// n: { numero_contrato, vendedor, comprador, grao } — mesmo padrão do painel (docIaNomeArquivo no index.html).
export function nomeArquivoDoc(l, n) {
  const ct = n?.numero_contrato || "";
  const vend = n?.vendedor || "", comp = n?.comprador || "";
  const partes = n ? ` - ${ct} - ${vend} x ${comp}` : "";
  const ctr = ct.replace(/^CT-\d{4}-0*/i, "");
  const dataBr = l.data ? l.data.split("-").reverse().join("-") : "";
  const kgNum = Number(l.peso_kg) || 0;
  const kg = kgNum ? kgNum.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) : "";
  const num = (l.numero_documento || "").replace(/\D/g, "") || l.numero_documento || "";
  const grao = (l.grao || n?.grao || "").toUpperCase();
  let nome;
  switch (l.tipo) {
    case "confirmacao": nome = `Confirmação${partes}${l.assinado ? " (assinada)" : ""}`; break;
    case "contrato": nome = `Contrato${l.numero_documento ? " " + l.numero_documento : ""}${partes}${l.assinado ? " (assinado)" : ""}`; break;
    case "pagamento": nome = `{SEQ} - PGTO CTR ${ctr || "?"}${l.parcela ? " " + l.parcela : ""}${vend ? " - " + vend.toUpperCase() : ""}${l.valor != null ? " - R$" + Number(l.valor).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ""}${dataBr ? " - " + dataBr : ""}`; break;
    case "nota_produtor": nome = `NFP ${num}${partes}`; break;
    case "contra_nota": nome = `CONTRA NF ${num} - COMPRA ${grao}${vend ? " " + vend.toUpperCase() : ""}${kg ? " - " + kg + "KG" : ""}${l.nfp_referenciada ? " - " + l.nfp_referenciada : ""}`; break;
    case "nota_fiscal": nome = `NF ${num}${partes}`; break;
    case "romaneio": nome = kgNum ? `Romaneio embarque - ${kg} kg (${(kgNum / 60).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} sacas)` : `Romaneio embarque${dataBr ? " - " + dataBr : ""}`; break;
    case "liberacao_embarque": nome = `Liberação de embarque${partes}${l.assinado ? " (assinada)" : ""}`; break;
    default: nome = `${l.nome_sugerido || "Documento"}${ct ? " - " + ct : ""}`;
  }
  return nome.replace(/[\/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

export function nomePastaContrato(n) {
  return `Confirmação ${n.numero_contrato} - ${n.vendedor} x ${n.comprador}`;
}

// ---------- documento salvo → checklist do contrato ----------
// Depois que um documento vai pro Drive, marca no contrato o que ele comprova (mesmos campos do checklist
// do painel). Comprovante de pagamento: guarda o valor em nexus_pagamentos_recebidos e só marca "pago"
// quando a soma cobre o líquido do contrato (ou cada parcela, na ordem das datas). Romaneio vira carga entregue.
const ITENS_CHECKLIST = ["check_confirmacao", "check_contrato", "check_nota_fiscal", "check_contra_nota", "check_liberacao_embarque", "check_embarque_entrega"];
const CHECK_POR_TIPO = { contrato: "check_contrato", nota_produtor: "check_nota_fiscal", contra_nota: "check_contra_nota", liberacao_embarque: "check_liberacao_embarque" };
const fmtR = v => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function somarDiasISO(iso, dias) { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + Number(dias))).toISOString().slice(0, 10); }
const cargasDe = n => Array.isArray(n.cargas) ? n.cargas : [];
const sacasEntregues = n => cargasDe(n).reduce((s, c) => s + Number(c.sacas || 0), 0);

// Mesma regra do painel (dataPagamentoPorEntrega no index.html).
export function dataPagamentoPorEntrega(n) {
  if (n.pagamento_dias_apos_entrega == null) return null;
  const dias = Number(n.pagamento_dias_apos_entrega);
  const base = n.embarque_finalizado_em ? new Date(n.embarque_finalizado_em).toLocaleDateString("en-CA") : (n.data_fim_embarque || null);
  if (n.pagamento_base === "total") {
    let b = base;
    if (!n.embarque_finalizado_em) {
      const cs = cargasDe(n).filter(c => c.data);
      b = cs.length && Number(n.quantidade || 0) - sacasEntregues(n) <= 0.5 ? cs.map(c => c.data).sort().pop() : (n.data_fim_embarque || null);
    }
    return b ? somarDiasISO(b, dias) : null;
  }
  const datas = cargasDe(n).filter(c => c.data).map(c => somarDiasISO(c.data, dias));
  if (!n.embarque_finalizado_em && Number(n.quantidade || 0) - sacasEntregues(n) > 0.5 && n.data_fim_embarque) datas.push(somarDiasISO(n.data_fim_embarque, dias));
  if (!datas.length && n.embarque_finalizado_em) datas.push(somarDiasISO(base, dias));
  return datas.length ? datas.sort().pop() : null;
}

// Mesma conta do painel (precoLiquidoNegocio).
export function precoLiquidoNegocio(n, comprador, config) {
  if (n.preco_liquido != null && n.preco_liquido !== "") return Number(n.preco_liquido);
  const sacas = Number(n.quantidade || 0), total = Number(n.preco || 0) * sacas;
  const comFF = !comprador || (comprador.categoria_comprador !== "Cooperativa" && comprador.categoria_comprador !== "Cerealista");
  const ff = comFF ? (Number(config.fundersul_saca || 0) + Number(config.fundems_saca || 0)) * sacas : 0;
  const funrural = (n.funrural_forma || "Comercialização") === "Comercialização" ? total * Number(config.funrural_pct || 0) / 100 : 0;
  const comissao = n.comissao_pagador === "Comprador" ? 0 : Number(n.comissao || 0);
  return sacas ? (total - comissao - total * 0.002 - ff - funrural) / sacas : 0;
}

export async function aplicarDocumentoNoNegocio({ negocioId, leitura: l, nomeArquivo, origem, usuarioId }) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const get = path => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H }).then(r => r.json());
  const n = (await get(`nexus_negocios?id=eq.${negocioId}&select=*`))[0];
  if (!n || !l) return [];
  const upd = {}, feito = [];

  const campo = l.tipo === "confirmacao" ? (l.assinado ? "check_confirmacao" : null) : CHECK_POR_TIPO[l.tipo];
  if (campo && !n[campo]) { upd[campo] = true; feito.push({ check_confirmacao: "👍 Confirmação assinada", check_contrato: "✍️ Contrato", check_nota_fiscal: "🧾 Nota fiscal", check_contra_nota: "📑 Contra nota", check_liberacao_embarque: "🚚 Liberação de embarque" }[campo]); }

  if (l.tipo === "romaneio" && Number(l.peso_kg) > 0) {
    const data = l.data || new Date().toLocaleDateString("en-CA", { timeZone: "America/Campo_Grande" });
    const sacas = Math.round(Number(l.peso_kg) / 60 * 1000) / 1000;
    if (!cargasDe(n).some(c => c.data === data && Math.abs(Number(c.sacas || 0) - sacas) < 0.5)) {
      const cargas = [...cargasDe(n), { id: randomUUID(), data, sacas, doc: nomeArquivo || null }];
      upd.cargas = cargas;
      const dp = dataPagamentoPorEntrega({ ...n, cargas });
      if (dp) upd.data_pagamento = dp;
      const tot = sacasEntregues({ cargas });
      feito.push(`🚛 Carga de ${Number(l.peso_kg).toLocaleString("pt-BR")} kg em ${data.split("-").reverse().join("/")} — entregue ${tot.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} de ${Number(n.quantidade || 0).toLocaleString("pt-BR")} sc`);
    }
  }

  if (l.tipo === "pagamento" && Number(l.valor) > 0) {
    const ja = await get(`nexus_pagamentos_recebidos?negocio_id=eq.${n.id}&select=valor,data`);
    const repetido = ja.some(p => Math.abs(Number(p.valor) - Number(l.valor)) < 0.01 && (p.data || null) === (l.data || null));
    if (!repetido) {
      await fetch(`${SUPABASE_URL}/rest/v1/nexus_pagamentos_recebidos`, { method: "POST", headers: H, body: JSON.stringify({ negocio_id: n.id, valor: Number(l.valor), data: l.data || null, documento: nomeArquivo || null, origem }) });
      ja.push({ valor: Number(l.valor), data: l.data || null });
    }
    const recebido = ja.reduce((s, p) => s + Number(p.valor || 0), 0);
    const [comp] = n.cliente_id ? await get(`nexus_cadastros?id=eq.${n.cliente_id}&select=categoria_comprador`) : [null];
    const [cfg] = await get("nexus_config?id=eq.1&select=fundersul_saca,fundems_saca,funrural_pct");
    const pl = precoLiquidoNegocio(n, comp, cfg || {}), liquido = pl * Number(n.quantidade || 0);
    const TOL = 0.98; // comprovante costuma vir com centavos/descontos de diferença
    const extras = n.pagamentos_extra || [];
    if (liquido > 0 && extras.length && n.pagamento_dias_apos_entrega == null) {
      // Parcelas na ordem: a 1ª (data_pagamento, check_pagamento) e as extras (pago dentro do jsonb).
      const completa = extras[0].data === n.data_pagamento;
      const vExtra = p => p.unidade === "sc" ? Number(p.valor || 0) * pl : Number(p.valor || 0);
      const lista = completa ? extras.map((p, j) => ({ j, valor: vExtra(p) })) : [{ j: null, valor: liquido - extras.reduce((s, p) => s + vExtra(p), 0) }, ...extras.map((p, j) => ({ j, valor: vExtra(p) }))];
      let acumulado = 0, pagas = 0;
      const novosExtras = extras.map(p => ({ ...p }));
      let primeiraPaga = !!n.check_pagamento;
      for (const parc of lista) {
        acumulado += parc.valor;
        if (recebido < acumulado * TOL) break;
        pagas++;
        if (parc.j === null || (completa && parc.j === 0)) primeiraPaga = true;
        if (parc.j !== null) novosExtras[parc.j].pago = true;
      }
      if (primeiraPaga !== !!n.check_pagamento) upd.check_pagamento = primeiraPaga;
      if (JSON.stringify(novosExtras) !== JSON.stringify(extras)) upd.pagamentos_extra = novosExtras;
      feito.push(`💵 Pagamento: ${fmtR(recebido)} recebidos de ${fmtR(liquido)} — ${pagas} de ${lista.length} parcelas pagas`);
    } else if (liquido > 0) {
      const quitado = recebido >= liquido * TOL;
      if (quitado && !n.check_pagamento) upd.check_pagamento = true;
      feito.push(quitado ? `💵 Pagamento quitado: ${fmtR(recebido)} de ${fmtR(liquido)}` : `💵 Pagamento parcial: ${fmtR(recebido)} de ${fmtR(liquido)} — falta ${fmtR(liquido - recebido)}`);
    } else {
      feito.push(`💵 Pagamento de ${fmtR(l.valor)} anotado (contrato sem preço líquido pra comparar)`);
    }
  }

  if (Object.keys(upd).length) {
    const depois = { ...n, ...upd };
    const parcelasOk = (depois.pagamentos_extra || []).every(p => p.pago || n.pagamento_dias_apos_entrega != null) && !!depois.check_pagamento;
    if (depois.status !== "Finalizado" && parcelasOk && ITENS_CHECKLIST.every(c => depois[c])) { upd.status = "Finalizado"; feito.push("🏁 Contrato finalizado (checklist completo)"); }
    await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${n.id}`, { method: "PATCH", headers: H, body: JSON.stringify(upd) });
    await fetch(`${SUPABASE_URL}/rest/v1/nexus_audit_log`, { method: "POST", headers: H, body: JSON.stringify({ tabela: "nexus_negocios", registro_id: n.id, acao: `documento_ia:${origem}`, usuario_id: usuarioId || null, alteracoes: upd }) }).catch(() => {});
  }
  return feito;
}
