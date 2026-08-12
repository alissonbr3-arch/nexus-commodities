const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";

// Contratos CBOT que sabemos buscar automaticamente via Yahoo Finance.
// fatorKg = kg por bushel (soja: 27.2155kg, milho: 25.401kg) — usado pra
// converter cents/bushel em R$/saca de 60kg.
const ATIVOS = [
  { codigo: "ZSU26.CBT", produto: "Soja", mes: "Setembro", fatorKg: 27.2155 },
  { codigo: "ZSX26.CBT", produto: "Soja", mes: "Novembro", fatorKg: 27.2155 },
  { codigo: "ZSH27.CBT", produto: "Soja", mes: "Março", fatorKg: 27.2155 },
  { codigo: "ZC=F", produto: "Milho", mes: "CBOT", fatorKg: 25.401 },
];

export async function atualizarCotacoes() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return { ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada nas variáveis de ambiente do Netlify." };
  }
  const sbHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };

  let cambio = 5.0;
  try {
    const dolarResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_dolar?id=eq.1&select=*`, { headers: sbHeaders });
    const dolarRows = await dolarResp.json();
    const d = dolarRows[0] || {};
    cambio = Number(d.ptax_auto || d.atual || d.ptax || 0) || 5.0;
  } catch (e) {
    // segue com câmbio padrão se falhar
  }

  const resultados = [];
  for (const ativo of ATIVOS) {
    try {
      const r = await fetch(`${YAHOO_BASE}${encodeURIComponent(ativo.codigo)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      });
      if (!r.ok) { resultados.push({ codigo: ativo.codigo, ok: false, erro: `HTTP ${r.status}` }); continue; }
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (!meta || meta.regularMarketPrice == null) {
        resultados.push({ codigo: ativo.codigo, ok: false, erro: j?.chart?.error?.description || "sem dados" });
        continue;
      }
      const ultima = Number(meta.regularMarketPrice || 0);
      const anterior = Number(meta.chartPreviousClose ?? meta.previousClose ?? 0);
      const varr = ultima - anterior;
      const pct = anterior ? (varr / anterior) * 100 : 0;
      const precoSaca = (ultima / 100 / ativo.fatorKg) * 60 * cambio;

      const payload = {
        ultima,
        varr,
        pct,
        previa: anterior,
        preco_saca_brl: precoSaca,
        updated_at: new Date().toISOString(),
      };
      const upd = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cotacoes?codigo=eq.${encodeURIComponent(ativo.codigo)}`, {
        method: "PATCH",
        headers: sbHeaders,
        body: JSON.stringify(payload),
      });
      await fetch(`${SUPABASE_URL}/rest/v1/nexus_cotacoes_historico?on_conflict=codigo,data`, {
        method: "POST",
        headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          codigo: ativo.codigo,
          produto: ativo.produto,
          mes: ativo.mes,
          data: new Date().toISOString().slice(0, 10),
          ultima,
          preco_saca_brl: precoSaca,
        }),
      });
      resultados.push({ codigo: ativo.codigo, produto: ativo.produto, mes: ativo.mes, ultima, precoSaca: Number(precoSaca.toFixed(2)), ok: upd.ok, status: upd.status });
    } catch (e) {
      resultados.push({ codigo: ativo.codigo, ok: false, erro: String(e) });
    }
  }

  return { ok: true, cambio, atualizadoEm: new Date().toISOString(), resultados };
}
