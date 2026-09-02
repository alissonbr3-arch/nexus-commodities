import { NEXUS_EMPRESA, NEXUS_LOGO } from "./_confirmacao-lib.mjs";

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

// Mesmo template visual do "Relatório de Negócios" que já existe em Relatórios > Por Produtor
// no painel (gerarRelatorioProdutor) — só que fixo nos negócios "em aberto" (Fechado/Entregue,
// ainda não Pago) de UM produtor, pra mandar o link por WhatsApp todo início de mês.
export default async (req) => {
  const url = new URL(req.url);
  const produtorId = url.searchParams.get("id");
  if (!produtorId) return paginaErro("Link inválido.");

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return paginaErro("Serviço indisponível no momento. Tente de novo mais tarde.");
  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const produtorResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=eq.${encodeURIComponent(produtorId)}&select=id,nome,cpf,cidade`, { headers: adminHeaders });
  const produtorRows = await produtorResp.json().catch(() => []);
  const produtor = produtorRows[0];
  if (!produtor) return paginaErro("Não encontrei esse cadastro.");

  const negResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?produtor_id=eq.${produtorId}&status=in.(Fechado,Entregue)&deleted_at=is.null&select=*&order=data.asc`, { headers: adminHeaders });
  const negocios = await negResp.json().catch(() => []);
  if (!Array.isArray(negocios) || negocios.length === 0) {
    return paginaErro(`${produtor.nome}, você não tem nenhum negócio em aberto no momento.`);
  }

  const idsCompradores = [...new Set(negocios.map(n => n.cliente_id).filter(Boolean))];
  let compradores = [];
  if (idsCompradores.length) {
    const compResp = await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=in.(${idsCompradores.join(",")})&select=id,nome`, { headers: adminHeaders });
    compradores = await compResp.json().catch(() => []);
  }
  const nomeComprador = (n) => n.cliente_id ? (compradores.find(c => c.id === n.cliente_id)?.nome || "—") : (n.contraparte || "—");

  const totalVolume = negocios.reduce((s, n) => s + Number(n.quantidade || 0), 0);
  const totalValor = negocios.reduce((s, n) => s + Number(n.quantidade || 0) * Number(n.preco || 0), 0);
  const embarquesFinalizados = negocios.filter(n => n.embarque_finalizado).length;
  const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });

  const linhas = negocios.map(n => {
    const valor = Number(n.quantidade || 0) * Number(n.preco || 0);
    const temEmbarque = n.data_inicio_embarque || n.data_fim_embarque;
    const embPeriodo = temEmbarque ? `${fmtDate(n.data_inicio_embarque)} – ${fmtDate(n.data_fim_embarque)}` : "—";
    const embStatus = temEmbarque ? (n.embarque_finalizado ? "Finalizado" : "Em andamento") : "";
    return `<tr>
      <td>${n.numero_contrato || "—"}</td><td>${fmtDate(n.data)}</td><td>${(n.grao || "—")} ${n.safra || ""}</td><td>${nomeComprador(n)}</td>
      <td>${fmtNum(n.quantidade)}</td><td>${fmtMoney(n.preco)}</td><td>${fmtMoney(valor)}</td>
      <td><span style="font-size:9.5px;font-weight:bold;color:#a6741a">${(n.status || "—").toUpperCase()}</span></td>
      <td>${embPeriodo}${embStatus ? `<br><span style="font-size:9.5px;font-weight:bold;color:${n.embarque_finalizado ? "#2f7d32" : "#a6741a"}">${embStatus.toUpperCase()}</span>` : ""}</td>
    </tr>`;
  }).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Relatório de Negócios em Aberto — ${produtor.nome}</title>
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
  <h1>RELATÓRIO DE NEGÓCIOS EM ABERTO</h1>
  <div class="sub">${produtor.nome}${produtor.cpf ? " — CPF " + produtor.cpf : ""}${produtor.cidade ? " — " + produtor.cidade : ""} — emitido em ${hoje}</div>
  <table class="linhas">
    <thead><tr><th>Contrato</th><th>Data</th><th>Produto/Safra</th><th>Comprador</th><th>Qtd (sc)</th><th>Preço (R$/sc)</th><th>Valor total</th><th>Status</th><th>Embarque</th></tr></thead>
    <tbody>${linhas}</tbody>
  </table>
  <div class="resumo">
    <div class="item"><span>Negócios em aberto</span><b>${negocios.length}</b></div>
    <div class="item"><span>Volume total</span><b>${fmtNum(totalVolume)} sc</b></div>
    <div class="item"><span>Valor total</span><b>${fmtMoney(totalValor)}</b></div>
    <div class="item"><span>Embarques finalizados</span><b>${embarquesFinalizados} de ${negocios.length}</b></div>
  </div>
  <script>window.onload = () => setTimeout(() => window.print(), 300);<\/script>
  </body></html>`;
  return htmlResponse(html);
};
