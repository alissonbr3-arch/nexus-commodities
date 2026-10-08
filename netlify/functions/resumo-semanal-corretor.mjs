import { hojeCampoGrande, limitesSemanaDe, somaDias, fmtDate, enviarResumosDePeriodo } from "./_resumo-corretor-lib.mjs";

// Toda segunda às 07:30 (Campo Grande): resumo da semana que passou (segunda a domingo) pra cada
// corretor — só os negócios dele, comparação com a semana anterior, posição, meta do mês e
// conquistas — e o resumo da equipe pro proprietário.
export default async () => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return new Response(JSON.stringify({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }), { status: 500 });
  const hoje = hojeCampoGrande();
  const periodo = limitesSemanaDe(somaDias(hoje, -7)), anterior = limitesSemanaDe(somaDias(hoje, -14));
  const r = await enviarResumosDePeriodo({ periodo, anterior, rotulo: `${fmtDate(periodo.inicio)} a ${fmtDate(periodo.fim)}`, mensal: false, tipo: "Resumo semanal do corretor" });
  return new Response(JSON.stringify({ ok: true, ...r }), { status: 200 });
};

export const config = { schedule: "30 11 * * 1" };
