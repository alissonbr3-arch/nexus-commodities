const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";

// Remetente dos e-mails via Resend — precisa ser um domínio verificado lá (nexuscommoditiesms.com.br).
const FROM_EMAIL = "Nexus Commodities <contratos@nexuscommoditiesms.com.br>";
// Cópia oculta pra Nexus em toda Confirmação enviada, pra ficar registrado na caixa da empresa.
const BCC_NEXUS = "nexuscommodities@terra.com.br";

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Manda a Confirmação de Negócio em PDF anexado por e-mail (Resend), sem passar pelo DocuSign —
// alternativa direta pra quando não precisa (ou não consegue) de assinatura digital. O PDF já
// vem pronto (gerado no navegador do corretor com html2pdf.js), essa function só recebe e envia.
// Só corretores da equipe Nexus podem chamar.
export default async (req) => {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, erro: "Corpo da requisição inválido." }, 400);
  }
  const { negocio_id, access_token, pdf_base64 } = payload || {};
  if (!negocio_id || !access_token || !pdf_base64) {
    return json({ ok: false, erro: "Dados incompletos (negocio_id, access_token e pdf_base64 são obrigatórios)." }, 400);
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return json({ ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada nas variáveis de ambiente do Netlify." }, 500);
  }
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` },
  });
  if (!userResp.ok) return json({ ok: false, erro: "Sessão inválida ou expirada." }, 401);
  const caller = await userResp.json();

  const staffResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?user_id=eq.${caller.id}&select=user_id`, { headers: adminHeaders });
  const staffRows = await staffResp.json();
  if (!Array.isArray(staffRows) || staffRows.length === 0) {
    return json({ ok: false, erro: "Apenas corretores da equipe Nexus podem enviar confirmações." }, 403);
  }

  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?id=eq.${negocio_id}&select=*`, { headers: adminHeaders });
  const negRows = await negResp.json();
  const negocio = negRows[0];
  if (!negocio) return json({ ok: false, erro: "Negócio não encontrado." }, 404);

  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${negocio.produtor_id},${negocio.cliente_id})&select=id,nome,email,emails_extra`, { headers: adminHeaders });
  const cads = await cadResp.json();
  const vendedor = cads.find(c => c.id === negocio.produtor_id);
  const comprador = cads.find(c => c.id === negocio.cliente_id);
  if (!vendedor?.email || !comprador?.email) {
    return json({ ok: false, erro: "Vendedor e comprador precisam ter e-mail de contato cadastrado antes de enviar." }, 400);
  }
  const destinatarios = [...new Set([vendedor.email, ...(vendedor.emails_extra || []), comprador.email, ...(comprador.emails_extra || [])].filter(Boolean))];

  const resendKey = process.env.RESEND_API_KEY;
  let sucesso = false, erro = null;
  if (!resendKey) {
    erro = "RESEND_API_KEY não configurada.";
  } else {
    try {
      const nomeArquivo = `Confirmacao_${negocio.numero_contrato || "negocio"}.pdf`;
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: destinatarios,
          bcc: BCC_NEXUS,
          subject: `Confirmação de Negócio ${negocio.numero_contrato || ""} — Nexus Commodities`,
          html: `<p>Olá,</p><p>Segue em anexo a Confirmação de Negócio ${negocio.numero_contrato || ""}, referente à negociação de ${(negocio.grao||"—")}${negocio.safra ? " safra " + negocio.safra : ""} entre ${vendedor.nome} e ${comprador.nome}.</p><p>Qualquer dúvida, fale com seu corretor.</p><p>Nexus Commodities</p>`,
          attachments: [{ filename: nomeArquivo, content: pdf_base64 }],
        }),
      });
      const respData = await resp.json();
      if (!resp.ok) throw new Error(respData.message || JSON.stringify(respData));
      sucesso = true;
    } catch (e) {
      erro = String(e.message || e);
    }
  }

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      negocio_id, tipo: "Confirmação (PDF por e-mail)", destinatarios: [...destinatarios, `${BCC_NEXUS} (cópia)`].join(", "),
      enviado_por: caller.id, sucesso, erro,
    }),
  }).catch(() => {});

  return sucesso ? json({ ok: true }, 200) : json({ ok: false, erro }, 500);
};
