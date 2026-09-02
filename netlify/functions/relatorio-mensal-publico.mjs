import { NEXUS_EMPRESA, NEXUS_LOGO, tipoCpfCnpj } from "./_confirmacao-lib.mjs";

const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
function paginaErro(msg) {
  return htmlResponse(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#333">
  <p style="font-size:15px">${msg}</p></body></html>`, 404);
}

function fmtDate(iso) { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }
function fmtNum(n) { return Number(n || 0).toLocaleString("pt-BR"); }
function fmtMoney(n) { return "R$ " + Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

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

// Mesmo template visual do "Relatório de Negócios" que já existe em Relatórios > Por Produtor
// no painel (gerarRelatorioProdutor) — só que fixo nos negócios "em aberto" (Fechado/Entregue,
// ainda não Pago), pra mandar o link por WhatsApp todo início de mês. Aceita ?id=<produtor_id>
// (relatório de um produtor só) ou ?grupo=<grupo_id> (relatório consolidado de todo mundo do
// mesmo grupo — ex: sócios da mesma propriedade — num único documento).
export default async (req) => {
  const url = new URL(req.url);
  const produtorId = url.searchParams.get("id");
  const grupoId = url.searchParams.get("grupo");
  if (!produtorId && !grupoId) return paginaErro("Link inválido.");

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return paginaErro("Serviço indisponível no momento. Tente de novo mais tarde.");
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  let produtores = [];
  if (grupoId) {
    const cadResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?grupo_id=eq.${encodeURIComponent(grupoId)}&select=id,nome,cpf,cidade`, { headers: adminHeaders });
    produtores = await cadResp.json().catch(() => []);
  } else {
    const produtorResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=eq.${encodeURIComponent(produtorId)}&select=id,nome,cpf,cidade`, { headers: adminHeaders });
    produtores = await produtorResp.json().catch(() => []);
  }
  if (!Array.isArray(produtores) || produtores.length === 0) return paginaErro("Não encontrei esse cadastro.");
  const isGrupo = produtores.length > 1;
  const idsProdutores = produtores.map(p => p.id);
  const tituloProdutores = produtores.map(p => p.nome).join(", ");

  const [negResp, cfgResp] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?produtor_id=in.(${idsProdutores.join(",")})&status=in.(Fechado,Entregue)&deleted_at=is.null&select=*&order=data.asc`, { headers: adminHeaders }),
    fetch(`${SUPABASE_URL}/rest/v1/nexus_config?id=eq.1&select=fundersul_saca,fundems_saca,funrural_pct`, { headers: adminHeaders }),
  ]);
  const negocios = await negResp.json().catch(() => []);
  const cfgRows = await cfgResp.json().catch(() => []);
  const config = cfgRows[0] || {};
  if (!Array.isArray(negocios) || negocios.length === 0) {
    return paginaErro(`${tituloProdutores}, ${isGrupo ? "vocês não têm" : "você não tem"} nenhum negócio em aberto no momento.`);
  }

  const nomeProdutor = (n) => produtores.find(p => p.id === n.produtor_id)?.nome || "—";

  const idsCompradores = [...new Set(negocios.map(n => n.cliente_id).filter(Boolean))];
  let compradores = [];
  if (idsCompradores.length) {
    const compResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${idsCompradores.join(",")})&select=id,nome,categoria_comprador`, { headers: adminHeaders });
    compradores = await compResp.json().catch(() => []);
  }
  const compradorDe = (n) => n.cliente_id ? compradores.find(c => c.id === n.cliente_id) : null;
  const nomeComprador = (n) => compradorDe(n)?.nome || n.contraparte || "—";

  const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
  let totalVolume = 0, totalValorLiquido = 0;

  // Divide o relatório por cultura + safra — um bloco de tabela pra cada combinação, com
  // subtotal próprio, em vez de uma lista só misturando tudo.
  const grupos = new Map();
  for (const n of negocios) {
    const chave = `${n.grao || "—"}__${n.safra || "—"}`;
    if (!grupos.has(chave)) grupos.set(chave, { grao: n.grao || "—", safra: n.safra || "", negocios: [] });
    grupos.get(chave).negocios.push(n);
  }
  const gruposOrdenados = [...grupos.values()].sort((a, b) => a.grao.localeCompare(b.grao, "pt-BR") || a.safra.localeCompare(b.safra, "pt-BR"));

  const blocos = gruposOrdenados.map(grupo => {
    let volumeGrupo = 0, valorGrupo = 0;
    const linhasGrupo = grupo.negocios.map(n => {
      const { precoLiquido, liquidoTotal } = precoLiquidoNegocio(n, compradorDe(n), config);
      volumeGrupo += Number(n.quantidade || 0);
      valorGrupo += liquidoTotal;
      totalVolume += Number(n.quantidade || 0);
      totalValorLiquido += liquidoTotal;
      const produtorCol = isGrupo ? `<td>${nomeProdutor(n)}</td>` : "";
      return `<tr>
        <td>${n.numero_contrato || "—"}</td><td>${fmtDate(n.data)}</td>${produtorCol}<td>${nomeComprador(n)}</td>
        <td>${fmtNum(n.quantidade)}</td><td>${fmtMoney(precoLiquido)}</td><td>${fmtMoney(liquidoTotal)}</td>
        <td>${fmtDate(n.data_pagamento)}</td>
        <td><span style="font-size:9.5px;font-weight:bold;color:#a6741a">${(n.status || "—").toUpperCase()}</span></td>
      </tr>`;
    }).join("");
    return `
    <h3 style="font-size:13px;margin:20px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px">${grupo.grao.toUpperCase()}${grupo.safra ? " — SAFRA " + grupo.safra : ""} <span style="font-weight:normal;color:#555;font-size:11px">(${grupo.negocios.length} negócio${grupo.negocios.length === 1 ? "" : "s"} · ${fmtNum(volumeGrupo)} sc · ${fmtMoney(valorGrupo)} líquido)</span></h3>
    <table class="linhas">
      <thead><tr><th>Contrato</th><th>Data</th>${isGrupo ? "<th>Produtor</th>" : ""}<th>Comprador</th><th>Qtd (sc)</th><th>Preço Líquido (R$/sc)</th><th>Valor Líquido</th><th>Data de Pgto</th><th>Status</th></tr></thead>
      <tbody>${linhasGrupo}</tbody>
    </table>`;
  }).join("");

  const dadosProdutores = produtores.map(p => `<tr><td class="label">Produtor</td><td>${p.nome}${p.cpf ? ` — ${tipoCpfCnpj(p.cpf)} ${p.cpf}` : ""}${p.cidade ? " — " + p.cidade : ""}</td></tr>`).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Relatório de Negócios em Aberto — ${isGrupo ? "Grupo" : produtores[0].nome}</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11.5px; color: #111; max-width: 1000px; margin: 30px auto; line-height: 1.4; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #b8860b; padding-bottom: 10px; margin-bottom: 18px; }
    .head img { height: 48px; }
    .head .info { font-size: 11px; color: #555; }
    h1 { font-size: 15px; text-align: center; margin: 18px 0 4px; }
    .sub { text-align: center; font-size: 12px; color: #555; margin-bottom: 18px; }
    table.dados { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
    table.dados td { border: 1px solid #999; padding: 6px 8px; vertical-align: top; }
    table.dados td.label { width: 180px; font-weight: bold; background: #f2f2f2; }
    table.linhas { width: 100%; border-collapse: collapse; margin-top: 14px; }
    table.linhas th { background: #f2f2f2; border: 1px solid #999; padding: 6px 7px; font-size: 10.5px; text-align: left; }
    table.linhas td { border: 1px solid #999; padding: 6px 7px; vertical-align: top; }
    .resumo { display: flex; gap: 24px; margin-top: 16px; font-size: 12px; flex-wrap: wrap; }
    .resumo .item b { display: block; font-size: 15px; }
    @media print { body { margin: 0; } @page { size: A4 landscape; } }
  </style></head><body>
  <div class="head">
    <div><strong style="font-size:15px">${NEXUS_EMPRESA.nome}</strong><div class="info">${NEXUS_EMPRESA.endereco}<br>${NEXUS_EMPRESA.email} · Tel.: ${NEXUS_EMPRESA.telefone}</div></div>
    <img src="${NEXUS_LOGO}" style="height:54px">
  </div>
  <h1>RELATÓRIO DE NEGÓCIOS EM ABERTO${isGrupo ? " — GRUPO" : ""}</h1>
  <div class="sub">${tituloProdutores} — emitido em ${hoje}</div>
  <table class="dados">
    ${dadosProdutores}
  </table>
  ${blocos}
  <div class="resumo" style="margin-top:24px;padding-top:14px;border-top:2px solid #b8860b">
    <div class="item"><span>Total geral — negócios em aberto</span><b>${negocios.length}</b></div>
    <div class="item"><span>Volume total</span><b>${fmtNum(totalVolume)} sc</b></div>
    <div class="item"><span>Valor líquido total</span><b>${fmtMoney(totalValorLiquido)}</b></div>
  </div>
  <script>window.onload = () => setTimeout(() => window.print(), 300);<\/script>
  </body></html>`;
  return htmlResponse(html);
};
