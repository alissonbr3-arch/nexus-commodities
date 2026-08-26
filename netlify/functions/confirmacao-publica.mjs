import { montarConfirmacaoHtml } from "./_confirmacao-lib.mjs";

const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function paginaErro(msg) {
  return htmlResponse(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#333">
  <p style="font-size:15px">${msg}</p></body></html>`, 404);
}

// Página pública (sem login) que mostra a Confirmação de Negócio em formato pronto pra
// impressão/PDF — o link é mandado pro produtor via WhatsApp (comando /confirmacao). A
// segurança é o próprio id do negócio (uuid, não é possível adivinhar/enumerar).
export default async (req) => {
  const url = new URL(req.url);
  const negocioId = url.searchParams.get("id");
  if (!negocioId) return paginaErro("Link inválido.");

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return paginaErro("Serviço indisponível no momento. Tente de novo mais tarde.");
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${encodeURIComponent(negocioId)}&select=*`, { headers: adminHeaders });
  const negRows = await negResp.json().catch(() => []);
  const n = negRows[0];
  if (!n) return paginaErro("Não encontrei essa Confirmação de Negócio.");

  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${n.produtor_id},${n.cliente_id})&select=*`, { headers: adminHeaders });
  const cads = await cadResp.json().catch(() => []);
  const vendedor = cads.find(c => c.id === n.produtor_id);
  const comprador = cads.find(c => c.id === n.cliente_id);
  if (!vendedor || !comprador) return paginaErro("Este negócio ainda não tem comprador e produtor cadastrados.");

  let fazenda = null;
  if (n.fazenda_id) {
    const fazResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_fazendas?id=eq.${n.fazenda_id}&select=*`, { headers: adminHeaders });
    const fazRows = await fazResp.json().catch(() => []);
    fazenda = fazRows[0] || null;
  }

  const cfgResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_config?id=eq.1&select=fundersul_saca,fundems_saca,funrural_pct`, { headers: adminHeaders });
  const cfgRows = await cfgResp.json().catch(() => []);
  const config = cfgRows[0] || {};

  const r = montarConfirmacaoHtml(n, vendedor, comprador, fazenda, config);
  if (!r) return paginaErro("Não consegui gerar a Confirmação deste negócio.");
  return htmlResponse(r.html);
};
