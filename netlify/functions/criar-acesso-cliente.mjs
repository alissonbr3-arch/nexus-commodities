const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";
const PORTAL_URL = "https://nexuscommodities.netlify.app/portal/";

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Cria (ou reaproveita) o login do cliente e vincula ao cadastro correspondente.
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
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` },
  });
  if (!userResp.ok) return json({ ok: false, erro: "Sessão inválida ou expirada." }, 401);
  const caller = await userResp.json();

  const staffResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?user_id=eq.${caller.id}&select=user_id`, { headers: adminHeaders });
  const staffRows = await staffResp.json();
  if (!Array.isArray(staffRows) || staffRows.length === 0) {
    return json({ ok: false, erro: "Apenas corretores da equipe Nexus podem criar acesso de cliente." }, 403);
  }

  // Verifica se esse e-mail já tem uma conta (de uma tentativa anterior, por exemplo) antes de convidar de novo.
  const existingResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, { headers: adminHeaders });
  const existingData = existingResp.ok ? await existingResp.json() : { users: [] };
  const existingUser = (existingData.users || []).find(u => (u.email || "").toLowerCase() === email.toLowerCase());

  let userId;
  if (existingUser) {
    const linkedResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?user_id=eq.${existingUser.id}&select=id,nome`, { headers: adminHeaders });
    const linkedRows = linkedResp.ok ? await linkedResp.json() : [];
    const linkedToOther = (linkedRows || []).find(r => r.id !== cadastro_id);
    if (linkedToOther) {
      return json({ ok: false, erro: `Esse e-mail já está vinculado ao cadastro de "${linkedToOther.nome}". Use outro e-mail ou remova o vínculo antigo primeiro.` }, 409);
    }
    userId = existingUser.id;
  } else {
    const inviteResp = await fetch(`${SUPABASE_URL}/auth/v1/invite?redirect_to=${encodeURIComponent(PORTAL_URL)}`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const invited = await inviteResp.json();
    if (!inviteResp.ok) {
      return json({ ok: false, erro: invited.msg || invited.error_description || invited.error || "Erro ao criar o convite." }, 500);
    }
    userId = invited.id;
  }

  const updateResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=eq.${cadastro_id}`, {
    method: "PATCH",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: userId, email }),
  });
  if (!updateResp.ok) {
    const detail = await updateResp.text();
    return json({ ok: false, erro: `Convite criado, mas não consegui vincular ao cadastro (${updateResp.status}): ${detail.slice(0, 200)}` }, 500);
  }

  return json({ ok: true, user_id: userId }, 200);
};
