const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";

// Contratos CBOT que sabemos buscar automaticamente via Yahoo Finance.
// fatorKg = kg por bushel (soja: 27.2155kg, milho: 25.401kg) — usado pra
// converter cents/bushel em R$/saca de 60kg.
const ATIVOS = [
  { codigo: "ZSX26.CBT", produto: "Soja", mes: "Novembro", fatorKg: 27.2155 },
  { codigo: "ZSH27.CBT", produto: "Soja", mes: "Março", fatorKg: 27.2155 },
  { codigo: "ZC=F", produto: "Milho", mes: "CBOT", fatorKg: 25.401 },
];

const BCB_PTAX = "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)";

function mmddyyyy(d) { return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${d.getUTCFullYear()}`; }

// Atualiza o dólar do painel sozinho: PTAX de venda do Banco Central (fechamento do último dia
// útil publicado) em ptax_auto, e o dólar à vista (USD/BRL, Yahoo Finance) em atual/anterior/
// variação — antes eram digitados à mão e o PTAX automático dependia de uma tarefa externa que
// parou de rodar. Também alimenta a linha "Dólar" da tabela de cotações. Cada fonte falha
// sozinha, sem derrubar a outra.
export async function atualizarDolar() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return { ok: false, erro: "SUPABASE_SERVICE_ROLE_KEY não configurada." };
  const sbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const patch = {};
  const resultado = { ptax: null, spot: null };

  try {
    const fim = new Date(), ini = new Date(Date.now() - 10 * 86400000);
    const url = `${BCB_PTAX}?@dataInicial='${mmddyyyy(ini)}'&@dataFinalCotacao='${mmddyyyy(fim)}'&$orderby=dataHoraCotacao%20desc&$top=1&$format=json`;
    const r = await fetch(url);
    const linha = (await r.json())?.value?.[0];
    if (r.ok && linha?.cotacaoVenda) {
      patch.ptax_auto = Number(linha.cotacaoVenda);
      patch.ptax_auto_data = String(linha.dataHoraCotacao).slice(0, 10);
      patch.ptax_auto_updated_at = new Date().toISOString();
      resultado.ptax = { valor: patch.ptax_auto, data: patch.ptax_auto_data };
    } else resultado.ptax = { erro: `BCB sem dados (HTTP ${r.status})` };
  } catch (e) { resultado.ptax = { erro: String(e) }; }

  try {
    const r = await fetch(`${YAHOO_BASE}${encodeURIComponent("BRL=X")}`, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } });
    const meta = (await r.json())?.chart?.result?.[0]?.meta;
    if (r.ok && meta?.regularMarketPrice != null) {
      const atual = Number(meta.regularMarketPrice);
      const anterior = Number(meta.chartPreviousClose ?? meta.previousClose ?? 0);
      patch.atual = atual;
      if (anterior) { patch.anterior = anterior; patch.variacao = atual - anterior; }
      resultado.spot = { atual, anterior };
      await fetch(`${SUPABASE_URL}/rest/v1/nexus_cotacoes?codigo=eq.${encodeURIComponent("USD/BRL")}`, {
        method: "PATCH", headers: sbHeaders,
        body: JSON.stringify({ ultima: atual, varr: anterior ? atual - anterior : 0, pct: anterior ? ((atual - anterior) / anterior) * 100 : 0, previa: anterior || atual, updated_at: new Date().toISOString() }),
      });
    } else resultado.spot = { erro: `Yahoo sem dados (HTTP ${r.status})` };
  } catch (e) { resultado.spot = { erro: String(e) }; }

  if (Object.keys(patch).length) {
    patch.updated_at = new Date().toISOString();
    const upd = await fetch(`${SUPABASE_URL}/rest/v1/nexus_dolar?id=eq.1`, { method: "PATCH", headers: sbHeaders, body: JSON.stringify(patch) });
    resultado.gravou = upd.ok;
  }
  return { ok: true, ...resultado };
}


// Milho B3 (futuro de milho da B3, R$/saca de 60 kg): o Yahoo Finance não tem esse contrato, então
// lê o fechamento do último pregão no Notícias Agrícolas (fonte: B3). Usa o vencimento mais
// próximo e escreve o mês no card ("B3 Nov/26"). É o fechamento (ajuste) do pregão anterior, não
// cotação ao vivo — muda uma vez por dia útil.
const MESES_ABREV = { janeiro: "Jan", fevereiro: "Fev", março: "Mar", abril: "Abr", maio: "Mai", junho: "Jun", julho: "Jul", agosto: "Ago", setembro: "Set", outubro: "Out", novembro: "Nov", dezembro: "Dez" };
export function lerMilhoB3(html) {
  const tabelas = html.match(/<table[^>]*class="cot-fisicas"[\s\S]*?<\/table>/g) || [];
  for (const tb of tabelas) {
    const linhas = [...tb.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => c[1].replace(/<[^>]+>/g, "").trim()));
    const dados = linhas.find(c => /^[A-Za-zçÇ]+\/\d{4}$/.test(c[0] || "") && c.length >= 3);
    if (!dados) continue;
    // A data "Fechamento: dd/mm/aaaa" fica ANTES da tabela do pregão (depois dela vem a do pregão anterior).
    const ini = html.indexOf(tb);
    const data = html.slice(Math.max(0, ini - 600), ini).match(/Fechamento:\s*(\d{2})\/(\d{2})\/(\d{4})(?![\s\S]*Fechamento:)/);
    const [mesNome, ano] = dados[0].split("/");
    const num = t => Number(String(t).replace(/\./g, "").replace(",", "."));
    const ultima = num(dados[1]), pct = num(dados[2]);
    if (!(ultima > 0)) continue;
    return { ultima, pct, mes: `B3 ${MESES_ABREV[mesNome.toLowerCase()] || mesNome}/${ano.slice(2)}`, data: data ? `${data[3]}-${data[2]}-${data[1]}` : null };
  }
  return null;
}
export async function atualizarMilhoB3() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  try {
    const r = await fetch("https://www.noticiasagricolas.com.br/cotacoes/milho/milho-b3-prego-regular", { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } });
    if (!r.ok) return { codigo: "CCM", ok: false, erro: `HTTP ${r.status}` };
    const b3 = lerMilhoB3(await r.text());
    if (!b3) return { codigo: "CCM", ok: false, erro: "não achei a tabela do Milho B3 na página" };
    const anterior = b3.pct > -100 ? b3.ultima / (1 + b3.pct / 100) : b3.ultima;
    const upd = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cotacoes?codigo=eq.CCM`, {
      method: "PATCH", headers: sbHeaders,
      body: JSON.stringify({ ultima: b3.ultima, varr: b3.ultima - anterior, pct: b3.pct, previa: anterior, preco_saca_brl: b3.ultima, mes: b3.mes, updated_at: new Date().toISOString() }),
    });
    await fetch(`${SUPABASE_URL}/rest/v1/nexus_cotacoes_historico?on_conflict=codigo,data`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ codigo: "CCM", produto: "Milho", mes: "B3", data: b3.data || new Date().toISOString().slice(0, 10), ultima: b3.ultima, preco_saca_brl: b3.ultima }),
    });
    return { codigo: "CCM", produto: "Milho", mes: b3.mes, ultima: b3.ultima, pct: b3.pct, fechamento: b3.data, ok: upd.ok, status: upd.status };
  } catch (e) { return { codigo: "CCM", ok: false, erro: String(e) }; }
}

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

  const dolar = await atualizarDolar();
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

  resultados.push(await atualizarMilhoB3());
  return { ok: true, cambio, dolar, atualizadoEm: new Date().toISOString(), resultados };
}
