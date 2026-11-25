// Assistente da Nexus para CLIENTES (produtores) no WhatsApp: texto ou áudio. Só responde quando a mensagem
// é pergunta sobre os contratos, pagamentos ou embarques do próprio cliente, e só com os dados dele, sem gravar nada.
// Fica quieta: (1) se alguém da Nexus falou com esse número na última hora (conversa humana em andamento,
// nexus_whatsapp_humano) e (2) quando o filtro barato (Haiku) diz que não é pergunta sobre contratos — aí quem
// responde é o corretor, como sempre. O whatsapp-webhook chama esta função em segundo plano.
import { SUPABASE_URL, registrarUsoIA, transcreverAudio, precoLiquidoNegocio } from "./_documento-lib.mjs";

const MODELO = "claude-sonnet-5-5", MODELO_FILTRO = "claude-haiku-5-5";
const MINUTOS_HUMANO = 60, HISTORICO_HORAS = 6, MAX_VOLTAS = 6;

const H = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` });
async function db(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...H(), "Content-Type": "application/json", ...(opts.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`banco ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const digitos = s => { let x = String(s || "").replace(/\D/g, ""); if (x.length >= 12 && x.startsWith("55")) x = x.slice(2); if (x.length === 11) x = x.slice(0, 2) + x.slice(3); return x.slice(-10); };
function telefoneEnvio(t) { const d = String(t || "").replace(/\D/g, ""); return d.length === 12 && d.startsWith("55") && /[6-9]/.test(d[4]) ? d.slice(0, 4) + "9" + d.slice(4) : d; }
async function responder(telefone, mensagem) {
  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN } = process.env;
  for (const phone of [...new Set([telefone, telefoneEnvio(telefone)])]) {
    const r = await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`, {
      method: "POST", headers: { "Content-Type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN }, body: JSON.stringify({ phone, message: mensagem }),
    }).catch(() => null);
    const corpo = r ? await r.text() : "";
    console.log("Z-API envio", phone, r?.status, corpo.slice(0, 200));
    if (r?.ok && !/error/i.test(corpo)) return;
  }
}
async function claude(body, origem) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("IA: " + (j.error?.message || r.status));
  await registrarUsoIA(origem, body.model, j.usage);
  return j;
}

// Filtro barato: só segue pro Sonnet se for pergunta do cliente sobre os próprios negócios com a Nexus.
async function ehPerguntaSobreContratos(texto) {
  const j = await claude({
    model: MODELO_FILTRO, max_tokens: 5, thinking: { type: "disabled" },
    system: "Você filtra mensagens que clientes (produtores rurais) mandam no WhatsApp de uma corretora de grãos. Responda só SIM ou NAO.",
    messages: [{ role: "user", content: `Esta mensagem pede informação sobre os contratos/negócios do cliente com a corretora (quantidades, preços fechados, datas ou status de pagamento, embarque/entrega, saldo a entregar, confirmação)? Cumprimentos, agradecimentos, pedidos de ligação, ofertas, pedidos de preço/cotação do dia ou de novo negócio = NAO.\n\nMensagem: "${texto.slice(0, 1500)}"` }],
  }, "cliente-filtro");
  return /^\s*sim/i.test((j.content || []).map(b => b.text || "").join(""));
}

const FERRAMENTAS = [
  { name: "meus_contratos", description: "Lista os contratos do cliente com a Nexus: número, grão, safra, sacas, preço, preço líquido, comprador, data de pagamento, status, quanto já foi entregue.",
    input_schema: { type: "object", properties: { so_abertos: { type: "boolean", description: "true = só os que ainda não foram finalizados." } } } },
  { name: "detalhe_contrato", description: "Detalhes de um contrato do cliente: parcelas de pagamento (pago ou não), janela de embarque, cargas entregues e quanto falta.",
    input_schema: { type: "object", properties: { contrato: { type: "string", description: "'141', 'CT 141' ou 'CT-2026-141'" } }, required: ["contrato"] } },
];

function parcelas(n) {
  const extras = n.pagamentos_extra || [];
  if (!extras.length || n.pagamento_dias_apos_entrega != null) return [{ data: n.data_pagamento, pago: !!n.check_pagamento }];
  const completa = extras[0].data === n.data_pagamento;
  return [{ data: n.data_pagamento, pago: !!n.check_pagamento }, ...extras.map(p => ({ data: p.data, valor: p.valor, unidade: p.unidade, pago: !!p.pago })).slice(completa ? 1 : 0)];
}
const entregue = n => (Array.isArray(n.cargas) ? n.cargas : []).reduce((s, c) => s + Number(c.sacas || 0), 0);

export default async (req) => {
  const p = await req.json().catch(() => null);
  if (!p || p.secret !== process.env.WHATSAPP_WEBHOOK_SECRET || !p.phone || !(p.texto || p.audioUrl)) return;
  const telefone = p.phone;
  try {
    // Conversa humana recente com esse número → a IA não se mete.
    const humano = (await db(`nexus_whatsapp_humano?telefone=eq.${digitos(telefone)}&select=ultima_em`))[0];
    if (humano && Date.now() - new Date(humano.ultima_em).getTime() < MINUTOS_HUMANO * 60e3) { console.log("cliente: corretor conversando, fico quieta"); return; }

    const produtores = (await db("nexus_cadastros?tipo=eq.Produtor&select=id,nome,apelido,telefone,telefones_extra"))
      .filter(c => [c.telefone, ...(c.telefones_extra || [])].some(t => t && digitos(t) === digitos(telefone)));
    if (!produtores.length) return;

    let texto = p.texto || "", ouvido = "";
    if (!texto && p.audioUrl) {
      try { texto = ouvido = await transcreverAudio(p.audioUrl, p.audioMime, p.audioSegundos); } catch (e) { console.log("cliente: falha ao transcrever", e.message); return; }
      if (!texto) return;
    }
    if (!(await ehPerguntaSobreContratos(texto))) { console.log("cliente: filtro disse que não é pergunta sobre contratos:", texto.slice(0, 120)); return; }

    const ids = produtores.map(c => c.id);
    const [negocios, cadastros, cfg] = await Promise.all([
      db(`nexus_negocios?produtor_id=in.(${ids.join(",")})&deleted_at=is.null&cliente_id=not.is.null&select=*&order=data.desc`),
      db("nexus_cadastros?tipo=eq.Comprador&select=id,nome,categoria_comprador"),
      db("nexus_config?id=eq.1&select=fundersul_saca,fundems_saca,funrural_pct"),
    ]);
    const comprador = n => cadastros.find(c => c.id === n.cliente_id);
    const resumo = n => ({ contrato: n.numero_contrato, grao: n.grao, safra: n.safra, comprador: comprador(n)?.nome || "", sacas: Number(n.quantidade || 0), preco: Number(n.preco || 0),
      preco_liquido: Math.round(precoLiquidoNegocio(n, comprador(n), cfg[0] || {}) * 100) / 100, modalidade: n.modalidade, data: n.data, data_pagamento: n.data_pagamento,
      pago: parcelas(n).every(x => x.pago), entregue_sacas: Math.round(entregue(n) * 100) / 100, embarque_finalizado: !!n.embarque_finalizado, status: n.status });
    const achar = c => { const m = String(c || "").match(/0*(\d{1,4})\s*$/); return m && negocios.find(n => String(n.numero_contrato).match(/-0*(\d+)$/)?.[1] === m[1]); };
    const executar = (nome, input) => {
      if (nome === "meus_contratos") return negocios.filter(n => !input.so_abertos || n.status !== "Finalizado").slice(0, 40).map(resumo);
      if (nome === "detalhe_contrato") {
        const n = achar(input.contrato);
        if (!n) return { erro: "Esse contrato não está entre os contratos deste cliente." };
        return { ...resumo(n), local: n.local_origem, janela_embarque: [n.data_inicio_embarque, n.data_fim_embarque], parcelas: parcelas(n),
          cargas: (n.cargas || []).map(c => ({ data: c.data, sacas: c.sacas })), falta_entregar_sacas: Math.max(0, Math.round((Number(n.quantidade || 0) - entregue(n)) * 100) / 100) };
      }
      return { erro: "Ferramenta desconhecida." };
    };

    const desde = new Date(Date.now() - HISTORICO_HORAS * 3600e3).toISOString();
    const hist = (await db(`nexus_assistente_msgs?telefone=eq.${telefone}&created_at=gte.${desde}&select=role,texto&order=created_at.desc&limit=10`)).reverse();
    while (hist.length && hist[0].role !== "user") hist.shift();
    const messages = [];
    for (const m of hist) { const u = messages[messages.length - 1]; if (u && u.role === m.role) u.content += "\n\n" + m.texto; else messages.push({ role: m.role, content: m.texto }); }
    const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Campo_Grande" });
    const entrada = `[${hoje}${ouvido ? " · por áudio" : ""}] ${texto}`;
    if (messages.length && messages[messages.length - 1].role === "user") messages[messages.length - 1].content += "\n\n" + entrada; else messages.push({ role: "user", content: entrada });
    await db("nexus_assistente_msgs", { method: "POST", body: JSON.stringify({ telefone, role: "user", texto: entrada }) });

    const sistema = `Você é a assistente virtual da Nexus Commodities, corretora de grãos de São Gabriel do Oeste/MS, respondendo no WhatsApp a um CLIENTE (produtor rural): ${produtores.map(c => c.nome).join(" / ")}.
- Responda só sobre os contratos deste cliente, usando as ferramentas. Nunca invente números; se não achar, diga que vai pedir ao corretor para confirmar.
- Nunca fale de comissão, de outros clientes, de margens ou de assuntos internos da Nexus.
- Você não grava nem altera nada. Para negociar, mudar datas, pedir preço do dia ou qualquer outro assunto, diga com gentileza que o corretor vai responder em seguida.
- Português simples e cordial, curto, estilo WhatsApp (*negrito* com um asterisco, listas com "•"). Sacas de 60 kg; valores como R$ 1.234,56; datas dd/mm/aaaa.
- Termine com a linha "_Assistente virtual Nexus_".`;

    let resposta = "";
    for (let volta = 0; volta < MAX_VOLTAS; volta++) {
      const j = await claude({ model: MODELO, max_tokens: 2048, thinking: { type: "between_tools" }, output_config: { effort: "medium" }, system: sistema, tools: FERRAMENTAS, messages }, "cliente-whatsapp");
      if (j.stop_reason === "refusal") return;
      messages.push({ role: "assistant", content: j.content });
      const usos = j.content.filter(b => b.type === "tool_use");
      if (!usos.length) { resposta = j.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim(); break; }
      messages.push({ role: "user", content: usos.map(u => { const out = executar(u.name, u.input || {}); return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out), ...(out?.erro ? { is_error: true } : {}) }; }) });
    }
    if (!resposta) return;
    await db("nexus_assistente_msgs", { method: "POST", body: JSON.stringify({ telefone, role: "assistant", texto: resposta }) });
    await responder(telefone, ouvido ? `🎤 _Entendi: "${ouvido.length > 300 ? ouvido.slice(0, 300) + "…" : ouvido}"_\n\n${resposta}` : resposta);
  } catch (e) {
    console.log("ERRO assistente cliente:", e.message); // com cliente, erro fica em silêncio: o corretor responde
  }
};
