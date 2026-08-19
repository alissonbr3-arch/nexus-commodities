import { createSign } from "node:crypto";

const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";

// Remetente dos e-mails via Resend — precisa ser um domínio verificado lá (nexuscommoditiesms.com.br).
const FROM_EMAIL = "Nexus Commodities <contratos@nexuscommoditiesms.com.br>";

// Ambiente de testes do DocuSign. Ao migrar pra produção (depois do Go-Live),
// trocar para "account.docusign.com" (auth) e "https://www.docusign.net/restapi" (API) —
// o account_id de produção também muda.
const DOCUSIGN_AUD = "account-d.docusign.com";
const DOCUSIGN_AUTH_URL = "https://account-d.docusign.com/oauth/token";
const DOCUSIGN_BASE_URL = "https://demo.docusign.net/restapi";

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function criarJwtDocusign(integrationKey, userId, privateKeyPem) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: integrationKey,
    sub: userId,
    aud: DOCUSIGN_AUD,
    iat: now,
    exp: now + 3600,
    scope: "signature impersonation",
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${unsigned}.${signature}`;
}

async function obterAccessTokenDocusign(jwt) {
  const resp = await fetch(DOCUSIGN_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error_description || data.error || "Falha na autenticação DocuSign.");
  return data.access_token;
}

async function criarEnvelopeDocusign({ accessToken, accountId, html, numeroContrato, vendedor, comprador }) {
  const htmlBase64 = Buffer.from(html, "utf-8").toString("base64");
  const body = {
    emailSubject: `Confirmação de Negócio ${numeroContrato || ""} — Nexus Commodities`,
    documents: [{ documentBase64: htmlBase64, name: `Confirmacao_${numeroContrato || "negocio"}`, fileExtension: "html", documentId: "1" }],
    recipients: {
      signers: [
        {
          email: vendedor.email, name: vendedor.nome, recipientId: "1", routingOrder: "1",
          tabs: { signHereTabs: [{ anchorString: "[[ASSINA_VENDEDOR]]", anchorUnits: "pixels", anchorYOffset: "-10", anchorXOffset: "0" }] },
        },
        {
          email: comprador.email, name: comprador.nome, recipientId: "2", routingOrder: "1",
          tabs: { signHereTabs: [{ anchorString: "[[ASSINA_COMPRADOR]]", anchorUnits: "pixels", anchorYOffset: "-10", anchorXOffset: "0" }] },
        },
      ],
    },
    status: "sent",
  };
  const resp = await fetch(`${DOCUSIGN_BASE_URL}/v2.1/accounts/${accountId}/envelopes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

async function enviarEmailResend({ apiKey, to, subject, pdfBase64, filename }) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to,
      subject,
      html: `<p>Segue em anexo a Confirmação de Negócio.</p><p>Nexus Commodities</p>`,
      attachments: pdfBase64 ? [{ filename, content: pdfBase64 }] : [],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

// Envia a Confirmação de Negócio por e-mail (Resend) e/ou pra assinatura digital (DocuSign).
// Só corretores da equipe Nexus podem chamar. Cada integração roda de forma independente —
// se uma das duas não estiver configurada (variáveis de ambiente ausentes), a outra ainda funciona.
export default async (req) => {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, erro: "Corpo da requisição inválido." }, 400);
  }
  const { negocio_id, access_token, html, pdf_base64 } = payload || {};
  if (!negocio_id || !access_token || !html) {
    return json({ ok: false, erro: "Dados incompletos (negocio_id, access_token e html são obrigatórios)." }, 400);
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

  const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${negocio.produtor_id},${negocio.cliente_id})&select=id,nome,email`, { headers: adminHeaders });
  const cads = await cadResp.json();
  const vendedor = cads.find(c => c.id === negocio.produtor_id);
  const comprador = cads.find(c => c.id === negocio.cliente_id);
  if (!vendedor?.email || !comprador?.email) {
    return json({ ok: false, erro: "Vendedor e comprador precisam ter e-mail de contato cadastrado antes de enviar." }, 400);
  }

  const resultado = {};

  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      await enviarEmailResend({
        apiKey: resendKey,
        to: [vendedor.email, comprador.email],
        subject: `Confirmação de Negócio ${negocio.numero_contrato || ""} — Nexus Commodities`,
        pdfBase64: pdf_base64,
        filename: `Confirmacao_${negocio.numero_contrato || "negocio"}.pdf`,
      });
      resultado.email = { ok: true };
    } catch (e) {
      resultado.email = { ok: false, erro: String(e.message || e) };
    }
  } else {
    resultado.email = { ok: false, erro: "RESEND_API_KEY não configurada." };
  }

  const { DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, DOCUSIGN_ACCOUNT_ID, DOCUSIGN_PRIVATE_KEY } = process.env;
  if (DOCUSIGN_INTEGRATION_KEY && DOCUSIGN_USER_ID && DOCUSIGN_ACCOUNT_ID && DOCUSIGN_PRIVATE_KEY) {
    try {
      const privateKey = DOCUSIGN_PRIVATE_KEY.replace(/\\n/g, "\n");
      const jwt = criarJwtDocusign(DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, privateKey);
      const accessToken = await obterAccessTokenDocusign(jwt);
      const envelope = await criarEnvelopeDocusign({
        accessToken, accountId: DOCUSIGN_ACCOUNT_ID, html, numeroContrato: negocio.numero_contrato, vendedor, comprador,
      });
      resultado.docusign = { ok: true, envelopeId: envelope.envelopeId };
    } catch (e) {
      resultado.docusign = { ok: false, erro: String(e.message || e) };
    }
  } else {
    resultado.docusign = { ok: false, erro: "Variáveis do DocuSign não configuradas." };
  }

  return json({ ok: true, resultado }, 200);
};
