// Preço do dia (atraso de ~15 min) e curva intradiária de Soja/Milho CBOT, Brent e dólar, pro slide "Chicago ao vivo"
// e pro alerta de movimento da TV. Só leitura de dados públicos do Yahoo Finance — sem login, sem chave.
const ATIVOS = [
  { codigo: "ZSX26.CBT", nome: "Soja Nov/26", grupo: "Soja" },
  { codigo: "ZSH27.CBT", nome: "Soja Mar/27", grupo: "Soja" },
  { codigo: "ZC=F", nome: "Milho CBOT", grupo: "Milho" },
  { codigo: "BZ=F", nome: "Petróleo Brent", grupo: "Brent" },
  { codigo: "BRL=X", nome: "Dólar", grupo: "Dólar" },
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" },
  });
}

import { lerFechamentoMilhoB3, milhoB3AoVivo, pregaoB3Aberto } from "./_cotacoes-lib.mjs";

// Milho B3: preço do dia (atraso de ~15 min) quando o pregão está aberto e o fechamento de hoje ainda não saiu;
// fora disso não devolve nada e a TV segue com o fechamento gravado no sistema.
async function milhoB3() {
  const b3 = await lerFechamentoMilhoB3();
  if (!pregaoB3Aberto(b3)) return null;
  const preco = await milhoB3AoVivo(b3.mes);
  if (!preco) return null;
  return { codigo: "CCM", nome: "Milho " + b3.mes, grupo: "B3", preco, anterior: b3.ultima, variacao: preco - b3.ultima, pct: (preco / b3.ultima - 1) * 100, horario: Math.floor(Date.now() / 1000), serie: [] };
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
  const b3 = await milhoB3().catch(() => null);
  if (b3) itens.push(b3);
  if (!itens.length) return json({ ok: false, erro: "Nenhuma cotação respondeu." }, 502);
  return json({ ok: true, itens, atualizado_em: new Date().toISOString() });
};
