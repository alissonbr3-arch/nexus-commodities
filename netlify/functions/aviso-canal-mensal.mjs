const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

function formatarTelefoneWhats(telefone) {
  const digitos = String(telefone || "").replace(/\D/g, "");
  if (!digitos) return "";
  if (digitos.startsWith("55") && digitos.length >= 12) return digitos;
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  return digitos;
}

// Lista de comandos igual à do /ajuda do bot (whatsapp-webhook.mjs) — se um comando for
// adicionado/removido de lá, atualizar aqui também.
const MENSAGEM_CANAL = `📲 *Canal Nexus Commodities no WhatsApp*

Olá! Passando pra lembrar que você pode falar com a Nexus por aqui, a qualquer hora, usando estes comandos:

*/extrato* — lista todas as suas negociações com a Nexus
*/confirmacao [nº do contrato]* — link da Confirmação de Negócio, pronta pra salvar em PDF
*/pagamento* — seus pagamentos em aberto (ainda não recebidos)
*/embarque* — suas janelas de embarque/entrega pendentes
*/ajuda* — mostra essa lista de comandos de novo, quando precisar

É só digitar o comando aqui mesmo, nesta conversa. Qualquer dúvida, fale com seu corretor.

*Nexus Commodities*
São Gabriel do Oeste/MS`;

// Roda todo dia 15 do mês: lembra todos os produtores cadastrados (com telefone) de que dá
// pra usar o WhatsApp da Nexus pra tirar dúvida sozinho, com a lista de comandos disponíveis.
// Não depende de negócio nenhum — é só lembrete de canal, então manda uma vez por telefone
// único (sem repetir se o mesmo número aparecer em mais de um cadastro/grupo).
// NÃO manda direto (mandar ~120 mensagens de uma vez foi o que derrubou a conta em restrição
// do WhatsApp em 15/09/2026) — só enfileira em nexus_whatsapp_fila. Quem manda de fato, um
// telefone a cada 3 minutos, é o processar-fila-whatsapp.mjs.
export default async () => {
  const { SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }), { status: 500 });
  }
  const adminHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?tipo=eq.Produtor&select=telefone,telefones_extra`, { headers: adminHeaders });
  const produtores = await cadResp.json().catch(() => []);
  if (!Array.isArray(produtores) || produtores.length === 0) {
    return new Response(JSON.stringify({ ok: true, telefones: 0 }), { status: 200 });
  }

  const telefones = [...new Set(produtores.flatMap(p => [p.telefone, ...(p.telefones_extra || [])]).map(formatarTelefoneWhats).filter(Boolean))];
  if (telefones.length === 0) {
    return new Response(JSON.stringify({ ok: true, telefones: 0 }), { status: 200 });
  }

  const filaResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_whatsapp_fila`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(telefones.map(telefone => ({ telefone, mensagem: MENSAGEM_CANAL, tipo: "Aviso Canal Mensal" }))),
  });
  if (!filaResp.ok) {
    return new Response(JSON.stringify({ ok: false, erro: `Falha ao enfileirar (status ${filaResp.status}).` }), { status: 500 });
  }

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      negocio_id: null, tipo: "WhatsApp Aviso Canal Mensal", destinatarios: telefones.join(", "),
      enviado_por: null, sucesso: true, erro: `${telefones.length} mensagens enfileiradas — envio gradual a 1 a cada 3 minutos`,
    }),
  }).catch(() => {});

  return new Response(JSON.stringify({ ok: true, enfileirados: telefones.length }), { status: 200 });
};

export const config = { schedule: "0 11 15 * *" };
