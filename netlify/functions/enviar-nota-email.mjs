import { enviarEmailDaNota, headersAdmin } from "./_nota-lib.mjs";

const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const ASAAS_BASE_URL = "https://api.asaas.com/v3";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";
function json(body, status) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }

// Botão "Enviar por e-mail" da nota emitida: (re)envia o PDF pro e-mail de cadastro de quem recebe
// a nota, quantas vezes precisar. O envio automático (1x, quando a nota é autorizada) está em _nota-lib.mjs.
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

  const neg = (await (await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${negocio_id}&select=nota_fiscal_asaas_id,nota_fiscal_status`, { headers: headersAdmin() })).json())[0];
  if (!neg?.nota_fiscal_asaas_id) return json({ ok: false, erro: "Este negócio não tem nota emitida pelo app." }, 400);
  const r = await fetch(`${ASAAS_BASE_URL}/invoices/${neg.nota_fiscal_asaas_id}`, { headers: { access_token: process.env.ASAAS_API_KEY } });
  const inv = await r.json().catch(() => ({}));
  if (!r.ok || !inv.id) return json({ ok: false, erro: inv.errors?.[0]?.description || `Asaas retornou ${r.status}` }, 502);
  if (inv.status !== "AUTHORIZED") return json({ ok: false, erro: "A nota ainda não foi autorizada pela prefeitura — só dá pra enviar depois." }, 400);
  const res = await enviarEmailDaNota(inv, { forcar: true, enviadoPor: caller.id });
  return res.ok ? json({ ok: true, destinatarios: res.destinatarios, comAnexo: res.comAnexo }, 200) : json({ ok: false, erro: res.erro }, 500);
};
