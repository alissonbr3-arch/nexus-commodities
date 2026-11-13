// Relatório de Negócios do produtor no layout "Posição": lateral grafite com a marca e os números do
// grupo, barra por grão mostrando o que foi vendido com a Nexus e o que ainda está no armazém, tabelas
// de negócios por grão/safra, saldo nos armazéns e linha do tempo dos pagamentos.
//
// Um único arquivo usado nos dois relatórios: o painel (index.html, Relatórios > Por produtor) carrega
// com <script src>, e a função do link mensal (netlify/functions/relatorio-mensal-publico.mjs) importa.
// Os dois só montam os dados (o "modelo" abaixo) e chamam renderRelatorioPosicao(modelo) -> HTML completo.
//
// modelo = {
//   titulo, subtitulo, emitidoEm (ISO), logoUrl, empresa: { nome, endereco, email, telefone },
//   produtores: [{ nome, documento, cidade }],
//   grupos: [{ grao, safra, negocios: [{ contrato, data, produtor, comprador, sacas, precoLiquido, valorLiquido,
//             pagamento, status, statusDetalhe, parcelas: [{ label, sacas, valor, data, status }] }] }],
//   cronograma: [{ data, contrato, produtor, comprador, parcela, sacas, valor, status, estimativa }],
//   saldos: [{ armazem, ie, fazenda, produtor, grao, safra, sacas, data, informado?, vendidoDepois?, contratosDepois? }]
//           (sacas = saldo atual; informado − vendidoDepois quando houve venda depois da posição),
//   externos: [{ corretora, produtor, grao, safra, sacas, preco, data }],  // vendas com outras corretoras
//   resumo: [{ label, valor }]           // números extras na lateral (ex.: recebidos)
//   vendidoTotal: [{ grao, safra, sacas }] // opcional: tudo o que já foi vendido com a Nexus (pra barra),
//                                          // quando as tabelas mostram só parte dos negócios (ex.: em aberto)
//   tituloCronograma, vazioNegocios      // textos opcionais
// }
(function () {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const num = (n, dec) => Number(n || 0).toLocaleString("pt-BR", dec ? { minimumFractionDigits: dec, maximumFractionDigits: dec } : { maximumFractionDigits: 2 });
  const money = (n) => "R$ " + num(n, 2);
  const moneyCurto = (n) => {
    const v = Number(n || 0);
    if (v >= 1e6) return "R$ " + (v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " mi";
    if (v >= 1e4) return "R$ " + Math.round(v / 1e3).toLocaleString("pt-BR") + " mil";
    return money(v);
  };
  const data = (iso) => { if (!iso) return "—"; const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${d}/${m}/${y}`; };
  const cssStr = (t) => '"' + String(t ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ") + '"';
  const pill = (st) => {
    const s = String(st || "").toUpperCase();
    const cls = s === "RECEBIDO" || s === "PAGO" ? "ok" : s === "RECEBIDO PARCIAL" ? "parcial" : "aberto";
    return `<span class="pill ${cls}">${esc(s || "—")}</span>`;
  };

  function renderRelatorioPosicao(m) {
    // Tudo em ordem de safra (a mais antiga primeiro); na mesma safra, por grão.
    const porSafra = (a, b) => String(a.safra || "").localeCompare(String(b.safra || ""), "pt-BR") || String(a.grao || "").localeCompare(String(b.grao || ""), "pt-BR");
    const grupos = [...(m.grupos || [])].sort(porSafra);
    const saldos = m.saldos || [];
    const cronograma = m.cronograma || [];
    const varios = (m.produtores || []).length > 1;
    const todosNegocios = grupos.flatMap(g => g.negocios);
    const volumeTotal = todosNegocios.reduce((s, n) => s + Number(n.sacas || 0), 0);
    const valorTotal = todosNegocios.reduce((s, n) => s + Number(n.valorLiquido || 0), 0);

    const externos = m.externos || [];

    // Barra por grão + safra: vendido com a Nexus x vendido com outras corretoras x saldo nos armazéns.
    const pos = new Map();
    const chave = (g, s) => `${g || "—"}__${s || ""}`;
    const pega = (g, s) => { const k = chave(g, s); if (!pos.has(k)) pos.set(k, { grao: g || "—", safra: s || "", vendido: 0, outras: 0, saldo: 0 }); return pos.get(k); };
    if (m.vendidoTotal) m.vendidoTotal.forEach(v => { pega(v.grao, v.safra).vendido += Number(v.sacas || 0); });
    else grupos.forEach(g => { pega(g.grao, g.safra).vendido += g.negocios.reduce((s, n) => s + Number(n.sacas || 0), 0); });
    externos.forEach(x => { pega(x.grao, x.safra).outras += Number(x.sacas || 0); });
    saldos.forEach(s => { pega(s.grao, s.safra).saldo += Number(s.sacas || 0); });
    const posicoes = [...pos.values()].sort(porSafra);
    const barras = posicoes.map(p => {
      const total = p.vendido + p.outras + p.saldo;
      const w = (v) => (total ? v / total * 100 : 0);
      const vendidoTudo = p.vendido + p.outras;
      const sozinho = !p.outras && !p.saldo;
      const sold = p.vendido ? `<i class="sold" style="width:${w(p.vendido)}%" title="Vendido com a Nexus">${num(p.vendido)} Nexus${sozinho ? " · sem saldo informado" : ""}</i>` : "";
      const other = p.outras ? `<i class="other" style="width:${w(p.outras)}%" title="Vendido com outras corretoras">${num(p.outras)} outras</i>` : "";
      const stock = p.saldo ? `<i class="stock" style="width:${w(p.saldo)}%" title="Ainda no armazém">${num(p.saldo, 2)} em armazém</i>` : "";
      const pctVendido = total ? Math.round(vendidoTudo / total * 100) : 0;
      const pctNexus = vendidoTudo ? Math.round(p.vendido / vendidoTudo * 100) : 0;
      const lado = sozinho ? `<b>${num(p.vendido)}</b>sacas vendidas`
        : p.saldo ? `<b>${pctVendido}%</b>comercializado${p.outras ? `<small>Nexus: ${pctNexus}% das vendas</small>` : ""}`
        : `<b>${pctNexus}%</b>vendido com a Nexus`;
      return `<div class="bar-row"><div class="g">${esc(p.grao)}<small>${esc(p.safra || "—")}</small></div>
        <div class="track">${sold}${other}${stock}</div><div class="pct">${lado}</div></div>`;
    }).join("");
    const legendaBarras = externos.length || saldos.length ? `<div class="bar-legend"><span><i class="sold"></i>Nexus</span>${externos.length ? `<span><i class="other"></i>Outras corretoras</span>` : ""}${saldos.length ? `<span><i class="stock"></i>Em armazém</span>` : ""}</div>` : "";

    // Vendas com outras corretoras (tabela).
    const externosOrd = [...externos].sort((a, b) => porSafra(a, b) || (a.data || "").localeCompare(b.data || ""));
    const totalExtSc = externos.reduce((s, x) => s + Number(x.sacas || 0), 0);
    const totalExtValor = externos.reduce((s, x) => s + Number(x.sacas || 0) * Number(x.preco || 0), 0);
    const blocoExternos = externos.length ? `<section class="bloco"><h4>Vendas com outras corretoras <em>${externos.length} venda${externos.length === 1 ? "" : "s"} · ${num(totalExtSc)} sc${totalExtValor ? " · " + money(totalExtValor) : ""}</em></h4>
      <table><thead><tr><th>Data</th>${varios ? "<th>Produtor</th>" : ""}<th>Corretora</th><th>Grão</th><th class="num">Sacas</th><th class="num">R$/sc</th><th class="num">Valor</th></tr></thead>
      <tbody>${externosOrd.map(x => `<tr><td class="mono">${data(x.data)}</td>${varios ? `<td>${esc(x.produtor)}</td>` : ""}<td>${esc(x.corretora || "—")}</td>
        <td class="nw">${esc(x.grao)} <span class="det">${esc(x.safra || "")}</span></td><td class="num mono">${num(x.sacas)}</td>
        <td class="num mono">${x.preco != null ? num(x.preco, 2) : "—"}</td><td class="num mono">${x.preco != null ? num(Number(x.sacas || 0) * Number(x.preco), 2) : "—"}</td></tr>`).join("")}</tbody></table></section>` : "";

    // Saldo em armazém por grão (pra lateral).
    const saldoPorGrao = {};
    saldos.forEach(s => { saldoPorGrao[s.grao] = (saldoPorGrao[s.grao] || 0) + Number(s.sacas || 0); });
    const armazensUnicos = [...new Set(saldos.map(s => s.armazem))];

    const tabelasNegocios = grupos.map(g => {
      const vol = g.negocios.reduce((s, n) => s + Number(n.sacas || 0), 0);
      const val = g.negocios.reduce((s, n) => s + Number(n.valorLiquido || 0), 0);
      const linhas = g.negocios.map(n => {
        const parcelas = (n.parcelas || []).map(p => `<tr class="sub">
          <td colspan="${varios ? 4 : 3}">↳ ${esc(p.label)}</td><td class="num mono">${p.sacas != null ? num(p.sacas) : "—"}</td><td></td>
          <td class="num mono">${num(p.valor, 2)}</td><td class="mono">${data(p.data)}</td><td>${pill(p.status)}</td></tr>`).join("");
        return `<tr><td class="mono">${esc(n.contrato || "—")}</td><td class="mono">${data(n.data)}</td>${varios ? `<td>${esc(n.produtor)}</td>` : ""}<td>${esc(n.comprador)}</td>
          <td class="num mono">${num(n.sacas)}</td><td class="num mono">${num(n.precoLiquido, 2)}</td><td class="num mono">${num(n.valorLiquido, 2)}</td>
          <td class="mono">${n.pagamento ? esc(n.pagamento) : "—"}</td><td>${pill(n.status)}${n.statusDetalhe ? `<div class="det">${esc(n.statusDetalhe)}</div>` : ""}</td></tr>${parcelas}`;
      }).join("");
      return `<section class="bloco"><h4>${esc(g.grao)} · Safra ${esc(g.safra || "—")} <em>${g.negocios.length} negócio${g.negocios.length === 1 ? "" : "s"} · ${num(vol)} sc · ${money(val)} líquido</em></h4>
        <table><thead><tr><th>Contrato</th><th>Data</th>${varios ? "<th>Produtor</th>" : ""}<th>Comprador</th><th class="num">Sacas</th><th class="num">R$/sc líq.</th><th class="num">Valor líquido</th><th>Pagamento</th><th></th></tr></thead>
        <tbody>${linhas}</tbody></table></section>`;
    }).join("");

    const ordenados = [...saldos].sort((a, b) => porSafra(a, b) || (a.armazem || "").localeCompare(b.armazem || "", "pt-BR") || Number(b.sacas) - Number(a.sacas));
    const datasSaldo = [...new Set(saldos.map(s => s.data))];
    const umaData = datasSaldo.length === 1;
    const blocoSaldos = saldos.length ? `<section class="bloco"><h4>Saldo nos armazéns <em>${armazensUnicos.length === 1 ? esc(armazensUnicos[0]) + " · " : ""}${umaData ? "posição em " + data(datasSaldo[0]) : "posição informada"}</em></h4>
      <table><thead><tr>${armazensUnicos.length > 1 ? "<th>Armazém</th>" : ""}<th>Fazenda · IE</th>${varios ? "<th>Produtor</th>" : ""}<th>Grão</th><th class="num">Saldo (sc)</th>${umaData ? "" : "<th>Posição</th>"}</tr></thead>
      <tbody>${ordenados.map(s => `<tr>${armazensUnicos.length > 1 ? `<td>${esc(s.armazem)}</td>` : ""}<td>${esc(s.fazenda || "—")}<div class="det">IE ${esc(s.ie || "—")}</div></td>${varios ? `<td>${esc(s.produtor)}</td>` : ""}
        <td class="nw">${esc(s.grao)} <span class="det">${esc(s.safra || "")}</span></td><td class="num mono"><b>${num(s.sacas, 2)}</b>${s.vendidoDepois > 0 ? `<div class="det">${num(s.informado, 2)} informado − ${num(s.vendidoDepois, 2)} vendido${s.contratosDepois && s.contratosDepois.length ? ` (${esc(s.contratosDepois.join(", "))})` : ""}</div>` : ""}</td>${umaData ? "" : `<td class="mono">${data(s.data)}</td>`}</tr>`).join("")}</tbody></table>${saldos.some(s => s.vendidoDepois > 0) ? `<div class="det" style="margin-top:6px">Saldo = posição informada pelo produtor menos as vendas feitas depois dessa data.</div>` : ""}</section>`
      : "";

    // Até 8 pagamentos: saldo e linha do tempo lado a lado. Mais que isso: um embaixo do outro, cada um na largura
    // toda (senão a linha do tempo fica espremida e, no PDF, sobra meia página em branco ao lado dela).
    const blocoCronograma = cronograma.length ? `<section class="bloco"><h4>${esc(m.tituloCronograma || "Pagamentos")} <em>em ordem de data</em></h4>
      <div class="timeline">${cronograma.map(p => `<div class="${String(p.status || "").toUpperCase() === "RECEBIDO" ? "rec" : "fut"}">
        <span class="d">${data(p.data)}${p.estimativa ? "*" : ""}</span>
        <span>${esc(p.contrato || "—")}${varios ? " · " + esc(p.produtor) : ""}${p.parcela && p.parcela !== "única" ? ` <small>${esc(p.parcela)}</small>` : ""}<br><small>${esc(p.comprador)}</small></span>
        <span class="v">${num(p.valor, 2)}<br>${pill(p.status)}</span></div>`).join("")}</div>
      ${cronograma.some(p => p.estimativa) ? `<div class="obs">* data estimada</div>` : ""}</section>` : "";

    const stats = [
      todosNegocios.length ? `<div class="stat"><b>${moneyCurto(valorTotal)}</b><span>valor líquido em ${todosNegocios.length} negócio${todosNegocios.length === 1 ? "" : "s"}</span></div>` : "",
      todosNegocios.length ? `<div class="stat"><b>${num(volumeTotal)} sc</b><span>negociadas com a Nexus</span></div>` : "",
      totalExtSc ? `<div class="stat small"><b>${num(totalExtSc)} sc</b><span>vendidas com outras corretoras</span></div>` : "",
      ...Object.entries(saldoPorGrao).map(([g, q]) => `<div class="stat"><b>${num(Math.round(q))} sc</b><span>de ${esc(String(g).toLowerCase())} ainda em armazém</span></div>`),
      ...(m.resumo || []).map(r => `<div class="stat small"><b>${esc(r.valor)}</b><span>${esc(r.label)}</span></div>`),
    ].join("");

    const produtoresHtml = (m.produtores || []).map(p => `<div class="val">${esc(p.nome)}${p.documento ? `<small>${esc(p.documento)}</small>` : ""}</div>`).join("");
    const cidades = [...new Set((m.produtores || []).map(p => p.cidade).filter(Boolean))];
    const e = m.empresa || {};
    const nomes = (m.produtores || []).map(p => p.nome).join(", ");
    const cabecalho = cssStr(`${m.titulo} · ${nomes} · emitido em ${data(m.emitidoEm)}`);
    const rodape = cssStr([e.nome, e.endereco, e.telefone, e.email].filter(Boolean).join(" · "));

    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.titulo)} — ${esc((m.produtores || []).map(p => p.nome).join(", "))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400;62..125,600;62..125,800&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
  :root { --ink:#15161a; --soft:#5d616b; --line:#e6e8ec; --graphite:#17171a; --gold-1:#f3d27a; --gold-2:#c8962e; --gold-3:#8a5f12; }
  * { box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact }
  html,body { margin:0 }
  body { background:#e9e9ec; color:var(--ink); font-family:"Archivo",Arial,Helvetica,sans-serif; font-size:12px; line-height:1.4; font-variant-numeric:tabular-nums }
  .sheet { width:1123px; max-width:100%; min-height:794px; margin:24px auto; background:#fff; display:grid; grid-template-columns:240px minmax(0,1fr); box-shadow:0 10px 40px -12px rgba(0,0,0,.35) }
  aside { background:var(--graphite); color:#d9dbe0; padding:28px 22px; display:flex; flex-direction:column; gap:20px; position:relative }
  aside::after { content:""; position:absolute; top:0; right:0; bottom:0; width:4px; background:linear-gradient(180deg,var(--gold-1),var(--gold-3)) }
  aside img { display:block; width:170px; max-width:100%; margin:0 auto 4px; position:relative; left:-2px } /* centralizada na faixa preta (descontando o filete dourado de 4px) */
  .lbl { font-family:"IBM Plex Mono",monospace; font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:#8b8f99; margin-bottom:3px }
  .val { font-size:13.5px; font-weight:600; color:#fff; line-height:1.3; margin-bottom:4px }
  .val small { display:block; font-family:"IBM Plex Mono",monospace; font-weight:400; font-size:10px; color:#a9adb6 }
  .stat b { display:block; font-stretch:112%; font-weight:800; font-size:26px; color:var(--gold-1); line-height:1.05 }
  .stat.small b { font-size:19px }
  .stat span { font-size:11px; color:#a9adb6 }
  .who, .stats { display:flex; flex-direction:column; gap:20px }
  .empresa { margin-top:auto; font-size:10px; color:#8b8f99; line-height:1.5 }
  .empresa b { color:#d9dbe0; font-weight:600 }
  .empresa b, .empresa span { display:block }
  .empresa .emit { margin-top:10px }
  main { padding:28px 32px 26px; min-width:0 }
  .title { display:flex; justify-content:space-between; align-items:end; gap:16px; border-bottom:3px solid var(--ink); padding-bottom:9px }
  .title h1 { margin:0; font-stretch:125%; font-weight:800; font-size:30px; letter-spacing:-.01em; line-height:1; text-transform:uppercase }
  .title span { font-family:"IBM Plex Mono",monospace; font-size:10.5px; color:var(--soft); text-align:right }
  .bars { display:grid; gap:12px; margin:18px 0 20px }
  .bar-row { display:grid; grid-template-columns:110px minmax(0,1fr) 120px; align-items:center; gap:14px }
  .bar-row .g { font-stretch:112%; font-weight:800; font-size:14px; text-transform:uppercase }
  .bar-row .g small { display:block; font-family:"IBM Plex Mono",monospace; font-weight:400; font-size:10px; color:var(--soft); text-transform:none }
  .track { height:24px; display:flex; background:#eef0f3; border-radius:3px; overflow:hidden }
  .track i { display:flex; align-items:center; padding:0 8px; font-family:"IBM Plex Mono",monospace; font-style:normal; font-size:10px; white-space:nowrap; overflow:hidden; color:#fff }
  .track .sold { background:linear-gradient(90deg,var(--gold-3),var(--gold-2)) }
  .track .stock { background:#3a3d45 }
  .track .other { background:#8e95a3 }
  .bar-legend { display:flex; flex-wrap:wrap; gap:6px 16px; margin:-10px 0 18px; font-family:"IBM Plex Mono",monospace; font-size:9.5px; color:var(--soft) }
  .bar-legend span { display:inline-flex; align-items:center; gap:5px }
  .bar-legend i { width:10px; height:10px; border-radius:2px; display:inline-block }
  .bar-legend .sold { background:linear-gradient(90deg,var(--gold-3),var(--gold-2)) }
  .bar-legend .other { background:#8e95a3 }
  .bar-legend .stock { background:#3a3d45 }
  .bar-row .pct small { display:block; font-size:9.5px; margin-top:1px }
  .bar-row .pct { font-family:"IBM Plex Mono",monospace; font-size:10.5px; color:var(--soft); text-align:right }
  .bar-row .pct b { font-family:"Archivo",sans-serif; font-stretch:112%; color:var(--ink); font-size:17px; display:block }
  .bloco { margin-bottom:16px; break-inside:auto }
  .cols { display:grid; grid-template-columns:minmax(0,1.35fr) minmax(0,1fr); gap:26px; align-items:start }
  h4 { margin:0 0 5px; font-stretch:112%; font-weight:800; font-size:11.5px; letter-spacing:.08em; text-transform:uppercase; display:flex; justify-content:space-between; gap:12px; break-after:avoid }
  h4 em { font-style:normal; font-family:"IBM Plex Mono",monospace; font-weight:400; font-size:10px; color:var(--soft); letter-spacing:0; text-transform:none; text-align:right }
  table { width:100%; border-collapse:collapse; font-size:11px }
  th { font-family:"IBM Plex Mono",monospace; font-weight:500; font-size:9px; color:var(--soft); text-align:left; padding:5px; border-bottom:1px solid var(--ink); text-transform:uppercase; white-space:nowrap }
  td { padding:6px 5px; border-bottom:1px solid var(--line); vertical-align:top }
  tr { break-inside:avoid }
  tr.sub td { font-size:10px; color:var(--soft); background:#fafafb; padding-top:4px; padding-bottom:4px }
  .num { text-align:right }
  .mono { font-family:"IBM Plex Mono",monospace; font-size:10.5px }
  .pill { display:inline-block; font-family:"IBM Plex Mono",monospace; font-size:8.5px; padding:2px 6px; border-radius:3px; font-weight:600; white-space:nowrap }
  .pill.ok { background:#e5f0dc; color:#2f5a17 }
  .pill.parcial { background:#dde9f5; color:#1f4f80 }
  .pill.aberto { background:#f7ecd4; color:#7a520c }
  .nw { white-space:nowrap }
  .det { font-family:"IBM Plex Mono",monospace; font-size:8.5px; color:var(--soft); margin-top:2px }
  .timeline { display:grid; gap:9px; padding-left:16px; border-left:2px solid var(--ink); margin:4px 0 0 4px }
  .timeline > div { position:relative; display:grid; grid-template-columns:70px minmax(0,1fr) auto; gap:8px; font-size:11px; break-inside:avoid }
  .timeline > div::before { content:""; position:absolute; left:-23px; top:3px; width:10px; height:10px; border-radius:50%; background:var(--gold-2); border:2px solid #fff; box-shadow:0 0 0 1px var(--gold-3) }
  .timeline > div.fut::before { background:#fff }
  .timeline .d { font-family:"IBM Plex Mono",monospace; font-size:10px; color:var(--soft) }
  .timeline small { color:var(--soft); font-size:10px }
  .timeline .v { font-family:"IBM Plex Mono",monospace; font-weight:600; text-align:right; font-size:10.5px }
  .obs { font-size:10px; color:var(--soft); margin-top:6px }
  .vazio { color:var(--soft); margin:6px 0 16px }
  /* Impressão / PDF: sem tamanho nem orientação fixos (o Chrome deixa escolher Retrato ou Paisagem), margem branca
     igual em todas as páginas, cabeçalho e rodapé repetidos em cada página (com "Página X de Y"). A faixa grafite vira
     uma barra no topo da 1ª página; o cabeçalho das tabelas se repete quando a tabela continua na página seguinte. */
  @page {
    margin:14mm 12mm 14mm;
    @top-left { content:"NEXUS COMMODITIES"; font-family:Archivo,Arial,sans-serif; font-size:7.5pt; font-weight:700; letter-spacing:.12em; color:#8a5f12 }
    @top-right { content:${cabecalho}; font-family:Archivo,Arial,sans-serif; font-size:7.5pt; color:#5d616b }
    @bottom-left { content:${rodape}; font-family:Archivo,Arial,sans-serif; font-size:7pt; color:#5d616b }
    @bottom-right { content:"Página " counter(page) " de " counter(pages); font-family:Archivo,Arial,sans-serif; font-size:7.5pt; color:#5d616b }
  }
  @media print {
    body { background:#fff }
    .sheet { display:block; width:auto; max-width:none; min-height:0; margin:0; box-shadow:none }
    aside { display:grid; grid-template-columns:116px minmax(0,1fr); column-gap:24px; row-gap:12px; align-items:center; padding:16px 22px 18px; break-inside:avoid }
    aside::after { top:auto; left:0; right:0; bottom:0; width:auto; height:3px; background:linear-gradient(90deg,var(--gold-3),var(--gold-1),var(--gold-3)) }
    aside img { grid-row:1 / span 2; width:116px; margin:0; left:0 }
    .who { flex-direction:row; flex-wrap:wrap; gap:6px 32px }
    .val { font-size:12px }
    .stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(110px, 1fr)); gap:10px 18px; border-top:1px solid #2c2d33; padding-top:10px }
    .stat b, .stat.small b { font-size:18px }
    .stat span { font-size:8.5px }
    .empresa { display:none }
    main { padding:16px 0 0 }
    .title h1 { font-size:22px }
    .bar-row { grid-template-columns:86px minmax(0,1fr) 100px }
    table { font-size:9.5px }
    th { font-size:8px }
    td { padding:4px }
    .mono { font-size:9px }
    .cols { gap:20px }
    .timeline > div { font-size:9.5px }
  }
  @media screen and (max-width:760px) { .sheet { grid-template-columns:1fr; margin:0 } aside::after { display:none } .cols { grid-template-columns:1fr } .bar-row { grid-template-columns:80px minmax(0,1fr) } .bar-row .pct { display:none } main { padding:20px 14px } .bloco { overflow-x:auto } }
</style></head><body>
<div class="sheet">
  <aside>
    <img src="${esc(m.logoUrl)}" alt="${esc(e.nome || "Nexus Commodities")}">
    <div class="who"><div><div class="lbl">${varios ? "Grupo" : "Produtor"}</div>${produtoresHtml}</div>
    ${cidades.length ? `<div><div class="lbl">Município</div><div class="val">${esc(cidades.join(" · "))}</div></div>` : ""}</div>
    <div class="stats">${stats}</div>
    <div class="empresa"><b>${esc(e.nome || "")}</b>${[e.endereco, e.email, e.telefone].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join("")}<span class="emit">Emitido em ${data(m.emitidoEm)}</span></div>
  </aside>
  <main>
    <div class="title"><h1>${esc(m.titulo)}</h1><span>${esc(m.subtitulo || "")}</span></div>
    ${barras ? `<div class="bars">${barras}</div>${legendaBarras}` : ""}
    ${tabelasNegocios || `<p class="vazio">${esc(m.vazioNegocios || "Nenhum negócio no período.")}</p>`}
    ${blocoExternos}
    ${blocoSaldos && blocoCronograma && cronograma.length <= 8 ? `<div class="cols"><div>${blocoSaldos}</div><div>${blocoCronograma}</div></div>` : blocoSaldos + blocoCronograma}
  </main>
</div>
<script>window.onload = () => (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(() => window.print(), 300));<\/script>
</body></html>`;
  }

  // Saldo atualizado nos armazéns: a posição informada pelo produtor menos o que ele vendeu DEPOIS da data dela
  // (Nexus e outras corretoras), do mesmo grão e safra. Venda com fazenda definida sai do saldo dessa fazenda;
  // sem fazenda (ou com mais de um saldo possível) sai do maior saldo primeiro. Nunca fica negativo.
  // saldos: linhas de nexus_saldos_armazem; vendas: [{ produtor, grao, safra, data, sacas, fazenda?, rotulo }]
  // -> [{ s (a linha original), resta, vendido, contratos }]
  function saldosDescontandoVendas(saldos, vendas) {
    const lista = (saldos || []).map(s => ({ s, resta: Number(s.quantidade || 0), vendido: 0, contratos: [] }));
    const vs = (vendas || []).filter(v => v.data && Number(v.sacas) > 0).sort((a, b) => String(a.data).localeCompare(String(b.data)));
    for (const v of vs) {
      let cands = lista.filter(l => l.s.produtor_id === v.produtor && l.s.grao === v.grao && (l.s.safra || "") === (v.safra || "") && l.s.data_referencia && String(v.data).slice(0, 10) > l.s.data_referencia && l.resta > 0);
      if (v.fazenda && cands.some(l => l.s.fazenda_id === v.fazenda)) cands = cands.filter(l => l.s.fazenda_id === v.fazenda);
      let falta = Number(v.sacas);
      for (const l of cands.sort((a, b) => b.resta - a.resta)) { if (falta <= 0) break; const d = Math.min(l.resta, falta); l.resta -= d; l.vendido += d; falta -= d; if (v.rotulo) l.contratos.push(v.rotulo); }
    }
    return lista.map(l => ({ ...l, resta: Math.round(l.resta * 100) / 100, vendido: Math.round(l.vendido * 100) / 100, contratos: [...new Set(l.contratos)] }));
  }

  globalThis.renderRelatorioPosicao = renderRelatorioPosicao;
  globalThis.saldosDescontandoVendas = saldosDescontandoVendas;
})();
