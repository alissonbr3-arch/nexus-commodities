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

async function registrarLog(adminHeaders, { negocio_id, tipo, destinatarios, sucesso, erro }) {
  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ negocio_id, tipo, destinatarios, enviado_por: null, sucesso, erro }),
  }).catch(() => {});
}

async function marcarEnviado(adminHeaders, negocioId, campo) {
  await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${negocioId}`, {
    method: "PATCH",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ [campo]: true }),
  });
}

async function processarLote({ negocios, cadastrosPorId, campoData, campoFlag, tipoLog, montarMensagem, zapi, adminHeaders }) {
  for (const n of negocios) {
    const produtor = cadastrosPorId.get(n.produtor_id);
    const telefone = formatarTelefoneWhats(produtor?.telefone);
    if (!telefone) {
      await registrarLog(adminHeaders, { negocio_id: n.id, tipo: tipoLog, destinatarios: produtor?.telefone || "(sem telefone)", sucesso: false, erro: "Produtor sem telefone cadastrado." });
      continue;
    }
    try {
      await enviarWhatsapp({ ...zapi, telefone, mensagem: montarMensagem(n, produtor) });
      await registrarLog(adminHeaders, { negocio_id: n.id, tipo: tipoLog, destinatarios: telefone, sucesso: true, erro: null });
    } catch (e) {
      await registrarLog(adminHeaders, { negocio_id: n.id, tipo: tipoLog, destinatarios: telefone, sucesso: false, erro: String(e.message || e) });
      continue;
    }
    await marcarEnviado(adminHeaders, n.id, campoFlag);
  }
}

// Roda todo dia de manhã: avisa produtores por WhatsApp (Z-API) no dia do pagamento
// e no dia de início do embarque dos negócios em aberto. Idempotente via flags em nexus_negocios.
export default async () => {
  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }), { status: 500 });
  }
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !ZAPI_CLIENT_TOKEN) {
    return new Response(JSON.stringify({ ok: false, erro: "Variáveis do Z-API não configuradas (ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN)." }), { status: 200 });
  }
  const zapi = { instanceId: ZAPI_INSTANCE_ID, token: ZAPI_TOKEN, clientToken: ZAPI_CLIENT_TOKEN };
  const adminHeaders = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Campo_Grande" });

  const [pagResp, embResp] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?data_pagamento=eq.${hoje}&whatsapp_aviso_pagamento_enviado=eq.false&select=*`, { headers: adminHeaders }),
    fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?data_inicio_embarque=eq.${hoje}&whatsapp_aviso_embarque_enviado=eq.false&select=*`, { headers: adminHeaders }),
  ]);
  const negociosPagamento = await pagResp.json();
  const negociosEmbarque = await embResp.json();

  const idsProdutores = [...new Set([...negociosPagamento, ...negociosEmbarque].map(n => n.produtor_id).filter(Boolean))];
  const cadastrosPorId = new Map();
  if (idsProdutores.length) {
    const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${idsProdutores.join(",")})&select=id,nome,telefone`, { headers: adminHeaders });
    const cads = await cadResp.json();
    for (const c of cads) cadastrosPorId.set(c.id, c);
  }

  await processarLote({
    negocios: negociosPagamento, cadastrosPorId, campoFlag: "whatsapp_aviso_pagamento_enviado", tipoLog: "WhatsApp Aviso de Pagamento", zapi, adminHeaders,
    montarMensagem: (n, p) => `Olá, ${p.nome}! Aqui é da Nexus Commodities. Hoje é a data de pagamento do seu negócio ${n.numero_contrato ? `nº ${n.numero_contrato} ` : ""}(${n.grao}${n.safra ? " " + n.safra : ""}, ${n.quantidade} sc). Qualquer dúvida, fale com seu corretor.`,
  });

  await processarLote({
    negocios: negociosEmbarque, cadastrosPorId, campoFlag: "whatsapp_aviso_embarque_enviado", tipoLog: "WhatsApp Aviso de Embarque", zapi, adminHeaders,
    montarMensagem: (n, p) => `Olá, ${p.nome}! Aqui é da Nexus Commodities. Hoje inicia o período de embarque do seu negócio ${n.numero_contrato ? `nº ${n.numero_contrato} ` : ""}(${n.grao}${n.safra ? " " + n.safra : ""}). Por favor, providencie a nota fiscal e demais documentos necessários.`,
  });

  return new Response(JSON.stringify({ ok: true, pagamento: negociosPagamento.length, embarque: negociosEmbarque.length }), { status: 200 });
};

export const config = { schedule: "0 11 * * *" };
