// Dados da TV do escritório, sem login: a TV (/tv) busca aqui só o que ela mostra. Aberto de propósito —
// decisão do Álisson em 16/11/2026 (digitar login com o controle remoto é ruim); quem tiver o endereço vê
// cotações, negócios da TV, pagamentos do dia e aniversariantes.
// q=dados      → cotações, dólar, histórico, negócios (campos da TV), config do preço líquido, compradores
// q=pagamentos → negócios com pagamento (ou parcela) na data ?hoje=AAAA-MM-DD
// q=pessoas    → cadastros e equipe (nomes e aniversários)

const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default async (req) => {
  const url = new URL(req.url);
  const { SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, erro: "Serviço indisponível." }, 503);
  const h = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
  const get = async (path) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h }); const j = await r.json().catch(() => null); return Array.isArray(j) ? j : []; };
  const q = url.searchParams.get("q");

  if (q === "dados") {
    const [cot, dolar, hist, negocios, cfg, compradores] = await Promise.all([
      get("nexus_cotacoes?select=*&order=produto"),
      get("nexus_dolar?id=eq.1&select=*"),
      get("nexus_cotacoes_historico?select=*&order=data&limit=2000"),
      get("nexus_negocios?deleted_at=is.null&select=id,created_at,data,grao,safra,quantidade,preco,preco_liquido,funrural_forma,comissao,comissao_pagador,cliente_id,produtor_id,corretor_id,contraparte&limit=5000"),
      get("nexus_config?id=eq.1&select=fundersul_saca,fundems_saca,funrural_pct,soja_contrato_vigente,soja_premio_basis,soja_taxa_portuaria,soja_frete,milho_desconto_b3"),
      get("nexus_cadastros?tipo=eq.Comprador&select=id,categoria_comprador"),
    ]);
    return json({ ok: true, cot, dolar: dolar[0] || null, hist, negocios, cfg: cfg[0] || null, compradores });
  }
  if (q === "pagamentos") {
    const hoje = url.searchParams.get("hoje");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hoje || "")) return json({ ok: false, erro: "Data inválida." }, 400);
    const ou = encodeURIComponent(`(data_pagamento.eq.${hoje},pagamentos_extra.cs.${JSON.stringify([{ data: hoje }])})`);
    const negocios = await get(`nexus_negocios?or=${ou}&deleted_at=is.null&order=numero_contrato&select=id,numero_contrato,grao,safra,quantidade,preco,contraparte,cliente_id,produtor_id,check_pagamento,pagamentos_extra,pagamento_dias_apos_entrega,data_pagamento,preco_liquido,funrural_forma,comissao,comissao_pagador`);
    return json({ ok: true, negocios });
  }
  if (q === "pessoas") {
    const [cadastros, equipe] = await Promise.all([
      get("nexus_cadastros?select=id,nome,apelido,tipo,data_nascimento&limit=5000"),
      get("nexus_equipe?select=user_id,nome,data_nascimento"),
    ]);
    return json({ ok: true, cadastros, equipe });
  }
  return json({ ok: false, erro: "Consulta desconhecida." }, 400);
};
