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

function preencherTemplate(template, n, p) {
  return String(template || "")
    .replace(/\{\{NOME\}\}/g, p.nome || "")
    .replace(/\{\{CONTRATO\}\}/g, n.numero_contrato || "—")
    .replace(/\{\{GRAO\}\}/g, n.grao || "")
    .replace(/\{\{SAFRA\}\}/g, n.safra || "")
    .replace(/\{\{QUANTIDADE\}\}/g, n.quantidade || "");
}

async function registrarLog(adminHeaders, { negocio_id, tipo, destinatarios, sucesso, erro }) {
  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ negocio_id, tipo, destinatarios, enviado_por: null, sucesso, erro }),
  }).catch(() => {});
}

// Pagamento em parcelas (pagamentos_extra): lista [{ parcela, data, quantidade, idxExtra }] na mesma leitura da
// Agenda do painel — quando a 1ª extra cai na data-base, os extras já são a lista inteira das parcelas.
function parcelasDoNegocio(n) {
  const extras = (n.pagamento_dias_apos_entrega == null && Array.isArray(n.pagamentos_extra)) ? n.pagamentos_extra : [];
  if (!extras.length) return [];
  const qtdExtra = p => p.unidade === "sc" ? Number(p.valor || 0).toLocaleString("pt-BR") : `R$ ${Number(p.valor || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
  if (extras[0].data === n.data_pagamento) return extras.map((p, i) => ({ parcela: i + 1, data: p.data, quantidade: qtdExtra(p), idxExtra: i === 0 ? null : i }));
  const somaSc = extras.filter(p => p.unidade === "sc").reduce((s, p) => s + Number(p.valor || 0), 0);
  return [{ parcela: 1, data: n.data_pagamento, quantidade: Math.max(0, Number(n.quantidade || 0) - somaSc).toLocaleString("pt-BR"), idxExtra: null },
    ...extras.map((p, i) => ({ parcela: i + 2, data: p.data, quantidade: qtdExtra(p), idxExtra: i }))];
}

async function marcarEnviado(adminHeaders, negocioId, campo) {
  await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${negocioId}`, {
    method: "PATCH",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ [campo]: true }),
  });
}

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

async function processarLote({ negocios, cadastrosPorId, tipoLog, montarMensagem, marcar, zapi, adminHeaders }) {
  for (const n of negocios) {
    const produtor = cadastrosPorId.get(n.produtor_id);
    const telefones = await telefonesComGrupo(produtor, adminHeaders);
    if (telefones.length === 0) {
      await registrarLog(adminHeaders, { negocio_id: n.id, tipo: tipoLog, destinatarios: produtor?.telefone || "(sem telefone)", sucesso: false, erro: "Produtor sem telefone cadastrado." });
      continue;
    }
    let algumSucesso = false;
    const erros = [];
    for (const telefone of telefones) {
      try {
        await enviarWhatsapp({ ...zapi, telefone, mensagem: montarMensagem(n, produtor) });
        algumSucesso = true;
      } catch (e) {
        erros.push(`${telefone}: ${e.message || e}`);
      }
    }
    await registrarLog(adminHeaders, { negocio_id: n.id, tipo: tipoLog, destinatarios: telefones.join(", "), sucesso: algumSucesso, erro: erros.join("; ") || null });
    if (algumSucesso) await marcar(n);
  }
}

// Roda todo dia de manhã: avisa produtores por WhatsApp (Z-API) no dia do pagamento
// dos negócios em aberto. Idempotente via flag em nexus_negocios.
// (O aviso automático de embarque foi desativado a pedido — o aviso de novo
// negócio continua existindo, mas é manual, disparado pelo botão 📲 na lista
// de Negociações via enviar-whatsapp-negocio.mjs, não por aqui.)
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

  const filtroParcela = encodeURIComponent(JSON.stringify([{ data: hoje }]));
  const [pagResp, parcResp, cfgResp] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?data_pagamento=eq.${hoje}&whatsapp_aviso_pagamento_enviado=eq.false&deleted_at=is.null&select=*`, { headers: adminHeaders }),
    fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?pagamentos_extra=cs.${filtroParcela}&deleted_at=is.null&select=*`, { headers: adminHeaders }),
    fetch(`${SUPABASE_URL}/rest/v1/nexus_config?id=eq.1&select=whatsapp_msg_pagamento`, { headers: adminHeaders }),
  ]);
  // 1º pagamento (data-base): quando o negócio tem parcelas, a mensagem fala só das sacas da 1ª parcela.
  const negociosBase = (await pagResp.json()).map(n => {
    const p1 = parcelasDoNegocio(n)[0];
    return p1 ? { ...n, quantidade: p1.quantidade, numero_contrato: `${n.numero_contrato || "—"} (1ª parcela)`, _marcar: "base" } : { ...n, _marcar: "base" };
  });
  // Parcelas extras de hoje: o "já avisei" fica na própria parcela (aviso_enviado dentro de pagamentos_extra).
  const negociosParcela = [];
  for (const n of await parcResp.json()) {
    for (const pc of parcelasDoNegocio(n)) {
      if (pc.idxExtra == null || pc.data !== hoje || n.pagamentos_extra[pc.idxExtra].aviso_enviado) continue;
      negociosParcela.push({ ...n, quantidade: pc.quantidade, numero_contrato: `${n.numero_contrato || "—"} (${pc.parcela}ª parcela)`, _marcar: pc.idxExtra });
    }
  }
  const negociosPagamento = [...negociosBase, ...negociosParcela];
  const cfgRows = await cfgResp.json();
  const templatePagamento = cfgRows[0]?.whatsapp_msg_pagamento || "Olá, {{NOME}}! Aqui é da Nexus Commodities. Hoje é a data de pagamento do seu negócio nº {{CONTRATO}} ({{GRAO}} {{SAFRA}}, {{QUANTIDADE}} sc). Qualquer dúvida, fale com seu corretor.";

  const idsProdutores = [...new Set(negociosPagamento.map(n => n.produtor_id).filter(Boolean))];
  const cadastrosPorId = new Map();
  if (idsProdutores.length) {
    const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${idsProdutores.join(",")})&select=id,nome,telefone,telefones_extra,grupo_id`, { headers: adminHeaders });
    const cads = await cadResp.json();
    for (const c of cads) cadastrosPorId.set(c.id, c);
  }

  await processarLote({
    negocios: negociosPagamento, cadastrosPorId, tipoLog: "WhatsApp Aviso de Pagamento", zapi, adminHeaders,
    montarMensagem: (n, p) => preencherTemplate(templatePagamento, n, p),
    marcar: async n => {
      if (n._marcar === "base") return marcarEnviado(adminHeaders, n.id, "whatsapp_aviso_pagamento_enviado");
      // relê o negócio pra não sobrescrever uma parcela marcada como paga nesse meio tempo
      const atual = await (await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${n.id}&select=pagamentos_extra`, { headers: adminHeaders })).json();
      const extras = (atual[0]?.pagamentos_extra || []).map((p, i) => i === n._marcar ? { ...p, aviso_enviado: true } : p);
      await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${n.id}`, {
        method: "PATCH",
        headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ pagamentos_extra: extras }),
      });
    },
  });

  return new Response(JSON.stringify({ ok: true, pagamento: negociosPagamento.length }), { status: 200 });
};

export const config = { schedule: "0 11 * * *" };
