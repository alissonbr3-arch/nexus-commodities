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
function fmtMoney(v) { return "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Mesma conta de preço líquido usada no resto do app.
function aplicaFundersulFundems(comprador) {
  return !comprador || (comprador.categoria_comprador !== "Cooperativa" && comprador.categoria_comprador !== "Cerealista");
}
function precoLiquidoNegocio(n, comprador, config) {
  const sacas = Number(n.quantidade || 0);
  const total = Number(n.preco || 0) * sacas;
  const senar = total * 0.002;
  const comFundersulFundems = aplicaFundersulFundems(comprador);
  const fundersulTotal = comFundersulFundems ? Number(config.fundersul_saca || 0) * sacas : 0;
  const fundemsTotal = comFundersulFundems ? Number(config.fundems_saca || 0) * sacas : 0;
  const funruralForma = n.funrural_forma || "Comercialização";
  const funrural = funruralForma === "Comercialização" ? total * Number(config.funrural_pct || 0) / 100 : 0;
  const comissaoDoVendedor = n.comissao_pagador === "Comprador" ? 0 : Number(n.comissao || 0);
  const liquidoEstimado = total - comissaoDoVendedor - senar - fundersulTotal - fundemsTotal - funrural;
  const informado = n.preco_liquido != null && n.preco_liquido !== "";
  return informado ? Number(n.preco_liquido) : (sacas ? liquidoEstimado / sacas : 0);
}

const MESES_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

// Roda todo dia 1º do mês: manda pra cada produtor (por WhatsApp) o resumo dos negócios dele
// que já foram fechados/entregues mas ainda não foram marcados como Pago — mesma ideia do
// /extrato (sob demanda), só que enviado sozinho, uma vez por mês, só com o que está em aberto.
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

  const [negResp, cfgResp] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?status=in.(Fechado,Entregue)&deleted_at=is.null&select=*`, { headers: adminHeaders }),
    fetch(`${SUPABASE_URL}/rest/v1/nexus_config?id=eq.1&select=fundersul_saca,fundems_saca,funrural_pct`, { headers: adminHeaders }),
  ]);
  const negocios = await negResp.json();
  const cfgRows = await cfgResp.json().catch(() => []);
  const config = cfgRows[0] || {};

  if (!Array.isArray(negocios) || negocios.length === 0) {
    return new Response(JSON.stringify({ ok: true, produtores: 0, negocios: 0 }), { status: 200 });
  }

  const idsProdutores = [...new Set(negocios.map(n => n.produtor_id).filter(Boolean))];
  const idsCompradores = [...new Set(negocios.map(n => n.cliente_id).filter(Boolean))];
  const idsCadastros = [...new Set([...idsProdutores, ...idsCompradores])];
  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${idsCadastros.join(",")})&select=id,nome,tipo,telefone,telefones_extra,categoria_comprador`, { headers: adminHeaders });
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

    const linhas = negs.map(n => {
      const comprador = cadastrosPorId.get(n.cliente_id);
      const precoLiquido = precoLiquidoNegocio(n, comprador, config);
      const nomeComprador = comprador ? comprador.nome : (n.contraparte || "—");
      return `• ${n.numero_contrato || "—"} — ${n.grao || ""}${n.safra ? " " + n.safra : ""} — ${fmtNum(n.quantidade)} sc — ${n.status || "—"}\n   ${nomeComprador} · Líquido: ${fmtMoney(precoLiquido)}/sc`;
    }).join("\n\n");
    const totalSacas = negs.reduce((s, n) => s + Number(n.quantidade || 0), 0);
    const mensagem = `📅 Relatório mensal — Negócios em aberto (${mesLabel})\n\nOlá, ${produtor.nome}! Segue o resumo dos seus negócios já fechados que ainda não foram concluídos (pagamento pendente):\n\n${linhas}\n\n— — —\nTotal: ${negs.length} negócio${negs.length === 1 ? "" : "s"} · ${fmtNum(totalSacas)} sc\n\nQualquer dúvida, fale com seu corretor.`;

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
