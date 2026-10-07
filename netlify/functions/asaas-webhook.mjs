const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

// Campos da nota fiscal no negócio a partir do objeto invoice do Asaas (webhook ou consulta direta).
function patchDaNota(inv) {
  const patch = { nota_fiscal_status: inv.status };
  if (inv.number) patch.nota_fiscal_numero = String(inv.number);
  if (inv.pdfUrl) patch.nota_fiscal_url = inv.pdfUrl;
  if (inv.status === "AUTHORIZED") {
    patch.nota_fiscal_emitida_em = inv.effectiveDate || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    patch.nota_fiscal_erro = null;
  }
  if (inv.status === "ERROR") patch.nota_fiscal_erro = inv.statusDescription || "Erro na emissão da nota — veja o detalhe no painel do Asaas.";
  return patch;
}

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

  // Eventos de nota fiscal (INVOICE_AUTHORIZED, INVOICE_ERROR...): atualiza o negócio dono da nota.
  if (String(tipo).startsWith("INVOICE_") && evento.invoice?.id) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?nota_fiscal_asaas_id=eq.${evento.invoice.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(patchDaNota(evento.invoice)),
    });
    if (!r.ok) console.log("asaas-webhook: falha ao gravar nota", evento.invoice.id, r.status, await r.text());
    return json({ ok: true });
  }

  const pagamento = evento.payment;
  if (!pagamento?.id) return json({ ok: true, ignorado: true });

  // Um boleto pode ter sido gerado agrupando vários negócios (mesmo pagador) — todos eles têm
  // o mesmo boleto_comissao_id, então o pagamento precisa atualizar todos de uma vez, não só
  // o primeiro que aparecer.
  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?boleto_comissao_id=eq.${pagamento.id}&select=id`, { headers: adminHeaders });
  const negRows = await negResp.json().catch(() => []);
  if (!Array.isArray(negRows) || negRows.length === 0) return json({ ok: true, ignorado: true });

  // Sempre guarda o status atual do boleto (PENDING, OVERDUE, RECEIVED...). Quando o pagamento
  // entra, marca a comissão como recebida — mesmo efeito de "Marcar como pago" em Comissões.
  // IMPORTANTE: NÃO mexer no campo status do negócio — o banco só aceita Negociação/Fechado/
  // Finalizado, e tentar gravar "Pago" ali fazia a atualização inteira falhar em silêncio.
  const statusResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?boleto_comissao_id=eq.${pagamento.id}`, {
    method: "PATCH",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ boleto_comissao_status: pagamento.status }),
  });
  if (!statusResp.ok) console.log("asaas-webhook: falha ao gravar status do boleto", pagamento.id, statusResp.status, await statusResp.text());

  if (tipo === "PAYMENT_RECEIVED" || tipo === "PAYMENT_CONFIRMED") {
    const dataPgto = pagamento.paymentDate || pagamento.clientPaymentDate || new Date().toISOString().slice(0, 10);
    const recResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?boleto_comissao_id=eq.${pagamento.id}&comissao_recebida_em=is.null`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ comissao_recebida_em: dataPgto }),
    });
    if (!recResp.ok) console.log("asaas-webhook: falha ao marcar comissão recebida", pagamento.id, recResp.status, await recResp.text());
  }

  return json({ ok: true });
};
