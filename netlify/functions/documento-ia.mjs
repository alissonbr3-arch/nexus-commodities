// Documentos pela IA: o corretor joga um arquivo no painel, a IA (Claude) lê e diz o que é
// (confirmação, pagamento, NFP, contra nota, romaneio, liberação de embarque...) e de qual contrato;
// depois o painel manda salvar e este arquivo repassa pro Apps Script da conta da Nexus, que grava
// na pasta do contrato no Google Drive.
//   acao "ler"    → { access_token, base64, mime, nome_original, contratos: [...] }  → { ok, leitura }
//   acao "salvar" → { access_token, base64, mime, nome_arquivo, contrato, nome_pasta, data_negocio } → { ok, url, pasta }
// Variáveis no Netlify: ANTHROPIC_API_KEY, DRIVE_SCRIPT_URL, DRIVE_SCRIPT_TOKEN, SUPABASE_SERVICE_ROLE_KEY.

const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4dmRsdGppc3dnY3l4aWt4c2tyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODcwNjUsImV4cCI6MjEwMTQ2MzA2NX0.SAIWIRMvdtevY-y1C-5Zlxas5NLuALLPj-ot2q_xP3E";
const MODELO = "claude-haiku-5-5"; // rápido o bastante pra caber no tempo da função do Netlify

const TIPOS = ["confirmacao", "pagamento", "nota_produtor", "contra_nota", "nota_fiscal", "romaneio", "liberacao_embarque", "outro"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function corretorDaEquipe(accessToken) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return "SUPABASE_SERVICE_ROLE_KEY não configurada no Netlify.";
  const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` } });
  if (!u.ok) return "Sessão inválida ou expirada. Entre de novo no painel.";
  const caller = await u.json();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/nexus_equipe?user_id=eq.${caller.id}&select=user_id`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? null : "Só corretores da equipe Nexus podem enviar documentos.";
}

const FERRAMENTA = {
  name: "classificar_documento",
  description: "Registra o que é o documento e a que contrato da Nexus ele pertence.",
  input_schema: {
    type: "object",
    properties: {
      tipo: { type: "string", enum: TIPOS, description: "confirmacao = confirmação de compra e venda / contrato da Nexus; pagamento = comprovante de pagamento, PIX, TED, transferência; nota_produtor = NFP / nota fiscal de produtor rural emitida pelo vendedor; contra_nota = contra nota / NF de entrada emitida pelo comprador referenciando a NFP; nota_fiscal = outra NF-e; romaneio = ticket de balança / romaneio de carga com peso; liberacao_embarque = liberação/autorização de embarque ou de retirada; outro = qualquer outra coisa." },
      assinado: { type: "boolean", description: "true se o documento tem assinatura (manuscrita, digital ou DocuSign) das partes." },
      contrato_numero: { type: ["string", "null"], description: "Número do contrato da lista (ex.: CT-2026-108) a que o documento pertence, ou null se não der pra saber." },
      confianca: { type: "string", enum: ["alta", "media", "baixa"], description: "Confiança na escolha do contrato." },
      motivo: { type: "string", description: "Uma frase curta em português explicando como chegou no contrato (ex.: 'pagador Total Grãos, favorecido Cesar Tozetto, milho, valor bate com o saldo')." },
      numero_documento: { type: ["string", "null"], description: "Número da nota (NFP, contra nota ou NF), sem pontos. null se não houver." },
      nfp_referenciada: { type: ["string", "null"], description: "Na contra nota: número da NFP referenciada." },
      valor: { type: ["number", "null"], description: "Valor em reais (pagamento: valor pago; nota: valor total)." },
      data: { type: ["string", "null"], description: "Data do documento no formato AAAA-MM-DD (data do pagamento, emissão da nota, pesagem)." },
      peso_kg: { type: ["number", "null"], description: "Peso líquido em kg (romaneio, NFP, contra nota)." },
      parcela: { type: ["string", "null"], enum: ["PARTE", "SALDO", null], description: "No pagamento: SALDO se o comprovante diz que é saldo/quitação, PARTE se diz adiantamento/parcial; null se não diz." },
      grao: { type: ["string", "null"], description: "Grão do documento (Soja, Milho, Sorgo...)." },
      nome_sugerido: { type: "string", description: "Nome curto e descritivo pro arquivo, em português, sem extensão (usado quando tipo = outro)." },
    },
    required: ["tipo", "assinado", "contrato_numero", "confianca", "motivo", "nome_sugerido"],
  },
};

