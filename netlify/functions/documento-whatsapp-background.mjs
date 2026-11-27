// Documento mandado por um corretor no WhatsApp da Nexus (foto ou PDF). O whatsapp-webhook confere
// que é da equipe e chama esta função em segundo plano (pode levar mais que os 10 s de uma função normal):
// baixa o arquivo da Z-API, a IA lê e acha o contrato, salva na pasta dele no Drive e nos anexos da
// negociação, e responde no WhatsApp. Se a IA não tiver certeza do contrato, não salva e pede o número.
import { randomUUID } from "node:crypto";
import { SUPABASE_URL, TIPO_LABEL, TIPOS_CADASTRO, caminhoCliente, aplicarDocumentoNoNegocio, lerComIA, salvarNoDrive, nomeArquivoDoc, nomePastaContrato } from "./_documento-lib.mjs";

const MIMES_OK = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function responder(telefone, mensagem) {
  console.log("RESPOSTA para", telefone, ":", mensagem);
  const { ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN } = process.env;
  await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({ phone: telefone, message: mensagem }),
  }).catch(() => {});
}

async function carregarContratos(adminHeaders) {
  const [negR, cadR] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?deleted_at=is.null&numero_contrato=not.is.null&select=id,numero_contrato,produtor_id,cliente_id,contraparte,grao,safra,quantidade,preco,data,status&order=numero_contrato.desc&limit=400`, { headers: adminHeaders }),
    fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?select=id,nome`, { headers: adminHeaders }),
  ]);
  const negs = await negR.json(), cads = await cadR.json();
  const nome = id => cads.find(c => c.id === id)?.nome || "";
  return negs.map(n => ({ ...n, vendedor: nome(n.produtor_id), comprador: n.cliente_id ? nome(n.cliente_id) : (n.contraparte || "") }));
}

// Legenda só com o número ("141", "CT 141", "CT-2026-141") aponta o contrato sem depender da IA.
function contratoPelaLegenda(legenda, contratos) {
  const m = String(legenda || "").trim().match(/^(?:ct[\s-]*)?(?:(\d{4})[\s-]+)?0*(\d{1,4})$/i);
  if (!m) return null;
  return contratos.find(c => {
    const cm = String(c.numero_contrato).match(/^CT-(\d{4})-0*(\d+)$/i);
    return cm && cm[2] === m[2] && (!m[1] || cm[1] === m[1]);
  }) || null;
}

// Número do contrato escrito no nome do arquivo ou na legenda ("CT 140", "CTR 140", "CT-2026-140").
// "CONF. 4061" e afins são o número do contrato do comprador, não o nosso, e não contam.
function contratoPeloTexto(texto, contratos) {
  const m = String(texto || "").match(/\b(?:CTR?|CONTRATO)[\s.:\-]*(?:(\d{4})[\s\-]+)?0*(\d{1,4})\b/i);
  if (!m) return null;
  return contratos.find(c => {
    const cm = String(c.numero_contrato).match(/^CT-(\d{4})-0*(\d+)$/i);
    return cm && cm[2] === m[2] && (!m[1] || cm[1] === m[1]);
  }) || null;
}

// Contrato pelas partes: o vendedor e o comprador do contrato aparecem no nome do arquivo, na legenda
// ou na leitura da IA. Só vale se sobrar UM contrato (em aberto, do mesmo grão quando a IA leu o grão);
// com dois ou mais contratos entre as mesmas partes, continua perguntando.
const PALAVRAS_GENERICAS = new Set(["fazenda", "agro", "agropecuaria", "agricola", "comercio", "comercial", "cereais", "graos", "industria", "cooperativa", "participacoes", "transporte", "ltda", "eireli", "sa", "me", "de", "da", "do", "dos", "das", "grupo", "total", "central", "alimentos", "brasil", "sgo", "camapua", "filial", "armazenagem", "corretora", "filhas", "santa", "santo"]);
const normTxt = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function chavesNome(nome) {
  return normTxt(nome).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !PALAVRAS_GENERICAS.has(w));
}
function contratoPelasPartes(texto, contratos, grao) {
  const t = " " + normTxt(texto).replace(/[^a-z0-9]+/g, " ") + " ";
  // Primeira e última palavra do nome (ex.: "jonis" e "assmann"; empresa de uma palavra só: só ela).
  const tem = nome => { const k = chavesNome(nome); return k.length > 0 && t.includes(` ${k[0]} `) && t.includes(` ${k[k.length - 1]} `); };
  let cand = contratos.filter(c => c.vendedor && c.comprador && tem(c.vendedor) && tem(c.comprador));
  if (grao) cand = cand.filter(c => !c.grao || normTxt(c.grao) === normTxt(grao));
  const abertos = cand.filter(c => !/finalizado|cancelado/i.test(c.status || ""));
  if (abertos.length === 1) return abertos[0];
  if (abertos.length === 0 && cand.length === 1) return cand[0];
  return null;
}

