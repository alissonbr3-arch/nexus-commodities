import { NEXUS_EMPRESA, tipoCpfCnpj } from "./_confirmacao-lib.mjs";
// Mesmo modelo visual ("Posição") do relatório do painel: define globalThis.renderRelatorioPosicao.
import "../../relatorio-posicao.js";

const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
function paginaErro(msg) {
  return htmlResponse(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#333">
  <p style="font-size:15px">${msg}</p></body></html>`, 404);
}

// Mesma conta de preço líquido usada no resto do app.
function aplicaFundersulFundems(comprador) {
  return !comprador || (comprador.categoria_comprador !== "Cooperativa" && comprador.categoria_comprador !== "Cerealista");
}
function precoLiquidoNegocio(n, comprador, config) {
  const sacas = Number(n.quantidade || 0);
  const total = Number(n.preco || 0) * sacas;
  const senar = total * 0.002;
  const comFundersulFundems = aplicaFundersulFundems(comprador);
  const fundersulTotal = comFundersulFundems ? Number(config.fundersul_saca || 0) * sacas : 0;
  const fundemsTotal = comFundersulFundems ? Number(config.fundems_saca || 0) * sacas : 0;
  const funruralForma = n.funrural_forma || "Comercialização";
  const funrural = funruralForma === "Comercialização" ? total * Number(config.funrural_pct || 0) / 100 : 0;
  const comissaoDoVendedor = n.comissao_pagador === "Comprador" ? 0 : Number(n.comissao || 0);
  const liquidoEstimado = total - comissaoDoVendedor - senar - fundersulTotal - fundemsTotal - funrural;
  const informado = n.preco_liquido != null && n.preco_liquido !== "";
  const precoLiquido = informado ? Number(n.preco_liquido) : (sacas ? liquidoEstimado / sacas : 0);
  const liquidoTotal = informado ? precoLiquido * sacas : liquidoEstimado;
  return { precoLiquido, liquidoTotal };
}
const arr = (x) => (Array.isArray(x) ? x : []);
const hojeISO = () => new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10); // horário de MS

// Relatório de Negócios em Aberto (Fechado/Entregue, ainda não Pago) + saldo nos armazéns, pra mandar o
// link por WhatsApp todo início de mês. Aceita ?id=<produtor_id> (um produtor) ou ?grupo=<grupo_id>
// (todo mundo do mesmo grupo — ex: sócios da mesma propriedade — num único documento).
export default async (req) => {
  const url = new URL(req.url);
  const produtorId = url.searchParams.get("id");
  const grupoId = url.searchParams.get("grupo");
  if (!produtorId && !grupoId) return paginaErro("Link inválido.");

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return paginaErro("Serviço indisponível no momento. Tente de novo mais tarde.");
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const get = (path) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: adminHeaders }).then(r => (r.ok ? r.json() : [])).catch(() => []);

  const filtroProdutores = grupoId ? `grupo_id=eq.${encodeURIComponent(grupoId)}` : `id=eq.${encodeURIComponent(produtorId)}`;
  const produtores = arr(await get(`nexus_cadastros?${filtroProdutores}&select=id,nome,cpf,cidade`));
  if (produtores.length === 0) return paginaErro("Não encontrei esse cadastro.");
  const isGrupo = produtores.length > 1;
  const ids = produtores.map(p => p.id).join(",");
  const tituloProdutores = produtores.map(p => p.nome).join(", ");

  const [negocios, cfgRows, saldos, vendidos] = await Promise.all([
    get(`nexus_negocios?produtor_id=in.(${ids})&status=in.(Fechado,Entregue)&deleted_at=is.null&select=*&order=data.asc`).then(arr),
    get(`nexus_config?id=eq.1&select=fundersul_saca,fundems_saca,funrural_pct`).then(arr),
    get(`nexus_saldos_armazem?produtor_id=in.(${ids})&select=*`).then(arr),
    // Tudo o que já foi vendido com a Nexus (qualquer status), pra barra de "comercializado" por grão/safra.
    get(`nexus_negocios?produtor_id=in.(${ids})&deleted_at=is.null&select=grao,safra,quantidade`).then(arr),
  ]);
  const config = cfgRows[0] || {};
  if (negocios.length === 0 && saldos.length === 0) {
    return paginaErro(`${tituloProdutores}, ${isGrupo ? "vocês não têm" : "você não tem"} nenhum negócio em aberto no momento.`);
  }

  const idsCadastros = [...new Set([...negocios.map(n => n.cliente_id), ...saldos.map(s => s.armazem_id)].filter(Boolean))];
  const idsFazendas = [...new Set(saldos.map(s => s.fazenda_id).filter(Boolean))];
  const [cadastros, fazendas] = await Promise.all([
    idsCadastros.length ? get(`nexus_cadastros?id=in.(${idsCadastros.join(",")})&select=id,nome,categoria_comprador`).then(arr) : [],
    idsFazendas.length ? get(`nexus_fazendas?id=in.(${idsFazendas.join(",")})&select=id,nome,inscricao_estadual`).then(arr) : [],
  ]);
  const cadastro = (id) => (id ? cadastros.find(c => c.id === id) : null);
  const nomeProdutor = (id) => produtores.find(p => p.id === id)?.nome || "—";

  const gruposMap = new Map();
  for (const n of negocios) {
    const chave = `${n.grao || "—"}__${n.safra || "—"}`;
    if (!gruposMap.has(chave)) gruposMap.set(chave, { grao: n.grao || "—", safra: n.safra || "", negocios: [] });
    gruposMap.get(chave).negocios.push(n);
  }
  const cronograma = [];
  const grupos = [...gruposMap.values()].sort((a, b) => a.grao.localeCompare(b.grao, "pt-BR") || a.safra.localeCompare(b.safra, "pt-BR")).map(g => ({
    grao: g.grao, safra: g.safra,
    negocios: g.negocios.map(n => {
      const comprador = cadastro(n.cliente_id);
      const { precoLiquido, liquidoTotal } = precoLiquidoNegocio(n, comprador, config);
      const nomeComprador = comprador?.nome || n.contraparte || "—";
      const status = (n.status || "—").toUpperCase();
      if (n.data_pagamento) cronograma.push({ data: n.data_pagamento, contrato: n.numero_contrato, produtor: nomeProdutor(n.produtor_id), comprador: nomeComprador, parcela: "única", sacas: n.quantidade, valor: liquidoTotal, status: "A RECEBER" });
      return {
        contrato: n.numero_contrato, data: n.data, produtor: nomeProdutor(n.produtor_id), comprador: nomeComprador,
        sacas: Number(n.quantidade || 0), precoLiquido, valorLiquido: liquidoTotal,
        pagamento: n.data_pagamento ? n.data_pagamento.split("-").reverse().join("/") : "", status, parcelas: [],
      };
    }),
  }));
  cronograma.sort((a, b) => (a.data || "").localeCompare(b.data || ""));

  const html = globalThis.renderRelatorioPosicao({
    titulo: isGrupo ? "Posição do grupo" : "Posição do produtor",
    subtitulo: "Negócios em aberto com a Nexus e saldo nos armazéns",
    emitidoEm: hojeISO(),
    logoUrl: `${url.origin}/logo-nexus-escuro.png`,
    empresa: NEXUS_EMPRESA,
    produtores: produtores.map(p => ({ nome: p.nome, documento: p.cpf ? `${tipoCpfCnpj(p.cpf)} ${p.cpf}` : "", cidade: p.cidade })),
    grupos, cronograma,
    vendidoTotal: vendidos.map(v => ({ grao: v.grao, safra: v.safra, sacas: Number(v.quantidade || 0) })),
    tituloCronograma: "Pagamentos previstos",
    saldos: saldos.map(s => {
      const f = s.fazenda_id ? fazendas.find(x => x.id === s.fazenda_id) : null;
      return { armazem: s.armazem_id ? (cadastro(s.armazem_id)?.nome || "—") : (s.armazem_nome || "—"), ie: f?.inscricao_estadual || "", fazenda: f?.nome || "", produtor: nomeProdutor(s.produtor_id), grao: s.grao, safra: s.safra, sacas: Number(s.quantidade || 0), data: s.data_referencia };
    }),
    resumo: negocios.length ? [{ label: "negócios em aberto", valor: String(negocios.length) }] : [],
    vazioNegocios: `${isGrupo ? "Vocês não têm" : "Você não tem"} nenhum negócio em aberto com a Nexus no momento.`,
  });
  return htmlResponse(html);
};
