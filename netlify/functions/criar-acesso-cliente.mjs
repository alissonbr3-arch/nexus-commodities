const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";
const PORTAL_URL = "https://nexuscommodities.netlify.app/portal/";

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Cria o login do cliente (Supabase Auth) e vincula ao cadastro correspondente.
// Só pode ser chamada por um corretor autenticado (validado via nexus_equipe).
export default async (req) => {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, erro: "Corpo da requisição inválido." }, 400);
  }
  const { cadastro_id, email, access_token } = payload || {};
  if (!cadastro_id || !email || !access_token) {
    return json({ ok: false, erro: "Dados incompletos (cadastro_id, email e access_token são obrigatórios)." }, 400);
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada nas variáveis de ambiente do Netlify." }, 500);
  }

  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` },
  });
  if (!userResp.ok) return json({ ok: false, erro: "Sessão inválida ou expirada." }, 401);
  const caller = await userResp.json();

  const staffResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?user_id=eq.${caller.id}&select=user_id`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const staffRows = await staffResp.json();
  if (!Array.isArray(staffRows) || staffRows.length === 0) {
    return json({ ok: false, erro: "Apenas corretores da equipe Nexus podem criar acesso de cliente." }, 403);
  }

  const inviteResp = await fetch(`${SUPABASE_URL}/auth/v1/invite?redirect_to=${encodeURIComponent(PORTAL_URL)}`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const invited = await inviteResp.json();
  if (!inviteResp.ok) {
    return json({ ok: false, erro: invited.msg || invited.error_description || invited.error || "Erro ao criar o convite." }, 500);
  }

  const updateResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=eq.${cadastro_id}`, {
    method: "PATCH",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: invited.id, email }),
  });
  if (!updateResp.ok) {
    return json({ ok: false, erro: "Convite criado, mas não consegui vincular ao cadastro. Avise o suporte." }, 500);
  }

  return json({ ok: true, user_id: invited.id }, 200);
};
