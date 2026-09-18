const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Roda todo dia: qualquer negócio com data de pagamento já vencida e comissão ainda marcada
// como "a receber" passa a ser marcada como recebida automaticamente (mesmo campo que o
// toggle manual em Financeiro/Comissões usa — comissao_recebida_em = hoje). Decisão do
// Álisson em 18/09/2026, depois de encontrar 16 contratos vencidos desde 01/09 que ainda
// apareciam como "A RECEBER" no relatório do cliente.
export default async () => {
  const { SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }, 500);
  const adminHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

  const hojeISO = new Date().toISOString().slice(0, 10);

  const pendentesResp = await fetch(
    `${SUPABASE_URL}/rest/v1/nexus_negocios?deleted_at=is.null&comissao_recebida_em=is.null&data_pagamento=not.is.null&data_pagamento=lt.${hojeISO}&select=id,numero_contrato`,
    { headers: adminHeaders }
  );
  const pendentes = await pendentesResp.json().catch(() => []);
  if (!Array.isArray(pendentes) || pendentes.length === 0) return json({ ok: true, marcados: 0 });

  const updResp = await fetch(
    `${SUPABASE_URL}/rest/v1/nexus_negocios?id=in.(${pendentes.map(n => n.id).join(",")})`,
    {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ comissao_recebida_em: hojeISO }),
    }
  );
  if (!updResp.ok) return json({ ok: false, erro: `Falha ao atualizar (status ${updResp.status}).` }, 500);

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      negocio_id: null, tipo: "Comissão marcada recebida (automático)",
      destinatarios: pendentes.map(n => n.numero_contrato).join(", "),
      enviado_por: null, sucesso: true, erro: null,
    }),
  }).catch(() => {});

  return json({ ok: true, marcados: pendentes.length, contratos: pendentes.map(n => n.numero_contrato) });
};

export const config = { schedule: "0 11 * * *" };