// A IA às vezes classifica a NFP ou a contra nota como "outro" mesmo dizendo no motivo o que é.
function corrigirTipo(l, nomeArq) {
  if (l.tipo !== "outro") return;
  const t = `${nomeArq} ${l.motivo || ""} ${l.nome_sugerido || ""}`;
  if (/contra[\s.\-]*n(ota|f)/i.test(t)) l.tipo = "contra_nota";
  else if (/\bNFP\b|nota fiscal (do|de) produtor/i.test(t)) l.tipo = "nota_produtor";
  if (!l.numero_documento) {
    const num = t.match(/\bNFP(?:[\s\-]*SE)?[\s.:\-]*(\d{5,9})\b/i);
    if (num && l.tipo === "nota_produtor") l.numero_documento = num[1];
  }
}

// Guarda no histórico da conversa com a assistente (assistente-whatsapp-background), pra ela saber
// o que foi mandado e poder salvar depois um documento que ficou pendente.
async function historico(adminHeaders, telefone, textoUsuario, textoAssistente) {
  await fetch(`${SUPABASE_URL}/rest/v1/nexus_assistente_msgs`, {
    method: "POST", headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify([{ telefone, role: "user", texto: textoUsuario }, { telefone, role: "assistant", texto: textoAssistente }]),
  }).catch(() => {});
}

