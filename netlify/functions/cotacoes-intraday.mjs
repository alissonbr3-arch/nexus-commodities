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

import { pregaoB3Aberto } from "./_cotacoes-lib.mjs";

// Milho B3: os dois primeiros vencimentos (hoje Novembro e Janeiro). Fechamentos e histórico vêm do Notícias
// Agrícolas (fonte B3); com o pregão aberto e o fechamento de hoje ainda sem sair, o preço do dia vem do
// scanner público do TradingView (atraso de ~15 min). Se a fonte do preço do dia falhar, fica o fechamento.
const MES_ABREV = { janeiro: "Jan", fevereiro: "Fev", marco: "Mar", abril: "Abr", maio: "Mai", junho: "Jun", julho: "Jul", agosto: "Ago", setembro: "Set", outubro: "Out", novembro: "Nov", dezembro: "Dez" };
const LETRA_MES = { janeiro: "F", marco: "H", maio: "K", julho: "N", setembro: "U", novembro: "X" };
const semAcento = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const num = t => Number(String(t).replace(/\./g, "").replace(",", "."));
async function milhoB3() {
  const r = await fetch("https://www.noticiasagricolas.com.br/cotacoes/milho/milho-b3-prego-regular", { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } });
  if (!r.ok) return [];
  const html = await r.text();
  // cada tabela vem logo depois do "Fechamento: dd/mm/aaaa" do seu dia, do mais recente pro mais antigo
  const dias = [...html.matchAll(/Fechamento:\s*(\d{2})\/(\d{2})\/(\d{4})([\s\S]*?<table[^>]*class="cot-fisicas"[\s\S]*?<\/table>)/g)].map(m => {
    const linhas = [...m[4].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(x => [...x[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1].replace(/<[^>]+>/g, "").trim())).filter(c => c.length >= 3 && /^[A-Za-zçÇ]+\/\d{4}$/.test(c[0]));
    return { data: `${m[3]}-${m[2]}-${m[1]}`, linhas };
  }).filter(d => d.linhas.length);
  if (!dias.length) return [];
  const ultimo = dias[0], aberto = pregaoB3Aberto({ data: ultimo.data });
  const alvos = ultimo.linhas.slice(0, 2).map(l => { const [mes, ano] = l[0].split("/"); return { rotulo: l[0], chave: semAcento(mes), ano: ano.slice(2), fechamento: num(l[1]), pct: num(l[2]) }; });
  // preço do dia dos dois contratos numa chamada só
  let vivo = {};
  if (aberto) {
    try {
      const tickers = alvos.filter(a => LETRA_MES[a.chave]).map(a => `BMFBOVESPA:CCM${LETRA_MES[a.chave]}20${a.ano}`);
      const j = await (await fetch("https://scanner.tradingview.com/futures/scan", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" }, body: JSON.stringify({ symbols: { tickers }, columns: ["close", "update_mode"] }) })).json();
      (j.data || []).forEach(d => { const [close, modo] = d.d || []; if (close > 0 && /delayed|streaming/.test(String(modo))) vivo[d.s.split(":")[1]] = Number(close); });
    } catch {}
  }
  const local = new Date(Date.now() - 4 * 3600 * 1000), hora = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  return alvos.map((a, k) => {
    const nome = `Milho B3 ${MES_ABREV[a.chave] || a.rotulo.split("/")[0]}/${a.ano}`;
    const preco = vivo[`CCM${LETRA_MES[a.chave]}20${a.ano}`] || null;
    const serie = dias.slice(0, 12).reverse().map(d => { const l = d.linhas.find(x => semAcento(x[0]) === semAcento(a.rotulo)); return l ? { rotulo: `${d.data.slice(8)}/${d.data.slice(5, 7)}`, v: num(l[1]) } : null; }).filter(Boolean);
    const atual = preco || a.fechamento;
    return { codigo: "CCM-" + (k + 1), nome, grupo: "B3", preco: atual, anterior: preco ? a.fechamento : a.fechamento / (1 + a.pct / 100), variacao: preco ? preco - a.fechamento : a.fechamento - a.fechamento / (1 + a.pct / 100), pct: preco ? (preco / a.fechamento - 1) * 100 : a.pct, horario: preco ? Math.floor(Date.now() / 1000) : null, serie, fechamentos: true,
      obs: preco ? `Preço do dia · atraso de 15 min · ${hora} · ref. fechamento anterior` : `Fechamento de ${ultimo.data.slice(8)}/${ultimo.data.slice(5, 7)}` };
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
  const b3 = await milhoB3().catch(() => []);
  itens.push(...b3);
  if (!itens.length) return json({ ok: false, erro: "Nenhuma cotação respondeu." }, 502);
  return json({ ok: true, itens, atualizado_em: new Date().toISOString() });
};
