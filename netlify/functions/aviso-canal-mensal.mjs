const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

function formatarTelefoneWhats(telefone) {
  const digitos = String(telefone || "").replace(/\D/g, "");
  if (!digitos) return "";
  if (digitos.startsWith("55") && digitos.length >= 12) return digitos;
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  return digitos;
}

async function enviarWhatsapp({ instanceId, token, clientToken, telefone, mensagem }) {
  const resp = await fetch(`https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Token": clientToken },
    body: JSON.stringify({ phone: telefone, message: mensagem }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) throw new Error(data.error || data.message || `Z-API retornou ${resp.status}`);
  return data;
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
export default async () => {
  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }), { status: 500 });
  }
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN) {
    return new Response(JSON.stringify({ ok: false, erro: "Variáveis do Z-API não configuradas." }), { status: 200 });
  }
  const zapi = { instanceId: ZAPI_INSTANCE_ID, token: ZAPI_TOKEN, clientToken: ZAPI_CLIENT_TOKEN };
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

  let sucessos = 0;
  const erros = [];
  for (const telefone of telefones) {
    try {
      await enviarWhatsapp({ ...zapi, telefone, mensagem: MENSAGEM_CANAL });
      sucessos++;
    } catch (e) {
      erros.push(`${telefone}: ${e.message || e}`);
    }
  }

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      negocio_id: null, tipo: "WhatsApp Aviso Canal Mensal", destinatarios: telefones.join(", "),
      enviado_por: null, sucesso: sucessos > 0, erro: erros.join("; ") || null,
    }),
  }).catch(() => {});

  return new Response(JSON.stringify({ ok: true, telefones: telefones.length, sucessos, falhas: erros.length }), { status: 200 });
};

export const config = { schedule: "0 11 15 * *" };
