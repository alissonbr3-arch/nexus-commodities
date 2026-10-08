import { hojeCampoGrande, limitesMesDe, somaDias, nomeMes, enviarResumosDePeriodo } from "./_resumo-corretor-lib.mjs";

// Todo dia 1º às 08:00 (Campo Grande): fechamento do mês que passou pra cada corretor — só os
// negócios dele, comparação com o mês anterior, posição, meta batida ou não e conquistas — e o
// resumo da equipe pro proprietário.
export default async () => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return new Response(JSON.stringify({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }), { status: 500 });
  const hoje = hojeCampoGrande();
  const periodo = limitesMesDe(somaDias(limitesMesDe(hoje).inicio, -1));
  const anterior = limitesMesDe(somaDias(periodo.inicio, -1));
  const r = await enviarResumosDePeriodo({ periodo, anterior, rotulo: nomeMes(periodo.inicio), mensal: true, tipo: "Resumo mensal do corretor" });
  return new Response(JSON.stringify({ ok: true, ...r }), { status: 200 });
};

export const config = { schedule: "0 12 1 * *" };
