const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Roda a cada 3 minutos e manda NO MÁXIMO uma mensagem da fila (nexus_whatsapp_fila) por vez —
// é o que evita repetir a restrição de conta que o disparo em massa do dia 15/09/2026 causou.
// Sem nada pendente, só sai sem fazer nada (praticamente de graça). Alimentada hoje só pelo
// aviso-canal-mensal.mjs, mas serve pra qualquer outro envio em massa que precisar entrar na fila.
export default async () => {
  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }, 500);
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN) return json({ ok: false, erro: "Variáveis do Z-API não configuradas." }, 200);
  const adminHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

  const filaResp = await fetch(
    `${SUPABASE_URL}/rest/v1/nexus_whatsapp_fila?enviado_em=is.null&erro=is.null&select=id,telefone,mensagem&order=criado_em.asc&limit=1`,
    { headers: adminHeaders }
  );
  const fila = await filaResp.json().catch(() => []);
  const item = Array.isArray(fila) ? fila[0] : null;
  if (!item) return json({ ok: true, processado: false });

  let erro = null;
  try {
    const resp = await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN },
      body: JSON.stringify({ phone: item.telefone, message: item.mensagem }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) erro = data.error || data.message || `Z-API retornou ${resp.status}`;
  } catch (e) {
    erro = String(e.message || e);
  }

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_whatsapp_fila?id=eq.${item.id}`, {
    method: "PATCH",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(erro ? { erro } : { enviado_em: new Date().toISOString() }),
  });

  return json({ ok: !erro, processado: true, telefone: item.telefone, erro });
};

export const config = { schedule: "*/3 * * * *" };
