// Todo dia 1º: manda no WhatsApp do Álisson quanto a IA (Claude) custou no mês anterior — documentos lidos
// (painel e WhatsApp) e conversa da assistente, com o total em US$ e em R$ (dólar do painel).
// Base: nexus_ia_uso, gravada a cada chamada por registrarUsoIA (_documento-lib.mjs).
const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const TELEFONE_ALISSON = "5567992243119";
const ORIGENS = { "documento-painel": "Documentos pelo painel", "documento-whatsapp": "Documentos pelo WhatsApp", "assistente-whatsapp": "Conversa com a assistente", "audio-whatsapp": "Áudios transcritos" };
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export default async (req) => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  // ?mes=2026-11 permite pedir um mês específico (teste); sem nada = mês anterior.
  const pedido = req?.url ? new URL(req.url).searchParams.get("mes") : null;
  const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Campo_Grande" }));
  const [ano, mes] = pedido ? pedido.split("-").map(Number) : [agora.getMonth() === 0 ? agora.getFullYear() - 1 : agora.getFullYear(), agora.getMonth() === 0 ? 12 : agora.getMonth()];
  const ini = `${ano}-${String(mes).padStart(2, "0")}-01T04:00:00Z`; // meia-noite em MS
  const fim = mes === 12 ? `${ano + 1}-01-01T04:00:00Z` : `${ano}-${String(mes + 1).padStart(2, "0")}-01T04:00:00Z`;

  const [usos, dolarRows] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/nexus_ia_uso?created_at=gte.${ini}&created_at=lt.${fim}&select=origem,custo_usd`, { headers: H }).then(r => r.json()),
    fetch(`${SUPABASE_URL}/rest/v1/nexus_dolar?id=eq.1&select=atual`, { headers: H }).then(r => r.json()),
  ]);
  const dolar = Number(dolarRows?.[0]?.atual) || 5.5;
  const porOrigem = {};
  for (const u of usos || []) { const o = porOrigem[u.origem] ||= { n: 0, usd: 0 }; o.n++; o.usd += Number(u.custo_usd || 0); }
  const totalUsd = Object.values(porOrigem).reduce((s, o) => s + o.usd, 0);
  const brl = v => "R$ " + (v * dolar).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const linhas = Object.entries(porOrigem).sort((a, b) => b[1].usd - a[1].usd)
    .map(([o, v]) => `• ${ORIGENS[o] || o}: ${v.n} ${o === "assistente-whatsapp" ? "chamadas à IA" : o === "audio-whatsapp" ? "áudios" : "leituras"} — ${brl(v.usd)}`);
  const msg = `🤖 *Gasto com IA — ${MESES[mes - 1]}/${ano}*\n\n${linhas.length ? linhas.join("\n") : "Nenhum uso no mês."}\n\n*Total: ${brl(totalUsd)}* (US$ ${totalUsd.toFixed(2)} · dólar ${dolar.toFixed(2)})\n\nLeituras e conversa saem dos créditos da Anthropic; áudios, dos créditos da OpenAI.`;

  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN } = process.env;
  if (!pedido || new URL(req.url).searchParams.get("enviar") === "1") {
    await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`, {
      method: "POST", headers: { "Content-Type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN },
      body: JSON.stringify({ phone: TELEFONE_ALISSON, message: msg }),
    });
  }
  return new Response(JSON.stringify({ ok: true, mensagem: msg }), { headers: { "Content-Type": "application/json" } });
};

export const config = { schedule: "0 11 1 * *" }; // dia 1º, 8h em MS