export default async (req) => {
  const p = await req.json().catch(() => null);
  if (!p || p.secret !== process.env.WHATSAPP_WEBHOOK_SECRET) return;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const nomeArq = p.fileName || "documento";

  try {
    const mime = String(p.mime || "").split(";")[0].trim().toLowerCase();
    if (!MIMES_OK[mime]) return responder(p.phone, `📎 ${nomeArq}: só consigo ler PDF ou foto (JPG/PNG). Esse veio como ${mime || "formato desconhecido"}.`);

    const arq = await fetch(p.url);
    if (!arq.ok) return responder(p.phone, `📎 ${nomeArq}: não consegui baixar o arquivo do WhatsApp. Manda de novo?`);
    const base64 = Buffer.from(await arq.arrayBuffer()).toString("base64");

    const contratos = await carregarContratos(adminHeaders);
    const lido = await lerComIA({
      base64, mime, nomeOriginal: nomeArq, dica: p.caption, timeoutMs: 120000, origem: "documento-whatsapp",
      contratos: contratos.map(n => ({ numero: n.numero_contrato, vendedor: n.vendedor, comprador: n.comprador, grao: n.grao, safra: n.safra, quantidade: n.quantidade, preco: n.preco, data: n.data, status: n.status })),
    });
    if (!lido.ok) return responder(p.phone, `📎 ${nomeArq}: ${lido.erro}`);
    const l = lido.leitura;
    console.log("LEITURA", JSON.stringify(l), "legenda:", JSON.stringify(p.caption || ""));

    // Documento de cadastro (CNH, IE, endereço, banco): vai pra PRODUTORES / CLIENTES / NOME e os dados ficam
    // no histórico da conversa; quando o corretor disser "cria o cadastro", a assistente junta tudo e cria.
    if (TIPOS_CADASTRO.has(l.tipo)) {
      const c = l.cadastro || {};
      const nomeTitular = c.nome || (p.caption && !/^\s*\d/.test(p.caption) ? p.caption : "");
      const extCad = MIMES_OK[mime];
      const salvoCad = await salvarNoDrive({ base64, mime, nome_arquivo: `${nomeArquivoDoc(l, null)}.${extCad}`, caminho: caminhoCliente(nomeTitular) });
      const tipoCad = TIPO_LABEL[l.tipo];
      const rotulos = { nome: "Nome", cpf: "CPF", cnpj: "CNPJ", rg: "RG", data_nascimento: "Nascimento", inscricao_estadual: "IE", fazenda: "Fazenda", municipio_fazenda: "Município da fazenda", endereco: "Endereço", numero: "Nº", bairro: "Bairro", cidade: "Cidade", uf: "UF", cep: "CEP", banco: "Banco", agencia: "Agência", conta: "Conta", tipo_conta: "Tipo", pix: "PIX", titular_conta: "Titular", email: "E-mail", telefone: "Telefone" };
      const linhas = Object.entries(rotulos).filter(([k]) => c[k]).map(([k, r]) => `• ${r}: ${k === "data_nascimento" ? c[k].split("-").reverse().join("/") : c[k]}`);
      const msgCad = `🪪 *${tipoCad}*${nomeTitular ? ` de *${nomeTitular}*` : ""}\n${linhas.join("\n") || "Não consegui ler os dados."}${salvoCad.ok ? `\n\nGuardei no Drive em ${salvoCad.pasta}.` : `\n\n⚠️ Não consegui salvar no Drive: ${salvoCad.erro}`}\n\nManda os outros documentos (CNH, IE, endereço, banco) e, quando terminar, diz *cria o cadastro*.`;
      await historico(adminHeaders, p.phone, `[enviou documento de cadastro: ${nomeArq}${p.caption ? ` · legenda: "${p.caption}"` : ""}]`, `${msgCad}\n(dados lidos do documento: ${JSON.stringify({ tipo: l.tipo, ...c })})`);
      return responder(p.phone, msgCad);
    }

    corrigirTipo(l, nomeArq);
    const pelaLegenda = contratoPelaLegenda(p.caption, contratos) || contratoPeloTexto(`${nomeArq} ${p.caption || ""}`, contratos);
    const pelaIA = l.contrato_numero && l.confianca === "alta" ? contratos.find(c => c.numero_contrato === l.contrato_numero) : null;
    const pelasPartes = !pelaLegenda && !pelaIA ? contratoPelasPartes(`${nomeArq} ${p.caption || ""} ${l.motivo || ""}`, contratos, l.grao) : null;
    const n = pelaLegenda || pelaIA || pelasPartes;
    const tipo = TIPO_LABEL[l.tipo] || "Documento";
    const ext = MIMES_OK[mime];
    const textoUsuario = `[enviou um documento: ${nomeArq}${p.caption ? ` · legenda: "${p.caption}"` : ""}]`;
    if (!n) {
      // Guarda o arquivo e espera o corretor dizer o contrato ("141" ou "sim"); a assistente salva depois.
      const path = `pendentes/${randomUUID()}.${ext}`;
      await fetch(`${SUPABASE_URL}/storage/v1/object/nexus-anexos/${path}`, { method: "POST", headers: { ...adminHeaders, "Content-Type": mime }, body: Buffer.from(base64, "base64") });
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/nexus_assistente_docs`, {
        method: "POST", headers: { ...adminHeaders, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ telefone: p.phone, storage_path: path, mime, nome_original: nomeArq, leitura: l }),
      }).then(r => r.json());
      const docId = ins?.[0]?.id;
      const palpite = l.contrato_numero ? `Acho que é do *${l.contrato_numero}*. É esse? Responde *sim* ou o número do contrato.` : "De qual contrato é? Responde só com o número (ex.: *141*).";
      const msg = `🤔 Li como *${tipo}*, mas não tenho certeza do contrato.\n${l.motivo || ""}\n\n${palpite}`;
      await historico(adminHeaders, p.phone, textoUsuario, `${msg}\n(documento pendente id: ${docId}; leitura: ${JSON.stringify({ tipo: l.tipo, palpite: l.contrato_numero, valor: l.valor, data: l.data })})`);
      return responder(p.phone, msg);
    }

    const salvo = await salvarNoDrive({
      base64, mime, nome_arquivo: `${nomeArquivoDoc(l, n)}.${ext}`,
      contrato: n.numero_contrato, nome_pasta: nomePastaContrato(n), data_negocio: n.data,
    });
    if (!salvo.ok) return responder(p.phone, `📎 ${nomeArq}: li como ${tipo} do ${n.numero_contrato}, mas o Drive deu erro: ${salvo.erro}`);

    // Cópia nos anexos da negociação (o Storage não aceita acento nem alguns símbolos no nome).
    const nomeStorage = salvo.nome.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.\- ()]/g, "_");
    await fetch(`${SUPABASE_URL}/storage/v1/object/nexus-anexos/${n.id}/${Date.now()}_${encodeURIComponent(nomeStorage)}`, {
      method: "POST", headers: { ...adminHeaders, "Content-Type": mime }, body: Buffer.from(base64, "base64"),
    }).catch(() => {});

    const feito = await aplicarDocumentoNoNegocio({ negocioId: n.id, leitura: l, nomeArquivo: salvo.nome, origem: "whatsapp" }).catch(e => [`⚠️ Não consegui atualizar o checklist (${e.message})`]);
    const aviso = pelasPartes && !pelaLegenda && !pelaIA ? `\n\n_Achei pelo vendedor e comprador (único contrato em aberto entre eles). Se não for esse, me avisa._` : "";
    const msg = `✅ *${tipo}* · ${n.numero_contrato} (${n.vendedor} x ${n.comprador})\nSalvo como: ${salvo.nome}\n${salvo.url}${feito.length ? "\n\n" + feito.join("\n") : ""}${aviso}`;
    await historico(adminHeaders, p.phone, textoUsuario, msg);
    await responder(p.phone, msg);
  } catch (e) {
    await responder(p.phone, `📎 ${nomeArq}: deu um erro ao processar (${e.message}). Tenta pelo painel em Negociações → Documentos.`);
  }
};
