// Todo dia 1º: manda no WhatsApp do Álisson quanto a IA (Claude) custou no mês anterior — documentos lidos
// (painel e WhatsApp) e conversa da assistente, com o total em US$ e em R$ (dólar do painel).
// Base: nexus_ia_uso, gravada a cada chamada por registrarUsoIA (_documento-lib.mjs).
const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const TELEFONE_ALISSON = "5567992243119";
const ALISSON_USER_ID = "30c3a0f2-aef5-48e0-a156-dd06aae0f9bf";
const ORIGENS = { "documento-painel": "Documentos pelo painel", "documento-whatsapp": "Documentos pelo WhatsApp", "assistente-whatsapp": "Conversa com a assistente", "audio-whatsapp": "Áudios transcritos", "cliente-whatsapp": "Respostas a clientes", "cliente-filtro": "Filtro de mensagens de clientes" };
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
    fetch(`${SUPABASE_URL}/rest/v1/nexus_ia_uso?created_at=gte.${ini}&created_at=lt.${fim}&select=origem,modelo,custo_usd`, { headers: H }).then(r => r.json()),
    fetch(`${SUPABASE_URL}/rest/v1/nexus_dolar?id=eq.1&select=atual`, { headers: H }).then(r => r.json()),
  ]);
  const dolar = Number(dolarRows?.[0]?.atual) || 5.5;
  const porOrigem = {};
  for (const u of usos || []) { const o = porOrigem[u.origem] ||= { n: 0, usd: 0 }; o.n++; o.usd += Number(u.custo_usd || 0); }
  const totalUsd = Object.values(porOrigem).reduce((s, o) => s + o.usd, 0);
  const claudeUsd = (usos || []).filter(u => String(u.modelo).startsWith("claude")).reduce((s, u) => s + Number(u.custo_usd || 0), 0);
  const openaiUsd = totalUsd - claudeUsd;
  const brl = v => "R$ " + (v * dolar).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const linhas = Object.entries(porOrigem).sort((a, b) => b[1].usd - a[1].usd)
    .map(([o, v]) => `• ${ORIGENS[o] || o}: ${v.n} ${o === "assistente-whatsapp" || o === "cliente-whatsapp" ? "chamadas à IA" : o === "cliente-filtro" ? "mensagens" : o === "audio-whatsapp" ? "áudios" : "leituras"} — ${brl(v.usd)}`);
  const msg = `🤖 *Gasto com IA — ${MESES[mes - 1]}/${ano}*\n\n${linhas.length ? linhas.join("\n") : "Nenhum uso no mês."}\n\n*Total: ${brl(totalUsd)}* (US$ ${totalUsd.toFixed(2)} · dólar ${dolar.toFixed(2)})\nClaude ${brl(claudeUsd)} · OpenAI ${brl(openaiUsd)}\n\nLançado no Financeiro da Nexus como despesa (reembolso ao Álisson), vencendo dia 5.`;

  // Despesa da Nexus: reembolso ao Álisson, que paga a Anthropic e a OpenAI do bolso. Uma por mês (chave_auto),
  // vencendo dia 5 do mês seguinte; se rodar de novo, não duplica.
  if (!pedido && totalUsd > 0) {
    const venc = mes === 12 ? `${ano + 1}-01-05` : `${ano}-${String(mes + 1).padStart(2, "0")}-05`;
    await fetch(`${SUPABASE_URL}/rest/v1/nexus_despesas?on_conflict=chave_auto`, {
      method: "POST", headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        chave_auto: `ia-${ano}-${String(mes).padStart(2, "0")}`, categoria: "Escritório", data: venc,
        descricao: `Inteligência artificial (Claude + OpenAI) — ${MESES[mes - 1]} de ${ano} — reembolso ao Álisson`,
        valor: Math.round(totalUsd * dolar * 100) / 100,
        obs: `Estimado pelo uso registrado no app: Claude ${brl(claudeUsd)}, OpenAI ${brl(openaiUsd)} (US$ ${totalUsd.toFixed(2)}, dólar ${dolar.toFixed(2)}).`,
        created_by: ALISSON_USER_ID,
      }),
    }).catch(e => console.log("falha ao lançar despesa de IA:", String(e)));
  }

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
