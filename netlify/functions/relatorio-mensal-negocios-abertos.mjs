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

function fmtNum(v) { return Number(v || 0).toLocaleString("pt-BR"); }

const MESES_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

// Roda todo dia 1º do mês: manda pra cada produtor (por WhatsApp) o link do Relatório de
// Negócios em Aberto dele (relatorio-mensal-publico.mjs — mesmo template visual do
// "Relatório de Negócios" do menu Relatórios), com os negócios Fechado/Entregue que ainda
// não foram marcados como Pago.
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

  const agora = new Date();
  const mesLabel = `${MESES_PT[agora.getMonth()]} de ${agora.getFullYear()}`;

  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?status=in.(Fechado,Entregue)&deleted_at=is.null&select=id,produtor_id,quantidade`, { headers: adminHeaders });
  const negocios = await negResp.json();
  if (!Array.isArray(negocios) || negocios.length === 0) {
    return new Response(JSON.stringify({ ok: true, produtores: 0, negocios: 0 }), { status: 200 });
  }

  const idsProdutores = [...new Set(negocios.map(n => n.produtor_id).filter(Boolean))];
  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${idsProdutores.join(",")})&select=id,nome,telefone,telefones_extra`, { headers: adminHeaders });
  const cads = await cadResp.json();
  const cadastrosPorId = new Map(cads.map(c => [c.id, c]));

  const negociosPorProdutor = new Map();
  for (const n of negocios) {
    if (!n.produtor_id) continue;
    if (!negociosPorProdutor.has(n.produtor_id)) negociosPorProdutor.set(n.produtor_id, []);
    negociosPorProdutor.get(n.produtor_id).push(n);
  }

  let produtoresAvisados = 0;
  for (const [produtorId, negs] of negociosPorProdutor) {
    const produtor = cadastrosPorId.get(produtorId);
    const telefones = [...new Set([produtor?.telefone, ...(produtor?.telefones_extra || [])].map(formatarTelefoneWhats).filter(Boolean))];
    if (telefones.length === 0) continue;

    const totalSacas = negs.reduce((s, n) => s + Number(n.quantidade || 0), 0);
    const link = `https://painel.nexuscommoditiesms.com.br/.netlify/functions/relatorio-mensal-publico?id=${produtorId}`;
    const mensagem = `📅 Relatório mensal — Negócios em aberto (${mesLabel})\n\nOlá, ${produtor.nome}! Você tem ${negs.length} negócio${negs.length === 1 ? "" : "s"} em aberto (${fmtNum(totalSacas)} sc), já fechado${negs.length === 1 ? "" : "s"} mas ainda não pago${negs.length === 1 ? "" : "s"}.\n\nConfira o relatório completo (dá pra salvar como PDF):\n${link}\n\nQualquer dúvida, fale com seu corretor.`;

    let algumSucesso = false;
    const erros = [];
    for (const telefone of telefones) {
      try {
        await enviarWhatsapp({ ...zapi, telefone, mensagem });
        algumSucesso = true;
      } catch (e) {
        erros.push(`${telefone}: ${e.message || e}`);
      }
    }
    if (algumSucesso) produtoresAvisados++;
    await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        negocio_id: negs[0].id, tipo: "WhatsApp Relatório Mensal", destinatarios: `${telefones.join(", ")} — ${produtor.nome} (${negs.length} negócios)`,
        enviado_por: null, sucesso: algumSucesso, erro: erros.join("; ") || null,
      }),
    }).catch(() => {});
  }

  return new Response(JSON.stringify({ ok: true, produtores: produtoresAvisados, negocios: negocios.length }), { status: 200 });
};

export const config = { schedule: "0 11 1 * *" };
