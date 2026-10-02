const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";

// Remetente dos e-mails via Resend — precisa ser um domínio verificado lá (nexuscommoditiesms.com.br).
const FROM_EMAIL = "Nexus Commodities <contratos@nexuscommoditiesms.com.br>";
// Cópia oculta pra Nexus em todo e-mail de boleto enviado, pra ficar registrado na caixa da empresa.
const BCC_NEXUS = "nexuscommodities@terra.com.br";
const ASSINATURA_EMAIL_HTML = `
  <table style="margin-top:24px;padding-top:16px;border-top:1px solid #ddd;font-family:Arial,Helvetica,sans-serif">
    <tr>
      <td style="padding-right:12px"><img src="https://painel.nexuscommoditiesms.com.br/logo-nexus.png" alt="Nexus Commodities" width="48" height="48" style="display:block"></td>
      <td style="font-size:12px;color:#555;line-height:1.5">
        <strong style="color:#111;font-size:13px">Nexus Commodities</strong><br>
        (67) 99130-9516<br>
        São Gabriel do Oeste - MS
      </td>
    </tr>
  </table>`;

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

function fmtNum(v) { return Number(v || 0).toLocaleString("pt-BR"); }

// Relatório da cobrança em texto (uma linha por contrato) que vai junto do boleto no WhatsApp.
// nomePorId só é usado quando quem paga é o comprador — aí vale dizer de qual produtor é cada
// contrato; quando o pagador é o próprio vendedor, o produtor de todas as linhas é ele.
function relatorioCobrancaTexto(negocios, nomeProdutorPorId) {
  const linhas = negocios.map(n => {
    const produto = `${n.grao || "—"}${n.safra ? " " + n.safra : ""}`;
    const porSaca = Number(n.comissao_saca) > 0 ? ` × ${fmtMoney(n.comissao_saca)}/sc` : "";
    const produtor = nomeProdutorPorId && nomeProdutorPorId[n.produtor_id] ? ` — ${nomeProdutorPorId[n.produtor_id]}` : "";
    return `• ${n.numero_contrato || "—"} — ${produto}${produtor}\n   ${fmtNum(n.quantidade)} sc${porSaca} = ${fmtMoney(n.comissao)}`;
  });
  const total = negocios.reduce((s, n) => s + Number(n.comissao || 0), 0);
  return `📋 *Relatório da cobrança*\n${linhas.join("\n")}\n*Total: ${fmtMoney(total)}*`;
}

