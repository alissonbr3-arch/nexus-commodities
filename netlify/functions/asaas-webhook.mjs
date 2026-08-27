const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Recebe o webhook de cobrança do Asaas (configurado no painel deles, aba Webhooks) e, quando
// um boleto de comissão é pago, atualiza o negócio sozinho — mesmo efeito de clicar em "Marcar
// como pago" na aba Comissões. Protegido pelo token que o Asaas manda no header
// "asaas-access-token" (configurado como Token de Autenticação lá no cadastro do webhook).
export default async (req) => {
  const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ASAAS_WEBHOOK_TOKEN || req.headers.get("asaas-access-token") !== ASAAS_WEBHOOK_TOKEN) {
    return json({ ok: false }, 401);
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }, 500);
  const adminHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

  let evento;
  try { evento = await req.json(); } catch { return json({ ok: true }); }

  const tipo = evento.event;
  const pagamento = evento.payment;
  if (!pagamento?.id) return json({ ok: true, ignorado: true });

  // Um boleto pode ter sido gerado agrupando vários negócios (mesmo pagador) — todos eles têm
  // o mesmo boleto_comissao_id, então o pagamento precisa atualizar todos de uma vez, não só
  // o primeiro que aparecer.
  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?boleto_comissao_id=eq.${pagamento.id}&select=id`, { headers: adminHeaders });
  const negRows = await negResp.json().catch(() => []);
  if (!Array.isArray(negRows) || negRows.length === 0) return json({ ok: true, ignorado: true });

  const patch = { boleto_comissao_status: pagamento.status };
  if (tipo === "PAYMENT_RECEIVED" || tipo === "PAYMENT_CONFIRMED") {
    patch.status = "Pago";
    patch.comissao_recebida_em = pagamento.paymentDate || pagamento.clientPaymentDate || new Date().toISOString().slice(0, 10);
  }

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?boleto_comissao_id=eq.${pagamento.id}`, {
    method: "PATCH",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });

  return json({ ok: true });
};
