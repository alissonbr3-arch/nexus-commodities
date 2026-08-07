import { atualizarCotacoes } from "./_cotacoes-lib.mjs";

// Invocável manualmente (botão "Atualizar agora" na tela de Cotações).
export default async () => {
  const resultado = await atualizarCotacoes();
  return new Response(JSON.stringify(resultado), {
    status: resultado.ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
};
