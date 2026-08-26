const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Compara só os últimos 11 dígitos (DDD + número), ignorando código do país (55)
// e diferenças de formatação — assim "67999990000" e "5567999990000" batem igual.
function ultimosDigitos(tel, n = 11) {
  return String(tel || "").replace(/\D/g, "").slice(-n);
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

const CAMPO_ALIASES = {
  produtor: "produtor", vendedor: "produtor",
  comprador: "comprador", cliente: "comprador",
  grao: "grao", produto: "grao",
  safra: "safra",
  quantidade: "quantidade", qtd: "quantidade", sacas: "quantidade",
  preco: "preco",
  modalidade: "modalidade",
};

function parseMensagem(texto) {
  const linhas = texto.split("\n").map(l => l.trim()).filter(Boolean);
  const campos = {};
  for (const linha of linhas.slice(1)) {
    const idx = linha.indexOf(":");
    if (idx === -1) continue;
    const chave = CAMPO_ALIASES[normalizarTexto(linha.slice(0, idx))];
    if (chave) campos[chave] = linha.slice(idx + 1).trim();
  }
  return campos;
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

// Recebe o webhook "ao receber mensagem" da Z-API. Se a mensagem vier de um corretor
// conhecido (telefone cadastrado em nexus_equipe) e começar com "NOVA NEGOCIAÇÃO",
// cria um rascunho de negócio a partir dos campos "Chave: valor" das linhas seguintes.
// Protegido por um secret na querystring — sem ele, ignora a chamada.
export default async (req) => {
  const url = new URL(req.url);
  const { WHATSAPP_WEBHOOK_SECRET, ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  if (!WHATSAPP_WEBHOOK_SECRET || url.searchParams.get("secret") !== WHATSAPP_WEBHOOK_SECRET) {
    return json({ ok: false }, 401);
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }, 500);

  let payload;
  try { payload = await req.json(); } catch { return json({ ok: true }); }

  if (payload.fromMe || payload.isGroup || !payload.text?.message || !payload.phone) {
    return json({ ok: true, ignorado: true });
  }

  const texto = payload.text.message;
  const primeiraLinha = normalizarTexto((texto.split("\n")[0] || ""));
  if (!primeiraLinha.startsWith("nova negociacao")) {
    return json({ ok: true, ignorado: true });
  }

  const adminHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const zapi = { instanceId: ZAPI_INSTANCE_ID, token: ZAPI_TOKEN, clientToken: ZAPI_CLIENT_TOKEN };

  const equipeResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?select=user_id,nome,telefone`, { headers: adminHeaders });
  const equipe = await equipeResp.json();
  const remetente = ultimosDigitos(payload.phone);
  const corretor = equipe.find(e => e.telefone && ultimosDigitos(e.telefone) === remetente);
  if (!corretor) {
    // número não cadastrado em nenhum corretor — ignora silenciosamente
    return json({ ok: true, ignorado: true });
  }

  const campos = parseMensagem(texto);

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

  const negocioPayload = {
    numero_contrato: numeroContrato,
    grao,
    safra: campos.safra || "",
    quantidade: parseNumeroBR(campos.quantidade),
    preco: parseNumeroBR(campos.preco),
    modalidade,
    produtor_id: produtor?.id || null,
    cliente_id: comprador?.id || null,
    contraparte: comprador ? comprador.nome : (campos.comprador || "—"),
    corretor_id: corretor.user_id,
    status: "Rascunho",
    data: new Date().toISOString().slice(0, 10),
    comissao_pagador: "Vendedor",
    funrural_forma: "Comercialização",
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
    ? `✅ Rascunho ${numeroContrato} criado!\nProdutor: ${linhaProdutor}\nComprador: ${linhaComprador}\n${grao}${campos.safra ? " " + campos.safra : ""} — ${campos.quantidade || "?"} sc a ${campos.preco || "?"} (${modalidade})\nComplete e confirme no painel.`
    : "⚠️ Não consegui criar o rascunho da negociação agora. Tenta de novo ou avisa o Alisson.";
  await enviarWhatsapp({ ...zapi, telefone: payload.phone, mensagem: resposta });

  return json({ ok: !!ok, numeroContrato: ok ? numeroContrato : null });
};
