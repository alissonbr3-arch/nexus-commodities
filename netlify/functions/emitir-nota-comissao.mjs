const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";
const ASAAS_BASE_URL = "https://api.asaas.com/v3";

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function somenteDigitos(s) { return String(s || "").replace(/\D/g, ""); }
function erroAsaas(data, resp) { return data?.errors?.[0]?.description || data?.message || `Asaas retornou ${resp.status}`; }

// Status em que a nota ainda vale (em emissão ou emitida) — nesses não deixa emitir de novo.
const STATUS_VIVOS = ["SCHEDULED", "SYNCHRONIZED", "AUTHORIZED", "PROCESSING_CANCELLATION"];

// Emite a NFS-e da comissão de intermediação pelo Asaas (que fala com a prefeitura usando o
// certificado digital configurado lá). Uma nota por boleto: negócios cobrados juntos (mesmo
// boleto_comissao_id) saem numa nota só, com o valor total. Se já existe boleto, a nota fica
// ligada a ele (payment); senão sai avulsa pro cliente (customer). Código do serviço e alíquota
// de ISS vêm de Configurações > Nota fiscal. O número e o PDF chegam depois, pelo webhook do
// Asaas (INVOICE_AUTHORIZED) ou pela sincronização a cada 30 min. Só equipe Nexus pode chamar.
export default async (req) => {
  let payload;
  try { payload = await req.json(); } catch { return json({ ok: false, erro: "Corpo da requisição inválido." }, 400); }
  const { negocio_id, access_token } = payload || {};
  if (!negocio_id || !access_token) return json({ ok: false, erro: "Dados incompletos (negocio_id e access_token são obrigatórios)." }, 400);

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const asaasKey = process.env.ASAAS_API_KEY;
  if (!serviceKey) return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }, 500);
  if (!asaasKey) return json({ ok: false, erro: "ASAAS_API_KEY não configurada." }, 500);
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const asaasHeaders = { "Content-Type": "application/json", access_token: asaasKey };
  const patchHeaders = { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" };

  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` } });
  if (!userResp.ok) return json({ ok: false, erro: "Sessão inválida ou expirada." }, 401);
  const caller = await userResp.json();
  const staffResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?user_id=eq.${caller.id}&select=user_id`, { headers: adminHeaders });
  const staffRows = await staffResp.json();
  if (!Array.isArray(staffRows) || staffRows.length === 0) return json({ ok: false, erro: "Apenas corretores da equipe Nexus podem emitir notas." }, 403);

  const baseResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${negocio_id}&deleted_at=is.null&select=*`, { headers: adminHeaders });
  const base = (await baseResp.json())[0];
  if (!base) return json({ ok: false, erro: "Negócio não encontrado." }, 404);

  let negocios = [base];
  if (base.boleto_comissao_id) {
    const gResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?boleto_comissao_id=eq.${base.boleto_comissao_id}&deleted_at=is.null&select=*`, { headers: adminHeaders });
    const g = await gResp.json();
    if (Array.isArray(g) && g.length) negocios = g;
  }
  if (negocios.some(n => n.nota_fiscal_asaas_id && STATUS_VIVOS.includes(n.nota_fiscal_status))) {
    return json({ ok: false, erro: "Este negócio já tem uma nota fiscal emitida ou em emissão." }, 400);
  }
  if (negocios.some(n => !(Number(n.comissao) > 0))) return json({ ok: false, erro: "Um dos negócios não tem valor de comissão definido." }, 400);

  const cfgResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_config?id=eq.1&select=nfse_codigo_servico,nfse_nome_servico,nfse_aliquota_iss,nfse_iss_retido,nfse_texto_adicional`, { headers: adminHeaders });
  const cfg = (await cfgResp.json())[0] || {};
  if (!cfg.nfse_codigo_servico || !cfg.nfse_nome_servico || cfg.nfse_aliquota_iss == null) {
    return json({ ok: false, erro: "Preencha o código do serviço, o nome e a alíquota de ISS em Configurações > Nota fiscal antes de emitir." }, 400);
  }

  const pagadorIds = new Set(negocios.map(n => n.comissao_pagador === "Comprador" ? n.cliente_id : n.produtor_id));
  if (pagadorIds.size !== 1 || ![...pagadorIds][0]) return json({ ok: false, erro: "Os negócios têm pagadores diferentes ou sem pagador definido." }, 400);
  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=eq.${[...pagadorIds][0]}&select=id,nome,cpf,cnpj,email,telefone,asaas_customer_id`, { headers: adminHeaders });
  const pagador = (await cadResp.json())[0];
  if (!pagador) return json({ ok: false, erro: "Não encontrei o cadastro de quem paga a comissão." }, 400);
  const cpfCnpj = somenteDigitos(pagador.cpf || pagador.cnpj);
  if (!cpfCnpj) return json({ ok: false, erro: `Cadastre o CPF/CNPJ de ${pagador.nome} antes de emitir a nota.` }, 400);

  const valorTotal = Math.round(negocios.reduce((s, n) => s + Number(n.comissao), 0) * 100) / 100;
  const contratos = negocios.map(n => n.numero_contrato || "—").join(", ");
  const hojeBR = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

  const corpo = {
    // Mesmo padrão das notas emitidas à mão: contratos + dados bancários (texto em Configurações).
    serviceDescription: `Comissão de intermediação — ${negocios.length === 1 ? "Confirmação de Negócio" : "Confirmações de Negócio"} nº ${contratos}.${cfg.nfse_texto_adicional ? " " + cfg.nfse_texto_adicional : ""}`,
    observations: `Contrato(s): ${contratos}`,
    externalReference: negocios.map(n => n.id).join(","),
    value: valorTotal,
    deductions: 0,
    effectiveDate: hojeBR,
    municipalServiceCode: cfg.nfse_codigo_servico,
    municipalServiceName: cfg.nfse_nome_servico,
    taxes: { retainIss: !!cfg.nfse_iss_retido, iss: Number(cfg.nfse_aliquota_iss), pis: 0, cofins: 0, csll: 0, inss: 0, ir: 0 },
  };

  if (base.boleto_comissao_id) {
    corpo.payment = base.boleto_comissao_id;
  } else {
    let customerId = pagador.asaas_customer_id;
    if (!customerId) {
      const cResp = await fetch(`${ASAAS_BASE_URL}/customers`, {
        method: "POST", headers: asaasHeaders,
        body: JSON.stringify({ name: pagador.nome, cpfCnpj, email: pagador.email || undefined, mobilePhone: somenteDigitos(pagador.telefone) || undefined, externalReference: pagador.id }),
      });
      const c = await cResp.json().catch(() => ({}));
      if (!cResp.ok || !c.id) return json({ ok: false, erro: `Erro ao cadastrar ${pagador.nome} no Asaas: ${erroAsaas(c, cResp)}` }, 500);
      customerId = c.id;
      await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=eq.${pagador.id}`, { method: "PATCH", headers: patchHeaders, body: JSON.stringify({ asaas_customer_id: customerId }) });
    }
    corpo.customer = customerId;
  }

  const invResp = await fetch(`${ASAAS_BASE_URL}/invoices`, { method: "POST", headers: asaasHeaders, body: JSON.stringify(corpo) });
  const inv = await invResp.json().catch(() => ({}));
  if (!invResp.ok || !inv.id) {
    const msg = erroAsaas(inv, invResp);
    await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=in.(${negocios.map(n => n.id).join(",")})`, { method: "PATCH", headers: patchHeaders, body: JSON.stringify({ nota_fiscal_status: "ERROR", nota_fiscal_erro: msg }) });
    return json({ ok: false, erro: `Erro ao emitir a nota: ${msg}` }, 500);
  }

  // Pede pra emitir já, sem esperar a data agendada (se o Asaas já estiver processando, ignora).
  await fetch(`${ASAAS_BASE_URL}/invoices/${inv.id}/authorize`, { method: "POST", headers: asaasHeaders }).catch(() => {});

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=in.(${negocios.map(n => n.id).join(",")})`, {
    method: "PATCH", headers: patchHeaders,
    body: JSON.stringify({
      nota_fiscal_asaas_id: inv.id, nota_fiscal_status: inv.status || "SCHEDULED", nota_fiscal_erro: null,
      nota_fiscal_numero: inv.number ? String(inv.number) : null, nota_fiscal_url: inv.pdfUrl || null,
      nota_fiscal_emitida_em: inv.status === "AUTHORIZED" ? hojeBR : null,
    }),
  });

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST", headers: patchHeaders,
    body: JSON.stringify({ negocio_id: negocios[0].id, tipo: "Nota fiscal da comissão (Asaas)", destinatarios: `${pagador.nome} — contratos: ${contratos} — ${valorTotal}`, enviado_por: caller.id, sucesso: true, erro: null }),
  }).catch(() => {});

  return json({ ok: true, invoice_id: inv.id, status: inv.status, valorTotal, contratos }, 200);
};
