const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";

// Remetente dos e-mails via Resend — precisa ser um domínio verificado lá (nexuscommoditiesms.com.br).
const FROM_EMAIL = "Nexus Commodities <contratos@nexuscommoditiesms.com.br>";

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Envia a Liberação de Embarque por e-mail (Resend) pro produtor e comprador, só pra conhecimento
// das partes — sem DocuSign, não precisa de assinatura. Só corretores da equipe Nexus podem chamar.
export default async (req) => {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, erro: "Corpo da requisição inválido." }, 400);
  }
  const { negocio_id, access_token, html } = payload || {};
  if (!negocio_id || !access_token || !html) {
    return json({ ok: false, erro: "Dados incompletos (negocio_id, access_token e html são obrigatórios)." }, 400);
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada nas variáveis de ambiente do Netlify." }, 500);
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
    return json({ ok: false, erro: "Apenas corretores da equipe Nexus podem enviar liberações." }, 403);
  }

  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${negocio_id}&select=*`, { headers: adminHeaders });
  const negRows = await negResp.json();
  const negocio = negRows[0];
  if (!negocio) return json({ ok: false, erro: "Negócio não encontrado." }, 404);

  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${negocio.produtor_id},${negocio.cliente_id})&select=id,nome,email`, { headers: adminHeaders });
  const cads = await cadResp.json();
  const vendedor = cads.find(c => c.id === negocio.produtor_id);
  const comprador = cads.find(c => c.id === negocio.cliente_id);
  if (!vendedor?.email || !comprador?.email) {
    return json({ ok: false, erro: "Vendedor e comprador precisam ter e-mail de contato cadastrado antes de enviar." }, 400);
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return json({ ok: false, erro: "RESEND_API_KEY não configurada." }, 500);
  }

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [vendedor.email, comprador.email],
        subject: `Liberação de Embarque ${negocio.numero_contrato || ""} — Nexus Commodities`,
        html,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || JSON.stringify(data));
  } catch (e) {
    return json({ ok: false, erro: String(e.message || e) }, 500);
  }

  return json({ ok: true }, 200);
};
