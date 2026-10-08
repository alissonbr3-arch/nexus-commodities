import { hojeCampoGrande, limitesSemanaDe, somaDias, fmtDate, enviarResumosDePeriodo } from "./_resumo-corretor-lib.mjs";

// Toda sexta às 16:00 (Campo Grande): resumo da semana em andamento (segunda até hoje) pra cada
// corretor — só os negócios dele, comparação com o mesmo trecho da semana anterior, posição, meta
// do mês e conquistas.
export default async () => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return new Response(JSON.stringify({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }), { status: 500 });
  const hoje = hojeCampoGrande();
  const seg = limitesSemanaDe(hoje).inicio;
  const periodo = { inicio: seg, fim: hoje };
  const anterior = { inicio: somaDias(seg, -7), fim: somaDias(hoje, -7) };
  const r = await enviarResumosDePeriodo({ periodo, anterior, rotulo: `${fmtDate(periodo.inicio)} a ${fmtDate(periodo.fim)}`, mensal: false, tipo: "Resumo semanal do corretor" });
  return new Response(JSON.stringify({ ok: true, ...r }), { status: 200 });
};

export const config = { schedule: "0 20 * * 5" };
