const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function formatarTelefoneWhats(telefone) {
  const digitos = String(telefone || "").replace(/\D/g, "");
  if (!digitos) return "";
  if (digitos.startsWith("55") && digitos.length >= 12) return digitos;
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  return digitos;
}

function fmtNum(v) { return Number(v || 0).toLocaleString("pt-BR"); }
function fmtMoney(v) { return "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Mesma conta do preço líquido usada no painel (Negociações / Confirmação): desconta
// comissão, 0,2% Senar, Fundersul/Fundems (se o comprador não for Cooperativa/Cerealista)
// e Funrural — ou usa o valor líquido informado manualmente no negócio, se houver.
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
  const liquidoEstimado = total - Number(n.comissao || 0) - senar - fundersulTotal - fundemsTotal - funrural;
  const informado = n.preco_liquido != null && n.preco_liquido !== "";
  const precoLiquido = informado ? Number(n.preco_liquido) : (sacas ? liquidoEstimado / sacas : 0);
  return { precoLiquido, informado };
}

// Avisa o produtor por WhatsApp que uma negociação foi registrada em nome dele, com os
// dados do negócio. Botão manual na lista de Negociações — só corretores da equipe Nexus
// podem chamar.
export default async (req) => {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, erro: "Corpo da requisição inválido." }, 400);
  }
  const { negocio_id, access_token } = payload || {};
  if (!negocio_id || !access_token) {
    return json({ ok: false, erro: "Dados incompletos (negocio_id e access_token são obrigatórios)." }, 400);
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN } = process.env;
  if (!serviceKey) {
    return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada nas variáveis de ambiente do Netlify." }, 500);
  }
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN) {
    return json({ ok: false, erro: "Variáveis do Z-API não configuradas." }, 500);
  }
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` },
  });
  if (!userResp.ok) return json({ ok: false, erro: "Sessão inválida ou expirada." }, 401);
  const caller = await userResp.json();

  const staffResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?user_id=eq.${caller.id}&select=user_id`, { headers: adminHeaders });
  const staffRows = await staffResp.json();
  if (!Array.isArray(staffRows) || staffRows.length === 0) {
    return json({ ok: false, erro: "Apenas corretores da equipe Nexus podem enviar avisos." }, 403);
  }

  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${negocio_id}&select=*`, { headers: adminHeaders });
  const negRows = await negResp.json();
  const negocio = negRows[0];
  if (!negocio) return json({ ok: false, erro: "Negócio não encontrado." }, 404);

  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${negocio.produtor_id},${negocio.cliente_id})&select=id,nome,telefone,telefones_extra,categoria_comprador`, { headers: adminHeaders });
  const cads = await cadResp.json();
  const vendedor = cads.find(c => c.id === negocio.produtor_id);
  const comprador = cads.find(c => c.id === negocio.cliente_id);
  if (!vendedor) return json({ ok: false, erro: "Negócio precisa de um produtor cadastrado." }, 400);

  const telefones = [...new Set([vendedor.telefone, ...(vendedor.telefones_extra || [])].map(formatarTelefoneWhats).filter(Boolean))];
  if (telefones.length === 0) return json({ ok: false, erro: `Cadastre o telefone de ${vendedor.nome} antes de enviar.` }, 400);

  const cfgResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_config?id=eq.1&select=fundersul_saca,fundems_saca,funrural_pct`, { headers: adminHeaders });
  const cfgRows = await cfgResp.json().catch(() => []);
  const config = cfgRows[0] || {};
  const { precoLiquido, informado } = precoLiquidoNegocio(negocio, comprador, config);

  const mensagem = `Olá, ${vendedor.nome}! Aqui é da Nexus Commodities.\n\nUma nova negociação foi registrada em seu nome:\nContrato: ${negocio.numero_contrato || "—"}\n${negocio.grao || ""}${negocio.safra ? " " + negocio.safra : ""} — ${fmtNum(negocio.quantidade)} sc\nComprador: ${comprador ? comprador.nome : "—"}\nPreço Bruto: ${fmtMoney(negocio.preco)}/sc (${negocio.modalidade || "FOB"})\nPreço Líquido${informado ? "" : " (estimado)"}: ${fmtMoney(precoLiquido)}/sc\n\nQualquer dúvida, fale com seu corretor.`;

  const resultados = [];
  for (const telefone of telefones) {
    let sucesso = false, erro = null;
    try {
      const resp = await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN },
        body: JSON.stringify({ phone: telefone, message: mensagem }),
      });
      const respData = await resp.json().catch(() => ({}));
      if (!resp.ok || respData.error) throw new Error(respData.error || respData.message || `Z-API retornou ${resp.status}`);
      sucesso = true;
    } catch (e) {
      erro = String(e.message || e);
    }
    resultados.push({ telefone, sucesso, erro });
  }

  const sucesso = resultados.some(r => r.sucesso);
  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      negocio_id, tipo: "WhatsApp Nova Negociação", destinatarios: telefones.join(", "),
      enviado_por: caller.id, sucesso, erro: resultados.filter(r => !r.sucesso).map(r => `${r.telefone}: ${r.erro}`).join("; ") || null,
    }),
  }).catch(() => {});

  return sucesso ? json({ ok: true, resultados }, 200) : json({ ok: false, erro: "Falha em todos os envios.", resultados }, 500);
};
