const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";
const TIPO_LOG = "WhatsApp Preço do dia";
const INTERVALO_MIN_SEG = 20; // entre um envio e outro (proteção da conta do WhatsApp)
const LIMITE_POR_DIA = 80;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function formatarTelefoneWhats(telefone) {
  const digitos = String(telefone || "").replace(/\D/g, "");
  if (!digitos) return "";
  if (digitos.startsWith("55") && digitos.length >= 12) return digitos;
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  return digitos;
}

// Mesma regra do painel (index.html): pessoa física → primeiro nome; empresa/grupo → nome inteiro.
export function nomeParaSaudacao(nome) {
  const n = String(nome || "").trim();
  if (/\b(ltda|s\.?a\.?|eireli|me|epp|agro|agropecu\w*|grupo|cooperativa|fazendas?|comercio|comércio|cereais|armaz\w+)\b/i.test(n)) return n;
  const p = n.split(/\s+/)[0] || n;
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}
export function saudacaoAgora() {
  const h = Number(new Date().toLocaleString("en-GB", { timeZone: "America/Campo_Grande", hour: "2-digit", hour12: false }));
  return h < 12 ? "☀️ Bom dia" : h < 18 ? "🌤️ Boa tarde" : "🌙 Boa noite";
}

// Manda por WhatsApp (Z-API) a mensagem de preços pra UM cliente, escolhido na tela de preços
// (Mercado). Nada de disparo em massa: é um clique por cliente, com intervalo mínimo entre envios,
// limite por dia e sem repetir o mesmo cliente no dia (a menos que o corretor confirme o reenvio).
// Só corretores da equipe Nexus podem chamar.
export default async (req) => {
  let payload;
  try { payload = await req.json(); } catch { return json({ ok: false, erro: "Corpo da requisição inválido." }, 400); }
  const { cadastro_id, mensagem, access_token, forcar } = payload || {};
  if (!cadastro_id || !mensagem || !access_token) return json({ ok: false, erro: "Dados incompletos." }, 400);
  if (String(mensagem).length > 1500) return json({ ok: false, erro: "Mensagem muito longa." }, 400);

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN } = process.env;
  if (!serviceKey) return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }, 500);
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN) return json({ ok: false, erro: "Variáveis do Z-API não configuradas." }, 500);
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` } });
  if (!userResp.ok) return json({ ok: false, erro: "Sessão inválida ou expirada." }, 401);
  const caller = await userResp.json();
  const staff = await (await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?user_id=eq.${caller.id}&select=user_id`, { headers: adminHeaders })).json().catch(() => []);
  if (!Array.isArray(staff) || staff.length === 0) return json({ ok: false, erro: "Apenas corretores da equipe Nexus podem enviar." }, 403);

  const cad = (await (await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=eq.${encodeURIComponent(cadastro_id)}&select=id,nome,telefone`, { headers: adminHeaders })).json().catch(() => []))[0];
  if (!cad) return json({ ok: false, erro: "Cliente não encontrado." }, 404);
  const telefone = formatarTelefoneWhats(cad.telefone);
  if (!telefone) return json({ ok: false, erro: `Cadastre o telefone de ${cad.nome} antes de enviar.` }, 400);

  // Limites: intervalo entre envios, total do dia e repetição no mesmo dia.
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Campo_Grande" });
  const logs = await (await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log?tipo=eq.${encodeURIComponent(TIPO_LOG)}&sucesso=eq.true&created_at=gte.${encodeURIComponent(hoje + "T00:00:00-04:00")}&select=destinatarios,created_at&order=created_at.desc&limit=500`, { headers: adminHeaders })).json().catch(() => []);
  const lista = Array.isArray(logs) ? logs : [];
  if (lista.length >= LIMITE_POR_DIA) return json({ ok: false, erro: `Limite de ${LIMITE_POR_DIA} envios por dia atingido (protege a conta do WhatsApp). Continue amanhã.` }, 429);
  if (lista[0]) {
    const seg = (Date.now() - new Date(lista[0].created_at).getTime()) / 1000;
    if (seg < INTERVALO_MIN_SEG) return json({ ok: false, erro: `Aguarde ${Math.ceil(INTERVALO_MIN_SEG - seg)}s antes do próximo envio.`, aguardar: Math.ceil(INTERVALO_MIN_SEG - seg) }, 429);
  }
  if (!forcar && lista.some(l => String(l.destinatarios).startsWith(`cadastro:${cad.id} `))) {
    return json({ ok: false, jaEnviado: true, erro: `${cad.nome} já recebeu o preço hoje.` }, 409);
  }

  const texto = String(mensagem).replace(/\{\{SAUDACAO\}\}/g, saudacaoAgora()).replace(/\{\{NOME\}\}/g, nomeParaSaudacao(cad.nome));

  let erro = null;
  try {
    const resp = await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`, {
      method: "POST", headers: { "Content-Type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN },
      body: JSON.stringify({ phone: telefone, message: texto }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || j.error) erro = j.error || j.message || `Z-API retornou ${resp.status}`;
  } catch (e) { erro = String(e.message || e); }

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST", headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ negocio_id: null, tipo: TIPO_LOG, destinatarios: `cadastro:${cad.id} ${cad.nome} (${telefone})`, enviado_por: caller.id, sucesso: !erro, erro }),
  }).catch(() => {});

  if (erro) return json({ ok: false, erro: `Não consegui enviar pelo WhatsApp da Nexus: ${erro}. Se a conta estiver restrita, use "Abrir no WhatsApp" pra mandar do seu celular.` }, 502);
  return json({ ok: true, telefone });
};
