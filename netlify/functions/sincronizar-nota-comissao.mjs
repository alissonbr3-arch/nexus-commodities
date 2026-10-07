import { sincronizarNotaDoAsaas, headersAdmin } from "./_nota-lib.mjs";

const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";
function json(body, status) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }

// Botão "Atualizar status" da nota no painel: pergunta já ao Asaas como está a nota do negócio,
// grava e — se acabou de ser autorizada — manda por e-mail pro tomador. Só equipe Nexus.
export default async (req) => {
  let payload;
  try { payload = await req.json(); } catch { return json({ ok: false, erro: "Corpo da requisição inválido." }, 400); }
  const { negocio_id, access_token } = payload || {};
  if (!negocio_id || !access_token) return json({ ok: false, erro: "Dados incompletos." }, 400);
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.ASAAS_API_KEY) return json({ ok: false, erro: "Chaves não configuradas." }, 500);

  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` } });
  if (!userResp.ok) return json({ ok: false, erro: "Sessão inválida ou expirada." }, 401);
  const caller = await userResp.json();
  const staff = await (await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?user_id=eq.${caller.id}&select=user_id`, { headers: headersAdmin() })).json();
  if (!Array.isArray(staff) || !staff.length) return json({ ok: false, erro: "Apenas corretores da equipe Nexus." }, 403);

  const neg = (await (await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${negocio_id}&select=nota_fiscal_asaas_id`, { headers: headersAdmin() })).json())[0];
  if (!neg?.nota_fiscal_asaas_id) return json({ ok: false, erro: "Este negócio não tem nota emitida pelo app." }, 400);
  const r = await sincronizarNotaDoAsaas(neg.nota_fiscal_asaas_id);
  if (!r.ok) return json({ ok: false, erro: r.erro }, 502);
  return json({ ok: true, status: r.status, email: r.email || null }, 200);
};
