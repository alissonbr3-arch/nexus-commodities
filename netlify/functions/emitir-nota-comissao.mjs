const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";
const ASAAS_BASE_URL = "https://api.asaas.com/v3";

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function somenteDigitos(s) { return String(s || "").replace(/\D/g, ""); }
function semAcento(t) { return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

// CEP de uma fazenda: um CEP REAL do município, preferindo os de rodovia/estrada (rural) e, se não
// houver, o menor CEP da cidade. (O Portal Nacional valida o CEP no Correios e recusa "-000"
// genérico que não exista lá — E0240 —, como o 79490-000 de São Gabriel do Oeste.)
async function cepRuralDoMunicipio(cidade, uf) {
  const norm = t => semAcento(t).toLowerCase().trim();
  const buscar = async (termo) => {
    try {
      const l = await (await fetch(`https://viacep.com.br/ws/${uf}/${encodeURIComponent(semAcento(cidade))}/${termo}/json/`)).json();
      return (Array.isArray(l) ? l : []).filter(x => x.cep && norm(x.localidade) === norm(cidade));
    } catch { return []; }
  };
  for (const termos of [["Rodovia", "Estrada"], ["Avenida", "Rua"]]) {
    const achados = (await Promise.all(termos.map(buscar))).flat().map(x => String(x.cep).replace(/\D/g, "")).sort();
    if (achados.length) return achados[0];
  }
  return null;
}
function parseMunicipioUf(str) {
  const m = String(str || "").trim().match(/^(.*?)\s*[\/\-–]\s*([A-Za-z]{2})$/);
  return m ? { cidade: m[1].trim(), uf: m[2].toUpperCase() } : { cidade: String(str || "").trim(), uf: "MS" };
}
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
  const fazendaEscolhida = typeof payload?.fazenda_id === "string" ? payload.fazenda_id : null; // id da fazenda, "cadastro" ou nada
  const extraIds = [...new Set((Array.isArray(payload?.negocio_ids_extras) ? payload.negocio_ids_extras : []).filter(x => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x) && x !== negocio_id))];
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
  let notaAvulsa = false;
  if (extraIds.length) {
    // Vários negócios do mesmo pagador numa nota só. Se algum tem boleto próprio, a nota sai avulsa
    // (em nome do cliente, sem ligação com um boleto específico). "Mesmo pagador" é conferido abaixo.
    const eResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=in.(${extraIds.join(",")})&deleted_at=is.null&select=*`, { headers: adminHeaders });
    const extras = await eResp.json().catch(() => []);
    if (!Array.isArray(extras) || extras.length !== extraIds.length) return json({ ok: false, erro: "Algum dos negócios selecionados não foi encontrado." }, 404);
    const jaNoGrupo = new Set(negocios.map(n => n.id));
    negocios = [...negocios, ...extras.filter(n => !jaNoGrupo.has(n.id))];
    notaAvulsa = new Set(negocios.map(n => n.boleto_comissao_id || "")).size > 1;
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
  if ([...pagadorIds].some(x => !x)) return json({ ok: false, erro: "Algum negócio está sem pagador definido." }, 400);
  const tomadorId = typeof payload?.tomador_id === "string" && /^[0-9a-f-]{36}$/i.test(payload.tomador_id) ? payload.tomador_id : null;
  const idsCad = [...new Set([...pagadorIds, ...(tomadorId ? [tomadorId] : [])])];
  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${idsCad.join(",")})&select=id,nome,tipo,cidade,cpf,cnpj,email,telefone,asaas_customer_id,cep,endereco,endereco_numero,complemento,bairro,inscricao_estadual,grupo_id`, { headers: adminHeaders });
  const cads = await cadResp.json().catch(() => []);
  if (!Array.isArray(cads) || cads.length !== idsCad.length) return json({ ok: false, erro: "Não encontrei o cadastro de quem paga a comissão." }, 400);
  // Vários pagadores (ou tomador escolhido diferente do pagador) só se forem todos do mesmo grupo.
  let tomadorDiferente = false;
  let pagador;
  if (pagadorIds.size === 1 && (!tomadorId || tomadorId === [...pagadorIds][0])) {
    pagador = cads.find(c => c.id === [...pagadorIds][0]);
  } else {
    const grupos = new Set(cads.map(c => c.grupo_id || ""));
    if (grupos.size !== 1 || !cads[0].grupo_id) return json({ ok: false, erro: "Os negócios têm pagadores diferentes que não são do mesmo grupo." }, 400);
    pagador = tomadorId ? cads.find(c => c.id === tomadorId) : null;
    if (!pagador) return json({ ok: false, erro: "Escolha em nome de quem a nota vai sair (os negócios são de pagadores diferentes do grupo)." }, 400);
    tomadorDiferente = true;
  }
  if (!pagador) return json({ ok: false, erro: "Não encontrei o cadastro de quem paga a comissão." }, 400);
  // Nota em nome de outro membro do grupo não pode ficar ligada ao boleto do pagador original.
  if (tomadorDiferente) notaAvulsa = true;
  const cpfCnpj = somenteDigitos(pagador.cpf || pagador.cnpj);
  if (!cpfCnpj) return json({ ok: false, erro: `Cadastre o CPF/CNPJ de ${pagador.nome} antes de emitir a nota.` }, 400);

  // A prefeitura exige endereço completo do tomador — sem isso a nota volta com "Erro na emissão".
  // Produtor sem endereço próprio: usa a fazenda (rua = nome da fazenda, zona rural, CEP rural do
  // município da fazenda).
  let endCep = somenteDigitos(pagador.cep), endRua = pagador.endereco, endNum = pagador.endereco_numero, endBairro = pagador.bairro, endComplemento = pagador.complemento || "";
  // A fazenda escolhida no painel dá o endereço (rua = nome da fazenda, zona rural, CEP rural do
  // município) e a inscrição estadual da nota. "cadastro" = usa o endereço do próprio cadastro.
  let fazenda = null;
  if (pagador.tipo === "Produtor" && fazendaEscolhida !== "cadastro") {
    // Fazendas do tomador (primeiro) e, se ele é de um grupo, as dos outros membros.
    let donos = [pagador.id];
    if (pagador.grupo_id) {
      const gResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?grupo_id=eq.${pagador.grupo_id}&select=id`, { headers: adminHeaders });
      const g = await gResp.json().catch(() => []);
      donos = [pagador.id, ...(Array.isArray(g) ? g.map(x => x.id).filter(id => id !== pagador.id) : [])];
    }
    const fResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_fazendas?produtor_id=in.(${donos.join(",")})&select=id,nome,municipio_uf,inscricao_estadual,produtor_id`, { headers: adminHeaders });
    const fazendas = await fResp.json().catch(() => []);
    const lista = (Array.isArray(fazendas) ? fazendas : []).sort((a, b) => donos.indexOf(a.produtor_id) - donos.indexOf(b.produtor_id));
    if (fazendaEscolhida) {
      fazenda = lista.find(f => f.id === fazendaEscolhida) || null;
      if (!fazenda) return json({ ok: false, erro: "A fazenda escolhida não pertence a este produtor nem ao grupo dele." }, 400);
    } else if (endCep.length !== 8 || !endRua || !endNum || !endBairro) {
      fazenda = lista.find(f => f.id === base.fazenda_id) || lista[0] || null;
    }
  }
  if (fazenda) {
    endRua = fazenda.nome; endNum = "S/N"; endBairro = "Zona Rural";
    const { cidade, uf } = parseMunicipioUf(fazenda.municipio_uf || pagador.cidade);
    endCep = (await cepRuralDoMunicipio(cidade, uf)) || "";
    endComplemento = "";
  }
  let ieNota = String((fazenda ? fazenda.inscricao_estadual : pagador.inscricao_estadual) || "").trim();
  if (/^[\d.\-\/ ]+$/.test(ieNota)) ieNota = ieNota.replace(/\s+/g, ""); // "28.437.513- 6" -> "28.437.513-6"
  const ieAsaas = /^[\d.\-\/ ]+$/.test(ieNota) ? ieNota.replace(/\D/g, "") : ieNota;
  const faltando = [endCep.length === 8 ? null : "CEP", endRua ? null : "rua", endNum ? null : "número", endBairro ? null : "bairro"].filter(Boolean);
  if (faltando.length) return json({ ok: false, erro: `Complete o endereço de ${pagador.nome} em Cadastros antes de emitir (faltando: ${faltando.join(", ")}).` }, 400);
  const enderecoAsaas = { postalCode: endCep, address: endRua, addressNumber: endNum, complement: endComplemento || undefined, 
    // A DANFSe monta o endereço do tomador como "rua, número, complemento, bairro". A inscrição
    // estadual vai no fim do bairro pra aparecer logo depois do endereço: "..., Zona Rural - IE 28.123.456-7".
    province: `${endBairro}${ieNota ? ` - IE ${ieNota}` : ""}`.slice(0, 60) };

  const valorTotal = Math.round(negocios.reduce((s, n) => s + Number(n.comissao), 0) * 100) / 100;
  const contratos = negocios.map(n => n.numero_contrato || "—").join(", ");
  const hojeBR = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

  const corpo = {
    // Mesmo padrão das notas emitidas à mão: contratos + dados bancários (texto em Configurações).
    serviceDescription: `Comissão de intermediação — ${negocios.length === 1 ? "Confirmação de Negócio" : "Confirmações de Negócio"} nº ${contratos}.${cfg.nfse_texto_adicional ? " " + cfg.nfse_texto_adicional : ""}`,
    observations: `Contrato(s): ${contratos}${fazenda ? ` — ${/^fazenda/i.test(fazenda.nome) ? "" : "Fazenda "}${fazenda.nome}` : ""}${ieNota ? ` — Inscrição Estadual ${ieNota}` : ""}`,
    externalReference: `nexus:${contratos}`.slice(0, 100), // o Asaas aceita no máximo 100 caracteres; a nota é achada pelo nota_fiscal_asaas_id
    value: valorTotal,
    deductions: 0,
    effectiveDate: hojeBR,
    municipalServiceCode: cfg.nfse_codigo_servico,
    municipalServiceName: cfg.nfse_nome_servico,
    // IBS/CBS (Reforma Tributária) — mesmos códigos das notas emitidas à mão no Portal Nacional:
    // NBS 1.1806.40.00, CST 000 (tributação integral), cClassTrib 000001 e indicador de operação
    // 030103. As alíquotas (IBS estadual 0,10% + CBS 0,90% em 2026) o Asaas calcula pela classificação.
    taxes: {
      retainIss: !!cfg.nfse_iss_retido, iss: Number(cfg.nfse_aliquota_iss), pis: 0, cofins: 0, csll: 0, inss: 0, ir: 0,
      nbsCode: "1.1806.40.00", taxSituationCode: "000", taxClassificationCode: "000001", operationIndicatorCode: "030103",
    },
  };

  // Garante o cliente no Asaas com o endereço atualizado (a nota, com ou sem boleto, usa esse cadastro).
  let customerId = pagador.asaas_customer_id;
  if (!customerId) {
    const cResp = await fetch(`${ASAAS_BASE_URL}/customers`, {
      method: "POST", headers: asaasHeaders,
      body: JSON.stringify({ name: pagador.nome, cpfCnpj, email: pagador.email || undefined, mobilePhone: somenteDigitos(pagador.telefone) || undefined, externalReference: pagador.id, stateInscription: ieAsaas || undefined, ...enderecoAsaas }),
    });
    const c = await cResp.json().catch(() => ({}));
    if (!cResp.ok || !c.id) return json({ ok: false, erro: `Erro ao cadastrar ${pagador.nome} no Asaas: ${erroAsaas(c, cResp)}` }, 500);
    customerId = c.id;
    await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=eq.${pagador.id}`, { method: "PATCH", headers: patchHeaders, body: JSON.stringify({ asaas_customer_id: customerId }) });
  } else {
    const uResp = await fetch(`${ASAAS_BASE_URL}/customers/${customerId}`, { method: "PUT", headers: asaasHeaders, body: JSON.stringify({ ...enderecoAsaas, ...(ieAsaas ? { stateInscription: ieAsaas } : {}) }) });
    if (!uResp.ok) {
      const u = await uResp.json().catch(() => ({}));
      return json({ ok: false, erro: `Erro ao atualizar o endereço de ${pagador.nome} no Asaas: ${erroAsaas(u, uResp)}` }, 500);
    }
  }
  if (base.boleto_comissao_id && !notaAvulsa) corpo.payment = base.boleto_comissao_id; else corpo.customer = customerId;

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
      nota_fiscal_asaas_id: inv.id, nota_fiscal_status: inv.status || "SCHEDULED", nota_fiscal_erro: null, nota_fiscal_tomador_id: pagador.id,
      // nota nova (ex.: depois de cancelar a anterior): o e-mail dela tem que sair de novo
      nota_fiscal_email_enviado_em: null, nota_fiscal_email_erro: null,
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
