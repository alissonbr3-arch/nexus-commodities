import { createSign } from "node:crypto";

const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";

// Ambiente de produção do DocuSign (migrado depois do Go-Live da Integration Key).
const DOCUSIGN_AUD = "account.docusign.com";
const DOCUSIGN_AUTH_URL = "https://account.docusign.com/oauth/token";
const DOCUSIGN_BASE_URL = "https://www.docusign.net/restapi";

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Reconstrói o PEM independente de como a chave foi colada nas env vars do Netlify
// (com quebras de linha reais, com "\n" literal, ou tudo achatado numa linha só).
function normalizarChavePem(raw) {
  let key = raw.trim().replace(/\\n/g, "\n");
  if (key.includes("\n")) return key;
  const match = key.match(/-----BEGIN ([^-]+)-----(.*)-----END ([^-]+)-----/);
  if (!match) return key;
  const tipo = match[1];
  const corpo = match[2].replace(/\s+/g, "");
  const linhas = corpo.match(/.{1,64}/g) || [];
  return `-----BEGIN ${tipo}-----\n${linhas.join("\n")}\n-----END ${tipo}-----\n`;
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

// Envia a Confirmação de Negócio pra assinatura digital (DocuSign) — o próprio DocuSign notifica
// vendedor e comprador por e-mail, não precisa mandar uma cópia separada via Resend.
// Só corretores da equipe Nexus podem chamar.
export default async (req) => {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, erro: "Corpo da requisição inválido." }, 400);
  }
  const { negocio_id, access_token, html } = payload || {};
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

  const { DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, DOCUSIGN_ACCOUNT_ID, DOCUSIGN_PRIVATE_KEY } = process.env;
  if (DOCUSIGN_INTEGRATION_KEY && DOCUSIGN_USER_ID && DOCUSIGN_ACCOUNT_ID && DOCUSIGN_PRIVATE_KEY) {
    try {
      const privateKey = normalizarChavePem(DOCUSIGN_PRIVATE_KEY);
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

  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST",
    headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      negocio_id, tipo: "Confirmação (DocuSign)", destinatarios: [vendedor.email, comprador.email].join(", "),
      enviado_por: caller.id, sucesso: !!resultado.docusign.ok, erro: resultado.docusign.ok ? null : resultado.docusign.erro,
    }),
  }).catch(() => {});

  return json({ ok: true, resultado }, 200);
};
