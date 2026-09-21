const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Mesmos 7 itens do checklist manual (NEGOCIO_CHECKLIST_ITENS no index.html) — se a lista
// mudar lá, replicar aqui.
const CHECKLIST_CAMPOS = ["check_confirmacao", "check_contrato", "check_nota_fiscal", "check_contra_nota", "check_liberacao_embarque", "check_embarque_entrega", "check_pagamento"];

// Roda todo dia: qualquer negócio com data de pagamento já vencida e o item "Pagamento" do
// checklist ainda não marcado (check_pagamento = pagamento do comprador ao vendedor — NÃO é
// comissão da Nexus) passa a ser marcado sozinho, igual ao clique manual no ícone 💵 do
// checklist — inclusive fechando o negócio como "Finalizado" se for o último item pendente.
// Decisão do Álisson em 18/09/2026 (ajustada em 21/09 pra usar o campo certo — a primeira
// versão usava comissao_recebida_em, que é a comissão da corretora, não o pagamento do
// produtor).
export default async () => {
  const { SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }, 500);
  const adminHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

  const hojeISO = new Date().toISOString().slice(0, 10);

  const pendentesResp = await fetch(
    `${SUPABASE_URL}/rest/v1/nexus_negocios?deleted_at=is.null&check_pagamento=is.false&data_pagamento=not.is.null&data_pagamento=lt.${hojeISO}&select=id,numero_contrato,status,${CHECKLIST_CAMPOS.join(",")}`,
    { headers: adminHeaders }
  );
  const pendentes = await pendentesResp.json().catch(() => []);
  if (!Array.isArray(pendentes) || pendentes.length === 0) return json({ ok: true, marcados: 0 });

  const marcados = [];
  for (const n of pendentes) {
    const todosMarcados = CHECKLIST_CAMPOS.every(campo => (campo === "check_pagamento" ? true : n[campo]));
    const payload = { check_pagamento: true };
    if (todosMarcados && n.status !== "Finalizado") payload.status = "Finalizado";
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${n.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    });
    if (resp.ok) marcados.push(n.numero_contrato);
  }
  if (marcados.length === 0) return json({ ok: true, marcados: 0 });

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      negocio_id: null, tipo: "Pagamento marcado recebido (automático)",
      destinatarios: marcados.join(", "),
      enviado_por: null, sucesso: true, erro: null,
    }),
  }).catch(() => {});

  return json({ ok: true, marcados: marcados.length, contratos: marcados });
};

export const config = { schedule: "0 11 * * *" };