async function ler(p) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ ok: false, erro: "Falta a chave da IA (ANTHROPIC_API_KEY) no Netlify." }, 500);
  const contratos = (p.contratos || []).slice(0, 400).map(c =>
    `${c.numero} | vendedor: ${c.vendedor} | comprador: ${c.comprador} | ${c.grao || ""} ${c.safra || ""} | ${c.quantidade || "?"} sc | R$ ${c.preco || "?"}/sc | data ${c.data || "?"} | ${c.status || ""}`).join("\n");
  const ehPdf = p.mime === "application/pdf";
  const bloco = ehPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: p.base64 } }
    : { type: "image", source: { type: "base64", media_type: p.mime, data: p.base64 } };
  const texto = `Você trabalha na Nexus Commodities, corretora de grãos em São Gabriel do Oeste/MS. O vendedor é o produtor rural e o comprador é a cerealista/cooperativa/trading. Leia o documento anexo (nome do arquivo: "${p.nome_original || ""}") e classifique.

Contratos da Nexus (mais recentes primeiro):
${contratos || "(nenhum)"}

Para achar o contrato, cruze nomes do vendedor e do comprador (pagador e favorecido no comprovante; emitente e destinatário nas notas), grão, quantidade, valor e datas. Se o próprio documento citar o número do contrato (CT-2026-xxx ou "CTR 108"), use. Só escolha um contrato com confiança "alta" se as partes baterem.`;

  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), 24000);
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controle.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELO, max_tokens: 1024,
        thinking: { type: "disabled" }, // classificação simples: sem raciocínio fica mais rápido e a ferramenta forçada funciona
        tools: [FERRAMENTA], tool_choice: { type: "tool", name: FERRAMENTA.name },
        messages: [{ role: "user", content: [bloco, { type: "text", text: texto }] }],
      }),
    });
  } catch (e) {
    return json({ ok: false, erro: e.name === "AbortError" ? "A IA demorou demais pra ler. Tente de novo." : "Erro ao falar com a IA: " + e.message }, 504);
  } finally { clearTimeout(timer); }
  const j = await r.json();
  if (!r.ok) return json({ ok: false, erro: "IA: " + (j.error?.message || r.status) }, 502);
  const uso = (j.content || []).find(b => b.type === "tool_use");
  if (!uso) return json({ ok: false, erro: "A IA não conseguiu classificar o documento." }, 502);
  return json({ ok: true, leitura: uso.input });
}

async function salvar(p) {
  const url = process.env.DRIVE_SCRIPT_URL, token = process.env.DRIVE_SCRIPT_TOKEN;
  if (!url || !token) return json({ ok: false, erro: "Falta ligar o Google Drive (DRIVE_SCRIPT_URL e DRIVE_SCRIPT_TOKEN no Netlify)." }, 500);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ token, base64: p.base64, mime: p.mime, nome_arquivo: p.nome_arquivo, contrato: p.contrato || null, nome_pasta: p.nome_pasta || null, data_negocio: p.data_negocio || null }),
    redirect: "follow",
  });
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { return json({ ok: false, erro: "O Google Drive respondeu algo inesperado." }, 502); }
  return json(j, j.ok ? 200 : 502);
}

export default async (req) => {
  let p;
  try { p = await req.json(); } catch { return json({ ok: false, erro: "Corpo da requisição inválido." }, 400); }
  if (!p?.access_token || !p?.base64 || !p?.mime) return json({ ok: false, erro: "Dados incompletos." }, 400);
  const negado = await corretorDaEquipe(p.access_token);
  if (negado) return json({ ok: false, erro: negado }, 403);
  if (p.acao === "ler") return ler(p);
  if (p.acao === "salvar") return salvar(p);
  return json({ ok: false, erro: "Ação desconhecida." }, 400);
};
