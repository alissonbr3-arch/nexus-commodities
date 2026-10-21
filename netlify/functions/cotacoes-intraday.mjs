// Preço do dia (atraso de ~15 min) e curva intradiária de Soja/Milho CBOT e dólar, pro slide "Chicago ao vivo"
// e pro alerta de movimento da TV. Só leitura de dados públicos do Yahoo Finance — sem login, sem chave.
const ATIVOS = [
  { codigo: "ZSX26.CBT", nome: "Soja Nov/26", grupo: "Soja" },
  { codigo: "ZSH27.CBT", nome: "Soja Mar/27", grupo: "Soja" },
  { codigo: "ZC=F", nome: "Milho CBOT", grupo: "Milho" },
  { codigo: "BRL=X", nome: "Dólar", grupo: "Dólar" },
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" },
  });
}

export default async () => {
  const respostas = await Promise.allSettled(ATIVOS.map(async a => {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(a.codigo)}?interval=5m&range=1d`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    });
    if (!r.ok) throw new Error(`${a.codigo}: HTTP ${r.status}`);
    const res = (await r.json())?.chart?.result?.[0];
    const meta = res?.meta;
    if (!meta || meta.regularMarketPrice == null) throw new Error(`${a.codigo}: sem dados`);
    const ts = res.timestamp || [], fechos = res.indicators?.quote?.[0]?.close || [];
    const serie = ts.map((t, i) => ({ t, v: fechos[i] })).filter(p => p.v != null).map(p => ({ t: p.t, v: Number(p.v) }));
    const preco = Number(meta.regularMarketPrice), anterior = Number(meta.chartPreviousClose ?? meta.previousClose ?? 0);
    return { ...a, preco, anterior, variacao: anterior ? preco - anterior : 0, pct: anterior ? ((preco - anterior) / anterior) * 100 : 0, horario: meta.regularMarketTime || null, serie };
  }));
  const itens = respostas.filter(r => r.status === "fulfilled").map(r => r.value);
  if (!itens.length) return json({ ok: false, erro: "Nenhuma cotação respondeu." }, 502);
  return json({ ok: true, itens, atualizado_em: new Date().toISOString() });
};
