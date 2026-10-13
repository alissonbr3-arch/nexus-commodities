const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const INICIO_MERCADO = "2026-07-13"; // primeiro negócio gerado
const SAFRAS_PRECO = [
  { grao: "Soja", safra: "2025/2026", label: "Soja 25/26" },
  { grao: "Milho", safra: "2026/2026", label: "Milho 26/26" },
  { grao: "Soja", safra: "2026/2027", label: "Soja 26/27" },
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// Dados da TV do escritório, SEM login: o painel /tv abre com o link ?k=<chave> (guardada no
// navegador da TV). A chave é a variável TV_KEY do Netlify. Só sai o que a TV mostra — cotações,
// dólar e números AGREGADOS dos negócios (por grão/safra/mês). Nenhum nome de cliente, nenhum
// negócio individual e nenhum valor de comissão sai daqui.
export default async (req) => {
  const { SUPABASE_SERVICE_ROLE_KEY, TV_KEY } = process.env;
  if (!SUPABASE_SERVICE_ROLE_KEY || !TV_KEY) return json({ ok: false, erro: "TV não configurada." }, 500);
  const k = new URL(req.url).searchParams.get("k") || "";
  if (k.length !== TV_KEY.length || k !== TV_KEY) return json({ ok: false, erro: "Link da TV inválido." }, 401);

  const H = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const get = async (path, unico = false) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
    const j = await r.json().catch(() => (unico ? null : []));
    return unico ? (Array.isArray(j) ? j[0] || null : j) : (Array.isArray(j) ? j : []);
  };
  const [cotacoes, dolar, historico, negocios, cfg, compradoresRows] = await Promise.all([
    get("nexus_cotacoes?select=produto,mes,codigo,ultima,varr,pct,preco_saca_brl&order=produto"),
    get("nexus_dolar?id=eq.1&select=ptax,ptax_auto,ptax_auto_data,atual,anterior,variacao", true),
    get("nexus_cotacoes_historico?select=codigo,produto,mes,data,preco_saca_brl&order=data&limit=2000"),
    get("nexus_negocios?deleted_at=is.null&select=data,grao,safra,quantidade,preco,preco_liquido,funrural_forma,comissao,comissao_pagador,cliente_id,produtor_id,contraparte&limit=5000"),
    get("nexus_config?id=eq.1&select=fundersul_saca,fundems_saca,funrural_pct", true),
    get("nexus_cadastros?tipo=eq.Comprador&select=id,categoria_comprador"),
  ]);
  const compradores = new Map(compradoresRows.map(c => [c.id, c]));
  const c = cfg || {};

  // Mesma conta do painel (precoLiquidoNegocio): bruto − comissão do vendedor − SENAR − Fundersul/Fundems
  // (exceto Cooperativa/Cerealista) − Funrural.
  const precoLiquido = n => {
    const sacas = Number(n.quantidade || 0), total = Number(n.preco || 0) * sacas;
    const comp = compradores.get(n.cliente_id);
    const aplica = !comp || (comp.categoria_comprador !== "Cooperativa" && comp.categoria_comprador !== "Cerealista");
    const fundersul = aplica ? Number(c.fundersul_saca || 0) * sacas : 0, fundems = aplica ? Number(c.fundems_saca || 0) * sacas : 0;
    const funrural = (n.funrural_forma || "Comercialização") === "Comercialização" ? total * Number(c.funrural_pct || 0) / 100 : 0;
    const comVend = n.comissao_pagador === "Comprador" ? 0 : Number(n.comissao || 0);
    const estimado = total - comVend - total * 0.002 - fundersul - fundems - funrural;
    const informado = n.preco_liquido != null && n.preco_liquido !== "";
    return informado ? Number(n.preco_liquido) : (sacas ? estimado / sacas : 0);
  };
  const media = l => l.reduce((a, b) => a + b, 0) / l.length;

  // volume por mês e grão (últimos 6 meses)
  const agora = new Date(Date.now() - 4 * 3600 * 1000); // Campo Grande
  const meses = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - i, 1)); meses.push(d.toISOString().slice(0, 7)); }
  const graos = [...new Set(negocios.map(n => n.grao).filter(Boolean))];
  const volumeMensal = { meses, series: graos.map(g => ({ grao: g, valores: meses.map(m => negocios.filter(n => n.grao === g && (n.data || "").startsWith(m)).reduce((s, n) => s + Number(n.quantidade || 0), 0)) })) };

  // preços médios por safra
  const precosSafra = SAFRAS_PRECO.map(sf => {
    const p = negocios.filter(n => n.grao === sf.grao && n.safra === sf.safra && Number(n.preco) > 0).map(precoLiquido);
    return p.length ? { label: sf.label, qtd: p.length, min: Math.min(...p), max: Math.max(...p), media: media(p) } : { label: sf.label, qtd: 0 };
  });

  // preço médio negociado por mês e grão (desde o 1º negócio)
  const base = negocios.filter(n => n.data && n.data >= INICIO_MERCADO && Number(n.preco) > 0);
  const mesesPreco = [...new Set(base.map(n => n.data.slice(0, 7)))].sort();
  const precoMes = { meses: mesesPreco, series: [...new Set(base.map(n => n.grao).filter(Boolean))].map(g => ({
    grao: g, valores: mesesPreco.map(m => { const l = base.filter(n => n.grao === g && n.data.startsWith(m)).map(precoLiquido); return l.length ? media(l) : null; }),
  })) };

  // curiosidades (sem comissão e sem nomes)
  const lista = negocios.filter(n => n.data && n.data >= INICIO_MERCADO);
  const sacas = lista.reduce((s, n) => s + Number(n.quantidade || 0), 0);
  const porGrao = {}; lista.forEach(n => { const g = n.grao || "—"; porGrao[g] = (porGrao[g] || 0) + Number(n.quantidade || 0); });
  const topGrao = Object.entries(porGrao).sort((a, b) => b[1] - a[1])[0] || null;
  const maior = lista.slice().sort((a, b) => Number(b.quantidade || 0) - Number(a.quantidade || 0))[0];
  const mesAtual = agora.toISOString().slice(0, 7);
  const curiosidades = {
    inicio: INICIO_MERCADO, sacas, negocios: lista.length,
    produtores: new Set(lista.map(n => n.produtor_id).filter(Boolean)).size,
    compradores: new Set(lista.map(n => n.cliente_id || n.contraparte).filter(Boolean)).size,
    sacasMes: lista.filter(n => n.data.startsWith(mesAtual)).reduce((s, n) => s + Number(n.quantidade || 0), 0),
    maiorNegocio: maior ? { sacas: Number(maior.quantidade || 0), descricao: `${maior.grao || ""} ${maior.safra || ""}`.trim() } : null,
    topGrao: topGrao ? { grao: topGrao[0], sacas: topGrao[1] } : null,
  };

  return json({ ok: true, atualizadoEm: new Date().toISOString(), cotacoes, dolar, historico, volumeMensal, precosSafra, precoMes, curiosidades });
};
