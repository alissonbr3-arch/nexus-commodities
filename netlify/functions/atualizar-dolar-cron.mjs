import { atualizarDolar } from "./_cotacoes-lib.mjs";

// Só o dólar, a cada 5 minutos no horário comercial (8h–18h de Brasília, dias úteis). A rotina
// de hora em hora das cotações também atualiza o dólar, mas uma vez por hora deixava o painel
// parado — e na rodada das 8h o Yahoo ainda devolve o fechamento anterior (variação 0,00).
export default async () => {
  const resultado = await atualizarDolar();
  return new Response(JSON.stringify(resultado), {
    status: resultado.ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = {
  schedule: "*/5 11-21 * * 1-5",
};
