import { atualizarCotacoes } from "./_cotacoes-lib.mjs";

// Roda sozinha a cada hora (dias úteis, horário de pregão do CBOT + margem).
export default async () => {
  const resultado = await atualizarCotacoes();
  return new Response(JSON.stringify(resultado), {
    status: resultado.ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = {
  schedule: "0 11-23 * * 1-5",
};
