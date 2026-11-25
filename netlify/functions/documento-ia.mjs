// Documentos pela IA: o corretor joga um arquivo no painel, a IA (Claude) lê e diz o que é
// (confirmação, pagamento, NFP, contra nota, romaneio, liberação de embarque...) e de qual contrato;
// depois o painel manda salvar e este arquivo repassa pro Apps Script da conta da Nexus, que grava
// na pasta do contrato no Google Drive.
//   acao "ler"    → { access_token, base64, mime, nome_original, contratos: [...] }  → { ok, leitura }
//   acao "salvar" → { access_token, base64, mime, nome_arquivo, contrato, nome_pasta, data_negocio } → { ok, url, pasta }
// Variáveis no Netlify: ANTHROPIC_API_KEY, DRIVE_SCRIPT_URL, DRIVE_SCRIPT_TOKEN, SUPABASE_SERVICE_ROLE_KEY.

import { SUPABASE_URL, aplicarDocumentoNoNegocio, lerComIA, salvarNoDrive } from "./_documento-lib.mjs";

const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let corretorId = null;
async function corretorDaEquipe(accessToken) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return "SUPABASE_SERVICE_ROLE_KEY não configurada no Netlify.";
  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` } });
  if (!u.ok) return "Sessão inválida ou expirada. Entre de novo no painel.";
  const caller = await u.json();
  corretorId = caller.id;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?user_id=eq.${caller.id}&select=user_id`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? null : "Só corretores da equipe Nexus podem enviar documentos.";
}

async function ler(p) {
  const r = await lerComIA({ base64: p.base64, mime: p.mime, nomeOriginal: p.nome_original, contratos: p.contratos });
  return json(r, r.ok ? 200 : 502);
}

async function salvar(p, usuarioId) {
  const r = await salvarNoDrive(p);
  if (r.ok && p.negocio_id && p.leitura) r.feito = await aplicarDocumentoNoNegocio({ negocioId: p.negocio_id, leitura: p.leitura, nomeArquivo: r.nome, origem: "painel", usuarioId }).catch(e => [`⚠️ Não consegui atualizar o checklist (${e.message})`]);
  return json(r, r.ok ? 200 : 502);
}

export default async (req) => {
  let p;
  try { p = await req.json(); } catch { return json({ ok: false, erro: "Corpo da requisição inválido." }, 400); }
  if (!p?.access_token || !p?.base64 || !p?.mime) return json({ ok: false, erro: "Dados incompletos." }, 400);
  const negado = await corretorDaEquipe(p.access_token);
  if (negado) return json({ ok: false, erro: negado }, 403);
  if (p.acao === "ler") return ler(p);
  if (p.acao === "salvar") return salvar(p, corretorId);
  return json({ ok: false, erro: "Ação desconhecida." }, 400);
};
