const FEED_URL = "https://www.canalrural.com.br/feed/";
const PALAVRAS_RELEVANTES = [
  "soja", "milho", "sorgo", "milheto", "grão", "grãos", "commodities", "commodity",
  "cotação", "cotações", "dólar", "cbot", "exportação", "exportações", "safra",
  "preço", "preços", "mercado", "agro", "cepea", "porto", "frete",
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}

function decodificarEntidades(str) {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function extrairTag(bloco, tag) {
  const m = bloco.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodificarEntidades(m[1]) : "";
}

function parsearRss(xml) {
  const itensXml = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return itensXml.map(bloco => ({
    titulo: extrairTag(bloco, "title"),
    link: extrairTag(bloco, "link"),
    data: extrairTag(bloco, "pubDate"),
  })).filter(it => it.titulo && it.link);
}

// Busca as notícias mais recentes do agronegócio (Canal Rural) e prioriza as relacionadas
// a grãos/commodities. Não precisa de login — são só manchetes públicas.
export default async () => {
  try {
    const resp = await fetch(FEED_URL, { headers: { "User-Agent": "Mozilla/5.0 (compatible; NexusCommoditiesTV/1.0)" } });
    if (!resp.ok) throw new Error(`Feed retornou ${resp.status}`);
    const xml = await resp.text();
    const todos = parsearRss(xml);
    const relevantes = todos.filter(it => PALAVRAS_RELEVANTES.some(p => it.titulo.toLowerCase().includes(p)));
    const itens = (relevantes.length >= 2 ? relevantes : todos).slice(0, 12);
    return json({ ok: true, itens, atualizado_em: new Date().toISOString(), fonte: "Canal Rural" });
  } catch (e) {
    return json({ ok: false, erro: String(e.message || e) }, 500);
  }
};
