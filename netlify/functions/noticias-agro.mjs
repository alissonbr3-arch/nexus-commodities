const FEEDS = [
  { url: "https://www.agrolink.com.br/rss/noticias.xml", fonte: "Agrolink", filtrar: false },
  { url: "https://g1.globo.com/rss/g1/economia/agronegocios/", fonte: "G1 Agro", filtrar: false },
  { url: "https://www.canalrural.com.br/feed/", fonte: "Canal Rural", filtrar: true },
];
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

function parsearRss(xml, fonte) {
  const itensXml = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return itensXml.map(bloco => ({
    titulo: extrairTag(bloco, "title"),
    link: extrairTag(bloco, "link"),
    data: extrairTag(bloco, "pubDate"),
    fonte,
  })).filter(it => it.titulo && it.link);
}

function normalizarTitulo(titulo) {
  return titulo.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

// Busca notícias do agronegócio em várias fontes (Agrolink, G1 Agro, Canal Rural) e
// combina tudo — dá volume suficiente pro ticker da TV não repetir rápido demais.
// Não precisa de login — são só manchetes públicas.
export default async () => {
  try {
    const respostas = await Promise.allSettled(FEEDS.map(f =>
      fetch(f.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; NexusCommoditiesTV/1.0)" } }).then(async r => {
        if (!r.ok) throw new Error(`${f.fonte} retornou ${r.status}`);
        const xml = await r.text();
        let itens = parsearRss(xml, f.fonte);
        if (f.filtrar) itens = itens.filter(it => PALAVRAS_RELEVANTES.some(p => it.titulo.toLowerCase().includes(p)));
        return itens;
      })
    ));

    const todos = respostas.filter(r => r.status === "fulfilled").flatMap(r => r.value);
    if (todos.length === 0) throw new Error("Nenhuma fonte de notícias respondeu.");

    const vistos = new Set();
    const unicos = todos.filter(it => {
      const chave = normalizarTitulo(it.titulo);
      if (vistos.has(chave)) return false;
      vistos.add(chave);
      return true;
    });
    unicos.sort((a, b) => new Date(b.data || 0) - new Date(a.data || 0));

    const itens = unicos.slice(0, 60);
    return json({ ok: true, itens, atualizado_em: new Date().toISOString(), fontes: FEEDS.map(f => f.fonte) });
  } catch (e) {
    return json({ ok: false, erro: String(e.message || e) }, 500);
  }
};
