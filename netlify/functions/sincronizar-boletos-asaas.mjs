import { sincronizarNotaDoAsaas } from "./_nota-lib.mjs";

const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const ASAAS_BASE_URL = "https://api.asaas.com/v3";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const STATUS_PAGOS = ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"];

// Rede de segurança do webhook do Asaas: a cada 30 minutos pergunta direto ao Asaas o status dos
// boletos de comissão que ainda estão como "a receber" no painel. Se algum já foi pago, marca a
// comissão como recebida (comissao_recebida_em) e guarda o status do boleto — assim o painel
// atualiza sozinho mesmo se o webhook não estiver configurado ou tiver falhado. Só consulta o que
// está pendente; sem boleto em aberto, não faz nenhuma chamada ao Asaas.
export default async () => {
  const { SUPABASE_SERVICE_ROLE_KEY, ASAAS_API_KEY } = process.env;
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }, 500);
  if (!ASAAS_API_KEY) return json({ ok: false, erro: "ASAAS_API_KEY não configurada." }, 500);
  const adminHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

  const pendResp = await fetch(
    `${SUPABASE_URL}/rest/v1/nexus_negocios?deleted_at=is.null&boleto_comissao_id=not.is.null&comissao_recebida_em=is.null&select=boleto_comissao_id,boleto_comissao_status`,
    { headers: adminHeaders }
  );
  const pendentesRaw = await pendResp.json().catch(() => []);
  const pendentes = Array.isArray(pendentesRaw) ? pendentesRaw : [];

  const boletos = new Map();
  for (const n of pendentes) boletos.set(n.boleto_comissao_id, n.boleto_comissao_status);

  const pagos = [], atualizados = [], falhas = [];
  for (const [boletoId, statusAtual] of boletos) {
    try {
      const resp = await fetch(`${ASAAS_BASE_URL}/payments/${boletoId}`, { headers: { access_token: ASAAS_API_KEY } });
      const pg = await resp.json().catch(() => ({}));
      if (!resp.ok || !pg.status) { falhas.push(`${boletoId}: ${pg.errors?.[0]?.description || resp.status}`); continue; }

      const alvo = `${SUPABASE_URL}/rest/v1/nexus_negocios?boleto_comissao_id=eq.${boletoId}`;
      const headers = { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" };
      if (pg.status !== statusAtual) {
        await fetch(alvo, { method: "PATCH", headers, body: JSON.stringify({ boleto_comissao_status: pg.status }) });
        atualizados.push(`${boletoId}: ${statusAtual} → ${pg.status}`);
      }
      if (STATUS_PAGOS.includes(pg.status)) {
        const dataPgto = pg.paymentDate || pg.clientPaymentDate || new Date().toISOString().slice(0, 10);
        const r = await fetch(`${alvo}&comissao_recebida_em=is.null`, { method: "PATCH", headers, body: JSON.stringify({ comissao_recebida_em: dataPgto }) });
        if (r.ok) pagos.push(boletoId); else falhas.push(`${boletoId}: não consegui marcar como recebida (${r.status})`);
      }
    } catch (e) {
      falhas.push(`${boletoId}: ${String(e.message || e)}`);
    }
  }

  if (pagos.length) {
    await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        negocio_id: null, tipo: "Boleto de comissão pago (sincronização Asaas)",
        destinatarios: pagos.join(", "), enviado_por: null, sucesso: true, erro: falhas.join("; ") || null,
      }),
    }).catch(() => {});
  }
  if (falhas.length) console.log("sincronizar-boletos-asaas falhas:", falhas.join(" | "));

  // Notas fiscais ainda em emissão: pergunta direto ao Asaas (rede de segurança do webhook de nota).
  const notasResp = await fetch(
    `${SUPABASE_URL}/rest/v1/nexus_negocios?deleted_at=is.null&nota_fiscal_asaas_id=not.is.null&nota_fiscal_status=in.(SCHEDULED,SYNCHRONIZED,PROCESSING_CANCELLATION)&select=nota_fiscal_asaas_id`,
    { headers: adminHeaders }
  );
  const notasRaw = await notasResp.json().catch(() => []);
  const notasIds = [...new Set((Array.isArray(notasRaw) ? notasRaw : []).map(n => n.nota_fiscal_asaas_id))];
  const notasAtualizadas = [];
  for (const invId of notasIds) {
    try {
      const r = await sincronizarNotaDoAsaas(invId);
      if (r.ok) notasAtualizadas.push(`${invId}: ${r.status}${r.email && r.email.destinatarios ? " (e-mail enviado)" : ""}`);
      else falhas.push(`nota ${invId}: ${r.erro}`);
    } catch (e) { falhas.push(`nota ${invId}: ${String(e.message || e)}`); }
  }

  return json({ ok: true, consultados: boletos.size, pagos: pagos.length, atualizados, notasAtualizadas, falhas });
};

export const config = { schedule: "*/30 * * * *" };
