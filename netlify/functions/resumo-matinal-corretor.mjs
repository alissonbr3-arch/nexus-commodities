import { carregarBase, hojeCampoGrande, formatarTelefoneWhats, montarMatinal, enfileirar, registrarLog } from "./_resumo-corretor-lib.mjs";

// Roda todo dia às 07:00 (Campo Grande): manda pro WhatsApp de cada corretor o resumo do dia dos
// negócios DELE — pagamentos de hoje, embarques, pendências vencidas, comissões a receber dos
// clientes, produtores da carteira parados e a meta do mês. Só manda se houver algo a avisar.
// Negócio sem corretor vai pro proprietário. Entra na fila (1 mensagem a cada 3 min) e não repete
// no mesmo dia.
export default async () => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return new Response(JSON.stringify({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }), { status: 500 });
  const hoje = hojeCampoGrande();
  const base = await carregarBase();
  const msgs = [], semTelefone = [];
  for (const e of base.equipe) {
    const mensagem = montarMatinal(base, e, hoje);
    if (!mensagem) continue;
    const telefone = formatarTelefoneWhats(e.telefone);
    if (!telefone) { semTelefone.push(e.nome); continue; }
    msgs.push({ telefone, mensagem });
  }
  const enfileirados = await enfileirar(msgs, "Resumo matinal do corretor", hoje);
  if (enfileirados || semTelefone.length) await registrarLog("WhatsApp Resumo matinal do corretor", enfileirados, semTelefone);
  return new Response(JSON.stringify({ ok: true, enfileirados, semTelefone }), { status: 200 });
};

export const config = { schedule: "0 11 * * *" };
