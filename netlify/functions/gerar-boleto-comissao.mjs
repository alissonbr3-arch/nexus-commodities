const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";
const ASAAS_BASE_URL = "https://api.asaas.com/v3";

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function somenteDigitos(s) { return String(s || "").replace(/\D/g, ""); }

function formatarTelefoneWhats(telefone) {
  const digitos = somenteDigitos(telefone);
  if (!digitos) return "";
  if (digitos.startsWith("55") && digitos.length >= 12) return digitos;
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  return digitos;
}

function fmtMoney(v) { return "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

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

// Gera (ou reaproveita) um boleto no Asaas cobrando a comissão de intermediação de um ou mais
// negócios de uma vez (todos precisam ter o mesmo pagador — mesma pessoa/empresa) de quem for
// o pagador (Vendedor ou Comprador, conforme cadastrado em cada negócio). Cria o cliente no
// Asaas na primeira vez (guarda o id em nexus_cadastros.asaas_customer_id pra reaproveitar
// depois) e manda o link do boleto pro WhatsApp do pagador. Só corretores da equipe Nexus
// podem chamar.
export default async (req) => {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, erro: "Corpo da requisição inválido." }, 400);
  }
  const { negocio_ids, access_token, vencimento } = payload || {};
  if (!Array.isArray(negocio_ids) || negocio_ids.length === 0 || !access_token) {
    return json({ ok: false, erro: "Dados incompletos (negocio_ids e access_token são obrigatórios)." }, 400);
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const asaasKey = process.env.ASAAS_API_KEY;
  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN } = process.env;
  if (!serviceKey) return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }, 500);
  if (!asaasKey) return json({ ok: false, erro: "ASAAS_API_KEY não configurada nas variáveis de ambiente do Netlify." }, 500);
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const asaasHeaders = { "Content-Type": "application/json", access_token: asaasKey };

  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` },
  });
  if (!userResp.ok) return json({ ok: false, erro: "Sessão inválida ou expirada." }, 401);
  const caller = await userResp.json();

  const staffResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?user_id=eq.${caller.id}&select=user_id`, { headers: adminHeaders });
  const staffRows = await staffResp.json();
  if (!Array.isArray(staffRows) || staffRows.length === 0) {
    return json({ ok: false, erro: "Apenas corretores da equipe Nexus podem gerar boletos." }, 403);
  }

  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=in.(${negocio_ids.join(",")})&select=*`, { headers: adminHeaders });
  const negocios = await negResp.json();
  if (!Array.isArray(negocios) || negocios.length !== negocio_ids.length) {
    return json({ ok: false, erro: "Não encontrei um ou mais negócios selecionados." }, 404);
  }
  if (negocios.some(n => !(Number(n.comissao) > 0))) {
    return json({ ok: false, erro: "Um dos negócios selecionados não tem valor de comissão definido." }, 400);
  }

  const idsCadastros = [...new Set(negocios.flatMap(n => [n.produtor_id, n.cliente_id]))].filter(Boolean);
  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${idsCadastros.join(",")})&select=id,nome,cpf,cnpj,email,telefone,telefones_extra,asaas_customer_id,grupo_id`, { headers: adminHeaders });
  const cads = await cadResp.json();

  const pagadorIds = new Set();
  for (const n of negocios) {
    const pagadorId = n.comissao_pagador === "Comprador" ? n.cliente_id : n.produtor_id;
    if (!pagadorId) return json({ ok: false, erro: `O negócio ${n.numero_contrato || n.id} não tem quem paga a comissão definido.` }, 400);
    pagadorIds.add(pagadorId);
  }
  if (pagadorIds.size > 1) {
    return json({ ok: false, erro: "Os negócios selecionados têm pagadores diferentes — só dá pra agrupar num boleto só quando é a mesma pessoa/empresa pagando." }, 400);
  }
  const pagador = cads.find(c => c.id === [...pagadorIds][0]);
  if (!pagador) return json({ ok: false, erro: "Não encontrei o cadastro de quem paga a comissão." }, 400);

  const cpfCnpj = somenteDigitos(pagador.cpf || pagador.cnpj);
  if (!cpfCnpj) return json({ ok: false, erro: `Cadastre o CPF/CNPJ de ${pagador.nome} antes de gerar o boleto.` }, 400);

  let customerId = pagador.asaas_customer_id;
  if (!customerId) {
    const custResp = await fetch(`${ASAAS_BASE_URL}/customers`, {
      method: "POST",
      headers: asaasHeaders,
      body: JSON.stringify({
        name: pagador.nome,
        cpfCnpj,
        email: pagador.email || undefined,
        mobilePhone: somenteDigitos(pagador.telefone) || undefined,
        externalReference: pagador.id,
      }),
    });
    const custData = await custResp.json().catch(() => ({}));
    if (!custResp.ok || !custData.id) {
      const msg = custData.errors?.[0]?.description || custData.message || `Asaas retornou ${custResp.status}`;
      return json({ ok: false, erro: `Erro ao cadastrar ${pagador.nome} no Asaas: ${msg}` }, 500);
    }
    customerId = custData.id;
    await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=eq.${pagador.id}`, {
      method: "PATCH",
      headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ asaas_customer_id: customerId }),
    });
  }

  const valorTotal = negocios.reduce((s, n) => s + Number(n.comissao), 0);
  const contratos = negocios.map(n => n.numero_contrato || "—").join(", ");
  const dueDate = vencimento || new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const descricao = negocios.length === 1
    ? `Comissão de intermediação — Confirmação de Negócio nº ${contratos} — Nexus Commodities`
    : `Comissão de intermediação — Confirmações de Negócio nº ${contratos} — Nexus Commodities`;
  const payResp = await fetch(`${ASAAS_BASE_URL}/payments`, {
    method: "POST",
    headers: asaasHeaders,
    body: JSON.stringify({
      customer: customerId,
      billingType: "BOLETO",
      value: valorTotal,
      dueDate,
      description: descricao,
      externalReference: negocio_ids.join(","),
    }),
  });
  const payData = await payResp.json().catch(() => ({}));
  if (!payResp.ok || !payData.id) {
    const msg = payData.errors?.[0]?.description || payData.message || `Asaas retornou ${payResp.status}`;
    return json({ ok: false, erro: `Erro ao gerar o boleto: ${msg}` }, 500);
  }

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=in.(${negocio_ids.join(",")})`, {
    method: "PATCH",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      boleto_comissao_id: payData.id,
      boleto_comissao_url: payData.invoiceUrl,
      boleto_comissao_status: payData.status,
      boleto_comissao_vencimento: payData.dueDate,
    }),
  });

  let whatsapp = { tentado: false, sucesso: false };
  const telefones = await telefonesComGrupo(pagador, adminHeaders);
  if (telefones.length && ZAPI_INSTANCE_ID && ZAPI_TOKEN && ZAPI_CLIENT_TOKEN) {
    whatsapp.tentado = true;
    const mensagem = negocios.length === 1
      ? `Olá, ${pagador.nome}! Aqui é da Nexus Commodities.\n\nSegue o boleto da comissão de intermediação referente à Confirmação de Negócio nº ${contratos}:\nValor: ${fmtMoney(valorTotal)}\nVencimento: ${dueDate.split("-").reverse().join("/")}\n\n${payData.invoiceUrl}\n\nQualquer dúvida, fale com seu corretor.`
      : `Olá, ${pagador.nome}! Aqui é da Nexus Commodities.\n\nSegue o boleto agrupado da comissão de intermediação referente às Confirmações de Negócio nº ${contratos}:\nValor total: ${fmtMoney(valorTotal)}\nVencimento: ${dueDate.split("-").reverse().join("/")}\n\n${payData.invoiceUrl}\n\nQualquer dúvida, fale com seu corretor.`;
    for (const telefone of telefones) {
      try {
        const resp = await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN },
          body: JSON.stringify({ phone: telefone, message: mensagem }),
        });
        if (resp.ok) whatsapp.sucesso = true;
      } catch {}
    }
  }

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      negocio_id: negocio_ids[0], tipo: "Boleto Comissão (Asaas)",
      destinatarios: `${telefones.join(", ") || pagador.email || pagador.nome} — contratos: ${contratos}`,
      enviado_por: caller.id, sucesso: true, erro: null,
    }),
  }).catch(() => {});

  return json({ ok: true, url: payData.invoiceUrl, status: payData.status, dueDate, valorTotal, whatsapp }, 200);
};