// Telefones/e-mails de um cadastro E de todos os outros cadastros do mesmo grupo dele (ex:
// sócios da mesma propriedade) — sem duplicar. Sem grupo, é só o do próprio cadastro mesmo.
async function contatosComGrupo(cadastro, adminHeaders) {
  if (!cadastro) return { telefones: [], emails: [] };
  let membros = [cadastro];
  if (cadastro.grupo_id) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?grupo_id=eq.${cadastro.grupo_id}&select=telefone,telefones_extra,email,emails_extra`, { headers: adminHeaders });
    const rows = await resp.json().catch(() => []);
    if (Array.isArray(rows) && rows.length) membros = rows;
  }
  const telefones = [...new Set(membros.flatMap(m => [m.telefone, ...(m.telefones_extra || [])]).map(formatarTelefoneWhats).filter(Boolean))];
  const emails = [...new Set(membros.flatMap(m => [m.email, ...(m.emails_extra || [])]).filter(Boolean))];
  return { telefones, emails };
}

// (Re)envia por WhatsApp e e-mail o boleto de comissão já gerado pra um negócio — útil quando
// o envio automático da geração falhou, ou quando o cliente precisa que o boleto seja mandado
// de novo. Recebe QUALQUER negócio que faça parte do boleto (um boleto pode agrupar vários
// negócios do mesmo pagador — nesse caso todos compartilham o mesmo boleto_comissao_id) e
// reconstrói a lista completa de contratos/valor a partir de todos os negócios daquele boleto.
// Só corretores da equipe Nexus podem chamar.
export default async (req) => {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, erro: "Corpo da requisição inválido." }, 400);
  }
  const { negocio_id, access_token } = payload || {};
  if (!negocio_id || !access_token) {
    return json({ ok: false, erro: "Dados incompletos (negocio_id e access_token são obrigatórios)." }, 400);
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN } = process.env;
  if (!serviceKey) return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." }, 500);
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` },
  });
  if (!userResp.ok) return json({ ok: false, erro: "Sessão inválida ou expirada." }, 401);
  const caller = await userResp.json();

  const staffResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?user_id=eq.${caller.id}&select=user_id`, { headers: adminHeaders });
  const staffRows = await staffResp.json();
  if (!Array.isArray(staffRows) || staffRows.length === 0) {
    return json({ ok: false, erro: "Apenas corretores da equipe Nexus podem enviar boletos." }, 403);
  }

  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${negocio_id}&select=*`, { headers: adminHeaders });
  const negRows = await negResp.json();
  const negocioBase = negRows[0];
  if (!negocioBase) return json({ ok: false, erro: "Negócio não encontrado." }, 404);
  if (!negocioBase.boleto_comissao_id || !negocioBase.boleto_comissao_url) {
    return json({ ok: false, erro: "Este negócio ainda não tem boleto gerado." }, 400);
  }

  // Todos os negócios que compartilham o mesmo boleto (pode ser só este, ou um grupo gerado junto).
  const grupoResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?boleto_comissao_id=eq.${negocioBase.boleto_comissao_id}&deleted_at=is.null&select=*`, { headers: adminHeaders });
  const negocios = await grupoResp.json();
  if (!Array.isArray(negocios) || negocios.length === 0) {
    return json({ ok: false, erro: "Não encontrei os negócios deste boleto." }, 404);
  }

  const pagadorId = negocioBase.comissao_pagador === "Comprador" ? negocioBase.cliente_id : negocioBase.produtor_id;
  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=eq.${pagadorId}&select=id,nome,telefone,telefones_extra,email,emails_extra,grupo_id`, { headers: adminHeaders });
  const cadRows = await cadResp.json();
  const pagador = cadRows[0];
  if (!pagador) return json({ ok: false, erro: "Não encontrei o cadastro de quem paga a comissão." }, 400);

  const valorTotal = negocios.reduce((s, n) => s + Number(n.comissao || 0), 0);
  const contratos = negocios.map(n => n.numero_contrato || "—").join(", ");
  const url = negocioBase.boleto_comissao_url;
  const vencimento = negocioBase.boleto_comissao_vencimento ? negocioBase.boleto_comissao_vencimento.split("-").reverse().join("/") : "—";
  const { telefones, emails } = await contatosComGrupo(pagador, adminHeaders);

  let nomeProdutorPorId = null;
  if (negocios.some(n => n.comissao_pagador === "Comprador")) {
    const idsProd = [...new Set(negocios.map(n => n.produtor_id).filter(Boolean))];
    if (idsProd.length) {
      const prodResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${idsProd.join(",")})&select=id,nome`, { headers: adminHeaders });
      const prodRows = await prodResp.json().catch(() => []);
      if (Array.isArray(prodRows)) nomeProdutorPorId = Object.fromEntries(prodRows.map(c => [c.id, c.nome]));
    }
  }
  const relatorio = relatorioCobrancaTexto(negocios, nomeProdutorPorId);
  const mensagem = `Olá, ${pagador.nome}! Aqui é da Nexus Commodities.\n\nSegue o boleto ${negocios.length === 1 ? "" : "agrupado "}da comissão de intermediação referente ${negocios.length === 1 ? "à Confirmação de Negócio" : "às Confirmações de Negócio"} nº ${contratos}.\n\n${relatorio}\nVencimento: ${vencimento}\n\nBoleto: ${url}\n\nQualquer dúvida, fale com seu corretor.`;

  let whatsapp = { tentado: false, sucesso: false };
  if (telefones.length && ZAPI_INSTANCE_ID && ZAPI_TOKEN && ZAPI_CLIENT_TOKEN) {
    whatsapp.tentado = true;
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

  let email = { tentado: false, sucesso: false, erro: null };
  const resendKey = process.env.RESEND_API_KEY;
  if (emails.length) {
    email.tentado = true;
    if (!resendKey) {
      email.erro = "RESEND_API_KEY não configurada.";
    } else {
      try {
        const assunto = negocios.length === 1
          ? `Boleto da Comissão — Confirmação de Negócio nº ${contratos} — Nexus Commodities`
          : `Boleto da Comissão (agrupado) — Confirmações de Negócio nº ${contratos} — Nexus Commodities`;
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: emails,
            bcc: BCC_NEXUS,
            subject: assunto,
            html: `<p>Olá, ${pagador.nome}!</p><p>Segue o boleto da comissão de intermediação referente à${negocios.length === 1 ? " Confirmação de Negócio nº " + contratos : "s Confirmações de Negócio nº " + contratos}.</p><p><strong>Valor:</strong> ${fmtMoney(valorTotal)}<br><strong>Vencimento:</strong> ${vencimento}</p><p><a href="${url}">${url}</a></p><p>Qualquer dúvida, fale com seu corretor.</p>${ASSINATURA_EMAIL_HTML}`,
          }),
        });
        const respData = await resp.json();
        if (!resp.ok) throw new Error(respData.message || JSON.stringify(respData));
        email.sucesso = true;
      } catch (e) {
        email.erro = String(e.message || e);
      }
    }
  }

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      negocio_id: negocioBase.id, tipo: "Boleto Comissão — Reenvio (WhatsApp + E-mail)",
      destinatarios: `${[...telefones, ...emails].join(", ") || pagador.nome} — contratos: ${contratos}`,
      enviado_por: caller.id, sucesso: whatsapp.sucesso || email.sucesso,
      erro: [!whatsapp.sucesso && whatsapp.tentado ? "WhatsApp falhou" : null, email.erro].filter(Boolean).join("; ") || null,
    }),
  }).catch(() => {});

  return json({ ok: true, whatsapp, email, valorTotal, contratos }, 200);
};
