const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

function formatarTelefoneWhats(telefone) {
  const digitos = String(telefone || "").replace(/\D/g, "");
  if (!digitos) return "";
  if (digitos.startsWith("55") && digitos.length >= 12) return digitos;
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  return digitos;
}
const fmtMoney = v => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = v => Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const fmtDate = iso => { const [y, m, d] = String(iso).split("-"); return `${d}/${m}/${y}`; };

export function montarMensagem(corretor, itens, dataISO) {
  const primeiroNome = String(corretor.nome || "").split(" ")[0] || "";
  const linhas = itens.map(i => `• *${i.contrato}* — ${i.produtor}${i.comprador ? ` (comprador: ${i.comprador})` : ""}\n   ${i.grao}${i.quantidade ? ` · ${fmtNum(i.quantidade)} sc` : ""} · comissão ${fmtMoney(i.comissao)}`);
  const total = itens.reduce((s, i) => s + i.comissao, 0);
  return `☀️ Bom dia, ${primeiroNome}!\n\nPagamentos agendados para *hoje* (${fmtDate(dataISO)}):\n\n${linhas.join("\n")}\n\n${itens.length > 1 ? `Comissão total desses pagamentos: *${fmtMoney(total)}*\n\n` : ""}Quando o comprador pagar, marque o pagamento como recebido no painel.\n\n*Nexus Commodities*`;
}

// Roda todo dia de manhã (07:30, horário de Campo Grande): manda pro WhatsApp de cada corretor
// os pagamentos agendados pra hoje dos negócios dele que ainda não foram marcados como pagos
// (o mesmo que aparece em vermelho na Agenda). Negócio sem corretor vai pro proprietário.
// Entra na fila (nexus_whatsapp_fila, 1 mensagem a cada 3 min) em vez de mandar direto, e não
// repete se a função rodar duas vezes no mesmo dia. Sem pagamento no dia, não manda nada.
export default async () => {
  const { SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_SERVICE_ROLE_KEY) return new Response(JSON.stringify({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }), { status: 500 });
  const adminHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const jsonHeaders = { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" };
  const get = async path => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: adminHeaders }); const j = await r.json().catch(() => []); return Array.isArray(j) ? j : []; };

  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Campo_Grande" });
  const negocios = await get(`nexus_negocios?deleted_at=is.null&data_pagamento=eq.${hoje}&or=(check_pagamento.is.null,check_pagamento.eq.false)&select=id,numero_contrato,grao,safra,quantidade,comissao,corretor_id,produtor_id,cliente_id,contraparte&order=numero_contrato.asc`);
  if (negocios.length === 0) return new Response(JSON.stringify({ ok: true, pagamentos: 0 }), { status: 200 });

  const equipe = await get("nexus_equipe?select=user_id,nome,cargo,telefone&order=ordem.asc");
  const proprietario = equipe.find(e => /propriet/i.test(e.cargo || "")) || equipe[0];
  const idsCad = [...new Set(negocios.flatMap(n => [n.produtor_id, n.cliente_id]).filter(Boolean))];
  const cads = idsCad.length ? await get(`nexus_cadastros?id=in.(${idsCad.join(",")})&select=id,nome`) : [];
  const nomeDe = id => (cads.find(c => c.id === id) || {}).nome || "";

  const porCorretor = new Map();
  for (const n of negocios) {
    const corretor = equipe.find(e => e.user_id === n.corretor_id) || proprietario;
    if (!corretor) continue;
    if (!porCorretor.has(corretor.user_id)) porCorretor.set(corretor.user_id, { corretor, itens: [] });
    porCorretor.get(corretor.user_id).itens.push({
      contrato: n.numero_contrato || "—", grao: `${n.grao || ""}${n.safra ? " " + n.safra : ""}`.trim() || "—",
      produtor: nomeDe(n.produtor_id) || "—", comprador: nomeDe(n.cliente_id) || n.contraparte || "",
      quantidade: Number(n.quantidade || 0), comissao: Number(n.comissao || 0),
    });
  }

  // Evita repetir se já enfileirou hoje.
  const inicioDia = `${hoje}T00:00:00-04:00`;
  const jaEnfileirados = await get(`nexus_whatsapp_fila?tipo=eq.Pagamentos do dia&criado_em=gte.${encodeURIComponent(inicioDia)}&select=telefone`);
  const jaTel = new Set(jaEnfileirados.map(f => f.telefone));

  const novos = [], semTelefone = [];
  for (const { corretor, itens } of porCorretor.values()) {
    const telefone = formatarTelefoneWhats(corretor.telefone);
    if (!telefone) { semTelefone.push(corretor.nome); continue; }
    if (jaTel.has(telefone)) continue;
    novos.push({ telefone, mensagem: montarMensagem(corretor, itens, hoje), tipo: "Pagamentos do dia" });
  }
  if (novos.length) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/nexus_whatsapp_fila`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(novos) });
    if (!r.ok) return new Response(JSON.stringify({ ok: false, erro: `Falha ao enfileirar (status ${r.status}).` }), { status: 500 });
  }
  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({
      negocio_id: null, tipo: "WhatsApp Pagamentos do dia (corretor)", destinatarios: novos.map(n => n.telefone).join(", ") || "—",
      enviado_por: null, sucesso: semTelefone.length === 0,
      erro: semTelefone.length ? `Corretor sem telefone cadastrado em Equipe: ${semTelefone.join(", ")}` : null,
    }),
  }).catch(() => {});

  return new Response(JSON.stringify({ ok: true, pagamentos: negocios.length, enfileirados: novos.length, semTelefone }), { status: 200 });
};

export const config = { schedule: "30 11 * * *" };
