const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// O corretor define a senha do portal de um cliente (produtor/comprador) que já tem acesso criado.
// Só corretor autenticado (nexus_equipe) pode chamar, e só pra login de cliente: login de alguém da equipe nunca é alterado aqui.
export default async (req) => {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, erro: "Corpo da requisição inválido." }, 400);
  }
  const { cadastro_id, senha, access_token } = payload || {};
  if (!cadastro_id || !senha || !access_token) {
    return json({ ok: false, erro: "Dados incompletos (cadastro_id, senha e access_token são obrigatórios)." }, 400);
  }
  if (String(senha).length < 6) return json({ ok: false, erro: "A senha precisa ter pelo menos 6 caracteres." }, 400);

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
    return json({ ok: false, erro: "Apenas corretores da equipe Nexus podem definir a senha de cliente." }, 403);
  }

  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=eq.${encodeURIComponent(cadastro_id)}&select=id,nome,user_id`, { headers: adminHeaders });
  const cad = cadResp.ok ? (await cadResp.json())[0] : null;
  if (!cad) return json({ ok: false, erro: "Cadastro não encontrado." }, 404);
  if (!cad.user_id) return json({ ok: false, erro: "Esse cadastro ainda não tem acesso criado. Crie o acesso primeiro." }, 400);

  const alvoEquipe = await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?user_id=eq.${cad.user_id}&select=user_id`, { headers: adminHeaders });
  const alvoRows = alvoEquipe.ok ? await alvoEquipe.json() : [];
  if (Array.isArray(alvoRows) && alvoRows.length) {
    return json({ ok: false, erro: "Esse login é de alguém da equipe — a senha não pode ser trocada por aqui." }, 403);
  }

  // email_confirm: um cliente que recebeu o convite e nunca abriu também passa a conseguir entrar com essa senha.
  // senha_provisoria: no primeiro login o portal pede pro cliente trocar por uma senha dele.
  const upd = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${cad.user_id}`, {
    method: "PUT",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ password: String(senha), email_confirm: true, user_metadata: { senha_provisoria: true } }),
  });
  if (!upd.ok) {
    const e = await upd.json().catch(() => ({}));
    return json({ ok: false, erro: e.msg || e.error_description || e.error || `Não consegui definir a senha (${upd.status}).` }, 500);
  }
  return json({ ok: true }, 200);
};
