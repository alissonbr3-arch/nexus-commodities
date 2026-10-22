// Preço atual (atraso de ~15 min) de contratos de bolsa pra tela Investimentos do painel.
// GET ?s=tv:BMFBOVESPA:CCMX2026,yahoo:ZSX26.CBT  →  { ok, precos: { "<fonte>:<simbolo>": { preco, anterior } } }
// Só dados públicos (scanner do TradingView pra B3, Yahoo Finance pra CBOT) — sem login nem chave.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=30" },
  });
}

export default async (req) => {
  const pedidos = [...new Set((new URL(req.url).searchParams.get("s") || "").split(",").map(x => x.trim()).filter(Boolean))].slice(0, 40);
  const tv = pedidos.filter(p => p.startsWith("tv:")).map(p => p.slice(3)).filter(s => /^[A-Z0-9_.:!-]{3,40}$/.test(s));
  const yahoo = pedidos.filter(p => p.startsWith("yahoo:")).map(p => p.slice(6)).filter(s => /^[A-Z0-9=.^-]{2,20}$/.test(s));
  const precos = {};

  await Promise.allSettled([
    (async () => {
      if (!tv.length) return;
      const r = await fetch("https://scanner.tradingview.com/futures/scan", {
        method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA },
        body: JSON.stringify({ symbols: { tickers: tv }, columns: ["close", "change_abs", "pricescale", "minmov"] }),
      });
      const j = await r.json();
      (j.data || []).forEach(d => {
        const [close, chg] = d.d || [];
        if (close > 0) precos["tv:" + d.s] = { preco: Number(close), anterior: chg != null ? Number(close) - Number(chg) : null };
      });
    })(),
    ...yahoo.map(async s => {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=1d`, { headers: { "User-Agent": UA } });
      const meta = (await r.json())?.chart?.result?.[0]?.meta;
      if (meta && meta.regularMarketPrice != null) precos["yahoo:" + s] = { preco: Number(meta.regularMarketPrice), anterior: Number(meta.chartPreviousClose ?? meta.previousClose ?? 0) || null };
    }),
  ]);
  return json({ ok: true, precos, atualizado_em: new Date().toISOString() });
};
