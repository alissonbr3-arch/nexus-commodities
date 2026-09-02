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

// Telefones de um cadastro E de todos os outros cadastros do mesmo grupo dele (ex: sócios da
// mesma propriedade) — sem duplicar. Sem grupo, é só o telefone do próprio cadastro mesmo.
async function telefonesComGrupo(cadastro, adminHeaders) {
  if (!cadastro) return [];
  let membros = [cadastro];
  if (cadastro.grupo_id) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?grupo_id=eq.${cadastro.grupo_id}&select=telefone,telefones_extra`, { headers: adminHeaders });
    const rows = await resp.json().catch(() => []);
    if (Array.isArray(rows) && rows.length) membros = rows;
  }
  return [...new Set(membros.flatMap(m => [m.telefone, ...(m.telefones_extra || [])]).map(formatarTelefoneWhats).filter(Boolean))];
}

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
  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${idsProdutores.join(",")})&select=id,nome,telefone,telefones_extra,grupo_id`, { headers: adminHeaders });
  const cads = await cadResp.json();
  const cadastrosPorId = new Map(cads.map(c => [c.id, c]));

  // Agrupa por grupo_id quando o produtor faz parte de um grupo (ex: sócios da mesma
  // propriedade) — pra mandar UMA mensagem só e UM relatório consolidado pro grupo todo, em
  // vez de um relatório picado por pessoa. Sem grupo, a chave é o próprio produtor_id.
  const bucketsPorChave = new Map();
  for (const n of negocios) {
    if (!n.produtor_id) continue;
    const produtor = cadastrosPorId.get(n.produtor_id);
    const chave = produtor?.grupo_id || n.produtor_id;
    if (!bucketsPorChave.has(chave)) bucketsPorChave.set(chave, { grupoId: produtor?.grupo_id || null, negocios: [], produtorIds: new Set() });
    const bucket = bucketsPorChave.get(chave);
    bucket.negocios.push(n);
    bucket.produtorIds.add(n.produtor_id);
  }

  let produtoresAvisados = 0;
  for (const bucket of bucketsPorChave.values()) {
    const produtoresDoBucket = [...bucket.produtorIds].map(id => cadastrosPorId.get(id)).filter(Boolean);
    const primeiroProdutor = produtoresDoBucket[0];
    if (!primeiroProdutor) continue;
    const telefones = await telefonesComGrupo(primeiroProdutor, adminHeaders);
    if (telefones.length === 0) continue;

    const isGrupo = !!bucket.grupoId;
    const nomes = produtoresDoBucket.map(p => p.nome).join(", ");
    const totalSacas = bucket.negocios.reduce((s, n) => s + Number(n.quantidade || 0), 0);
    const link = isGrupo
      ? `https://painel.nexuscommoditiesms.com.br/.netlify/functions/relatorio-mensal-publico?grupo=${bucket.grupoId}`
      : `https://painel.nexuscommoditiesms.com.br/.netlify/functions/relatorio-mensal-publico?id=${primeiroProdutor.id}`;
    const saudacao = isGrupo ? `Olá, ${nomes}!` : `Olá, ${primeiroProdutor.nome}!`;
    const pronome = isGrupo ? "vocês têm" : "você tem";
    const mensagem = `📅 Relatório mensal — Negócios em aberto (${mesLabel})\n\n${saudacao} ${pronome} ${bucket.negocios.length} negócio${bucket.negocios.length === 1 ? "" : "s"} em aberto (${fmtNum(totalSacas)} sc), já fechado${bucket.negocios.length === 1 ? "" : "s"} mas ainda não pago${bucket.negocios.length === 1 ? "" : "s"}.\n\nConfira o relatório completo (dá pra salvar como PDF):\n${link}\n\nQualquer dúvida, fale com seu corretor.`;

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
    if (algumSucesso) produtoresAvisados += produtoresDoBucket.length;
    await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        negocio_id: bucket.negocios[0].id, tipo: "WhatsApp Relatório Mensal", destinatarios: `${telefones.join(", ")} — ${nomes} (${bucket.negocios.length} negócios)`,
        enviado_por: null, sucesso: algumSucesso, erro: erros.join("; ") || null,
      }),
    }).catch(() => {});
  }

  return new Response(JSON.stringify({ ok: true, produtores: produtoresAvisados, negocios: negocios.length }), { status: 200 });
};

export const config = { schedule: "0 11 1 * *" };
