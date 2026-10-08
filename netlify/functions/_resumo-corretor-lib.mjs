// Biblioteca dos resumos por WhatsApp dos corretores (matinal, semanal, mensal). Não é uma function.
// Regra: cada corretor só recebe dados dos NEGÓCIOS DELE. Do resto da equipe, só aparecem totais
// agregados e os destaques (quem foi corretor da semana/mês etc.), nunca os negócios dos outros.
// O proprietário recebe, além do dele, um resumo da equipe (e herda os negócios sem corretor).
export const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";

export const fmtMoney = v => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtNum = v => Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
export const fmtDate = iso => { const [y, m, d] = String(iso).split("-"); return `${d}/${m}`; };
const pct = v => `${Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`;

export function formatarTelefoneWhats(telefone) {
  const digitos = String(telefone || "").replace(/\D/g, "");
  if (!digitos) return "";
  if (digitos.startsWith("55") && digitos.length >= 12) return digitos;
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  return digitos;
}

// ---- datas (tudo em ISO "YYYY-MM-DD", sem depender de fuso) ----
export const hojeCampoGrande = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Campo_Grande" });
const diaNum = iso => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const isoDeDia = n => new Date(n * 86400000).toISOString().slice(0, 10);
export const somaDias = (iso, n) => isoDeDia(diaNum(iso) + n);
export const diasEntre = (a, b) => diaNum(b) - diaNum(a);
const dow = iso => new Date(diaNum(iso) * 86400000).getUTCDay(); // 0 = domingo
export function limitesSemanaDe(iso) { const d = dow(iso); const seg = somaDias(iso, d === 0 ? -6 : 1 - d); return { inicio: seg, fim: somaDias(seg, 6) }; }
export function limitesMesDe(iso) {
  const [y, m] = iso.split("-").map(Number);
  const fim = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { inicio: `${y}-${String(m).padStart(2, "0")}-01`, fim };
}
const dia10MesSeguinte = iso => { const [y, m] = iso.split("-").map(Number); const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1; return `${ny}-${String(nm).padStart(2, "0")}-10`; };
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const nomeMes = iso => `${MESES[Number(iso.split("-")[1]) - 1]}/${iso.split("-")[0]}`;
function diasUteisRestantes(hojeISO, fimISO) { let n = 0; for (let d = diaNum(hojeISO); d <= diaNum(fimISO); d++) { const w = new Date(d * 86400000).getUTCDay(); if (w !== 0 && w !== 6) n++; } return n; }

// ---- dados ----
export function headersAdmin() { const k = process.env.SUPABASE_SERVICE_ROLE_KEY; return { apikey: k, Authorization: `Bearer ${k}` }; }
async function get(path) { const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: headersAdmin() }); const j = await r.json().catch(() => []); return Array.isArray(j) ? j : []; }

export async function carregarBase() {
  const [equipe, negocios, cadastros, grupos] = await Promise.all([
    get("nexus_equipe?select=user_id,nome,cargo,telefone,meta_mensal_sacas&order=ordem.asc"),
    get("nexus_negocios?deleted_at=is.null&select=id,numero_contrato,data,grao,safra,quantidade,comissao,comissao_corretor,corretor_id,produtor_id,cliente_id,contraparte,status,data_pagamento,data_inicio_embarque,data_fim_embarque,embarque_finalizado,check_confirmacao,check_contrato,check_nota_fiscal,check_contra_nota,check_liberacao_embarque,check_embarque_entrega,check_pagamento,comissao_recebida_em&limit=5000"),
    get("nexus_cadastros?select=id,nome,tipo,owner_id,grupo_id&limit=5000"),
    get("nexus_grupos?select=id,nome"),
  ]);
  const proprietario = equipe.find(e => /propriet/i.test(e.cargo || "")) || equipe[0] || null;
  return { equipe, negocios, cadastros, grupos, proprietario };
}
export const nomeCad = (base, id) => (base.cadastros.find(c => c.id === id) || {}).nome || "";
const nomeComprador = (base, n) => nomeCad(base, n.cliente_id) || n.contraparte || "";

// Negócios "do" corretor: os dele; os sem corretor ficam com o proprietário.
export function negociosDoCorretor(base, corretor) {
  const ehProp = base.proprietario && base.proprietario.user_id === corretor.user_id;
  return base.negocios.filter(n => n.corretor_id === corretor.user_id || (ehProp && !n.corretor_id));
}
const sacas = n => Number(n.quantidade || 0), com = n => Number(n.comissao || 0), comCor = n => Number(n.comissao_corretor || 0);
const soma = (l, f) => l.reduce((s, n) => s + f(n), 0);
const noPeriodo = (l, p) => l.filter(n => n.data && n.data >= p.inicio && n.data <= p.fim);

// ---- meta ----
export function linhaMeta(base, corretor, hoje) {
  const meta = Number(corretor.meta_mensal_sacas || 0);
  if (!meta) return "";
  const mes = limitesMesDe(hoje);
  const feitas = soma(noPeriodo(negociosDoCorretor(base, corretor), mes), sacas);
  const p = feitas / meta * 100;
  const faltam = Math.max(0, meta - feitas);
  const uteis = diasUteisRestantes(hoje, mes.fim);
  const barra = "▓".repeat(Math.min(10, Math.floor(p / 10))) + "░".repeat(10 - Math.min(10, Math.floor(p / 10)));
  let l = `🎯 *Meta de ${MESES[Number(hoje.split("-")[1]) - 1]}:* ${barra} ${pct(p)}\n   ${fmtNum(feitas)} de ${fmtNum(meta)} sc`;
  if (faltam > 0) l += ` — faltam ${fmtNum(faltam)} sc${uteis > 0 ? ` (≈ ${fmtNum(faltam / uteis)} sc por dia útil, ${uteis} dias úteis restantes)` : ""}`;
  else l += " — *meta batida!* 🎉";
  return l;
}

// ---- resumo da manhã ----
export function montarMatinal(base, corretor, hoje) {
  const meus = negociosDoCorretor(base, corretor).filter(n => n.status !== "Finalizado" || n.data_pagamento === hoje);
  const secoes = [];
  const item = n => `• *${n.numero_contrato || "—"}* — ${nomeCad(base, n.produtor_id) || "—"}${nomeComprador(base, n) ? ` (${nomeComprador(base, n)})` : ""}`;

  // 1. pagamentos de hoje
  const pagHoje = meus.filter(n => n.data_pagamento === hoje && !n.check_pagamento);
  if (pagHoje.length) secoes.push(`💵 *Pagamentos agendados para hoje*\n${pagHoje.map(n => `${item(n)}\n   ${[n.grao, n.safra].filter(Boolean).join(" ")} · ${fmtNum(sacas(n))} sc · comissão ${fmtMoney(com(n))}`).join("\n")}${pagHoje.length > 1 ? `\n   _Comissão total: ${fmtMoney(soma(pagHoje, com))}_` : ""}`);

  // 2. embarques
  const atrasados = meus.filter(n => n.data_fim_embarque && n.data_fim_embarque < hoje && !n.embarque_finalizado);
  const comecam = meus.filter(n => n.data_inicio_embarque === hoje);
  const linhasEmb = [];
  if (comecam.length) linhasEmb.push(`Começam hoje:\n${comecam.map(n => `${item(n)} · ${fmtNum(sacas(n))} sc`).join("\n")}`);
  if (atrasados.length) linhasEmb.push(`⚠️ Atrasados (${atrasados.length}):\n${atrasados.slice(0, 5).map(n => `${item(n)} — previsto até ${fmtDate(n.data_fim_embarque)}`).join("\n")}${atrasados.length > 5 ? `\n   …e mais ${atrasados.length - 5}` : ""}`);
  if (linhasEmb.length) secoes.push(`🚚 *Embarques*\n${linhasEmb.join("\n")}`);

  // 3. pendências vencidas da agenda (últimos 30 dias)
  const limite = somaDias(hoje, -30);
  const regras = [
    ["Confirmação", n => n.data, "check_confirmacao"], ["Contrato", n => n.data && somaDias(n.data, 1), "check_contrato"],
    ["Nota Fiscal", n => n.data_inicio_embarque && somaDias(n.data_inicio_embarque, -1), "check_nota_fiscal"],
    ["Contra Nota", n => n.data_inicio_embarque && somaDias(n.data_inicio_embarque, -1), "check_contra_nota"],
    ["Liberação de embarque", n => n.data_inicio_embarque && somaDias(n.data_inicio_embarque, -1), "check_liberacao_embarque"],
    ["Pagamento", n => n.data_pagamento, "check_pagamento"],
  ];
  const porContrato = new Map();
  for (const [rotulo, dataDe, campo] of regras) {
    for (const n of meus) { const d = dataDe(n); if (d && d < hoje && d >= limite && !n[campo]) { if (!porContrato.has(n.id)) porContrato.set(n.id, { n, tipos: [] }); porContrato.get(n.id).tipos.push(rotulo); } }
  }
  const pend = [...porContrato.values()].slice(0, 6).map(x => `• *${x.n.numero_contrato || "—"}* — ${x.tipos.join(", ")}`);
  if (porContrato.size > 6) pend.push(`   …e mais ${porContrato.size - 6} contrato${porContrato.size - 6 > 1 ? "s" : ""}`);
  if (pend.length) secoes.push(`📋 *Pendências vencidas* (${porContrato.size} contrato${porContrato.size > 1 ? "s" : ""})\n${pend.join("\n")}`);

  // 4. comissões do cliente
  const abertas = meus.filter(n => n.data_pagamento && !n.comissao_recebida_em && com(n) > 0).map(n => ({ n, venc: dia10MesSeguinte(n.data_pagamento) }));
  const vencidas = abertas.filter(x => x.venc < hoje), vencendo = abertas.filter(x => x.venc >= hoje && x.venc <= somaDias(hoje, 3));
  const linhasCom = [];
  if (vencidas.length) linhasCom.push(`Vencidas: ${vencidas.length} · ${fmtMoney(soma(vencidas, x => com(x.n)))}`);
  if (vencendo.length) linhasCom.push(`Vencem nos próximos 3 dias: ${vencendo.length} · ${fmtMoney(soma(vencendo, x => com(x.n)))}`);
  if (linhasCom.length) secoes.push(`💰 *Comissões a receber dos clientes*\n${linhasCom.join("\n")}`);

  // 5. produtores da carteira parados há muito tempo
  const carteira = base.cadastros.filter(c => c.tipo === "Produtor" && c.owner_id === corretor.user_id);
  const ultimoPorUnidade = new Map();
  for (const c of carteira) {
    const chave = c.grupo_id || c.id;
    const membros = c.grupo_id ? base.cadastros.filter(x => x.grupo_id === c.grupo_id).map(x => x.id) : [c.id];
    const datas = base.negocios.filter(n => membros.includes(n.produtor_id) && n.data).map(n => n.data).sort();
    const nome = c.grupo_id ? ((base.grupos.find(g => g.id === c.grupo_id) || {}).nome || c.nome) : c.nome;
    ultimoPorUnidade.set(chave, { nome, ultimo: datas[datas.length - 1] || null });
  }
  const parados = [...ultimoPorUnidade.values()].filter(u => u.ultimo && diasEntre(u.ultimo, hoje) >= 45).sort((a, b) => a.ultimo.localeCompare(b.ultimo));
  if (parados.length) secoes.push(`📞 *Sem negociar há mais de 45 dias* (${parados.length})\n${parados.slice(0, 5).map(u => `• ${u.nome} — há ${diasEntre(u.ultimo, hoje)} dias`).join("\n")}${parados.length > 5 ? `\n   …e mais ${parados.length - 5}` : ""}`);

  if (!secoes.length) return null;
  const nome = String(corretor.nome || "").split(" ")[0];
  const meta = linhaMeta(base, corretor, hoje);
  return `☀️ *Bom dia, ${nome}!* Seu resumo de hoje (${fmtDate(hoje)}):\n\n${secoes.join("\n\n")}${meta ? `\n\n${meta}` : ""}\n\n*Nexus Commodities*`;
}

// ---- conquistas e resumos de período ----
// Conquistas do período entre os corretores (só total agregado; nunca detalha negócios alheios).
export function conquistasDoPeriodo(base, periodo, { mensal = false } = {}) {
  const linhas = base.equipe.map(e => {
    const l = noPeriodo(negociosDoCorretor(base, e), periodo);
    const maior = l.slice().sort((a, b) => com(b) - com(a))[0];
    return { e, l, sacas: soma(l, sacas), n: l.length, maior };
  });
  const out = [];
  const topSacas = linhas.slice().sort((a, b) => b.sacas - a.sacas)[0];
  if (topSacas && topSacas.sacas > 0) out.push({ id: topSacas.e.user_id, icone: "🏆", titulo: mensal ? "Corretor do mês" : "Corretor da semana", detalhe: `${fmtNum(topSacas.sacas)} sc` });
  const topMaior = linhas.filter(x => x.maior).sort((a, b) => com(b.maior) - com(a.maior))[0];
  if (topMaior && com(topMaior.maior) > 0) out.push({ id: topMaior.e.user_id, icone: "⭐", titulo: "Maior negócio", detalhe: `comissão de ${fmtMoney(com(topMaior.maior))} no ${topMaior.maior.numero_contrato || "—"}` });
  const topNeg = linhas.filter(x => x.n >= 2).sort((a, b) => b.n - a.n || b.sacas - a.sacas)[0];
  if (topNeg) out.push({ id: topNeg.e.user_id, icone: "🤝", titulo: "Mais negócios fechados", detalhe: `${topNeg.n} negócios` });
  if (mensal) for (const x of linhas) { const meta = Number(x.e.meta_mensal_sacas || 0); if (meta > 0 && x.sacas >= meta) out.push({ id: x.e.user_id, icone: "🎯", titulo: "Meta batida", detalhe: `${fmtNum(x.sacas)} de ${fmtNum(meta)} sc` }); }
  return out;
}

function variacao(atual, anterior) {
  if (!anterior) return "";
  const v = (atual - anterior) / anterior * 100;
  return ` (${v >= 0 ? "▲" : "▼"} ${Math.abs(v).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}% vs. anterior)`;
}

export function montarResumoPeriodo(base, corretor, { periodo, anterior, rotulo, mensal }) {
  const meus = negociosDoCorretor(base, corretor);
  const l = noPeriodo(meus, periodo), la = noPeriodo(meus, anterior);
  const ranking = base.equipe.map(e => ({ id: e.user_id, s: soma(noPeriodo(negociosDoCorretor(base, e), periodo), sacas) })).sort((a, b) => b.s - a.s);
  const pos = ranking.findIndex(r => r.id === corretor.user_id) + 1;
  const conq = conquistasDoPeriodo(base, periodo, { mensal });
  const nome = String(corretor.nome || "").split(" ")[0];
  const linhas = [`📊 *${nome}, seu resumo ${mensal ? "do mês" : "da semana"}* — ${rotulo}`, ""];
  if (!l.length) linhas.push("Nenhum negócio fechado no período.");
  else {
    linhas.push(`🤝 *${l.length}* negócio${l.length > 1 ? "s" : ""}${variacao(l.length, la.length)}`);
    linhas.push(`📦 *${fmtNum(soma(l, sacas))} sc*${variacao(soma(l, sacas), soma(la, sacas))}`);
    linhas.push(`💰 Comissão gerada: *${fmtMoney(soma(l, com))}*${variacao(soma(l, com), soma(la, com))}`);
    if (soma(l, comCor) > 0) linhas.push(`👤 Sua parte: *${fmtMoney(soma(l, comCor))}*`);
  }
  if (ranking.length > 1 && ranking[pos - 1] && ranking[pos - 1].s > 0) linhas.push(`📈 Posição em sacas: *${pos}º de ${ranking.length}*`);
  const meta = Number(corretor.meta_mensal_sacas || 0);
  if (meta > 0) {
    const mesRef = limitesMesDe(periodo.fim);
    const feitas = soma(noPeriodo(meus, mesRef), sacas);
    if (mensal) linhas.push(`🎯 Meta do mês: ${pct(feitas / meta * 100)} (${fmtNum(feitas)} de ${fmtNum(meta)} sc)${feitas >= meta ? " ✅" : ""}`);
    else { const hojeMeta = linhaMeta(base, corretor, somaDias(periodo.fim, 1)); if (hojeMeta) linhas.push("", hojeMeta); }
  }
  const minhas = conq.filter(c => c.id === corretor.user_id);
  if (minhas.length) linhas.push("", ...minhas.map(c => `${c.icone} *${c.titulo}!* ${c.detalhe}`));
  const outras = conq.filter(c => c.id !== corretor.user_id).map(c => `${c.icone} ${c.titulo}: ${(base.equipe.find(e => e.user_id === c.id) || {}).nome || ""}`);
  if (outras.length) linhas.push("", "*Destaques da equipe*", ...outras);
  linhas.push("", "*Nexus Commodities*");
  return linhas.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function montarResumoEquipe(base, { periodo, anterior, rotulo, mensal }) {
  const l = noPeriodo(base.negocios, periodo), la = noPeriodo(base.negocios, anterior);
  const linhas = [`🏢 *Resumo da equipe ${mensal ? "do mês" : "da semana"}* — ${rotulo}`, ""];
  linhas.push(`🤝 *${l.length}* negócios${variacao(l.length, la.length)}`);
  linhas.push(`📦 *${fmtNum(soma(l, sacas))} sc*${variacao(soma(l, sacas), soma(la, sacas))}`);
  linhas.push(`💰 Comissão gerada: *${fmtMoney(soma(l, com))}*${variacao(soma(l, com), soma(la, com))}`);
  linhas.push("", "*Por corretor*");
  const porCor = base.equipe.map(e => { const x = noPeriodo(negociosDoCorretor(base, e), periodo); return { e, n: x.length, s: soma(x, sacas), c: soma(x, com) }; }).sort((a, b) => b.s - a.s);
  porCor.forEach((x, i) => linhas.push(`${["🥇", "🥈", "🥉"][i] || `${i + 1}.`} ${x.e.nome} — ${fmtNum(x.s)} sc · ${x.n} negócio${x.n === 1 ? "" : "s"} · ${fmtMoney(x.c)}`));
  const conq = conquistasDoPeriodo(base, periodo, { mensal });
  if (conq.length) linhas.push("", "*Destaques*", ...conq.map(c => `${c.icone} ${c.titulo}: ${(base.equipe.find(e => e.user_id === c.id) || {}).nome || ""} — ${c.detalhe}`));
  linhas.push("", "*Nexus Commodities*");
  return linhas.join("\n");
}

// ---- fila ----
// Enfileira (1 mensagem a cada 3 min pelo processar-fila-whatsapp) sem repetir o mesmo tipo/telefone no dia.
export async function enfileirar(mensagens, tipo, hoje) {
  const inicioDia = `${hoje}T00:00:00-04:00`;
  const ja = await get(`nexus_whatsapp_fila?tipo=eq.${encodeURIComponent(tipo)}&criado_em=gte.${encodeURIComponent(inicioDia)}&select=telefone`);
  const jaTel = new Set(ja.map(f => f.telefone));
  const novos = mensagens.filter(m => m.telefone && !jaTel.has(m.telefone)).map(m => ({ telefone: m.telefone, mensagem: m.mensagem, tipo }));
  if (novos.length) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/nexus_whatsapp_fila`, { method: "POST", headers: { ...headersAdmin(), "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(novos) });
    if (!r.ok) throw new Error(`Falha ao enfileirar (status ${r.status}).`);
  }
  return novos.length;
}

export async function registrarLog(tipo, enfileirados, semTelefone) {
  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST", headers: { ...headersAdmin(), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ negocio_id: null, tipo, destinatarios: `${enfileirados} mensagem(ns) enfileirada(s)`, enviado_por: null, sucesso: semTelefone.length === 0, erro: semTelefone.length ? `Corretor sem telefone cadastrado em Equipe: ${semTelefone.join(", ")}` : null }),
  }).catch(() => {});
}

// Gera e enfileira os resumos de período pra equipe toda (cada um o seu + resumo da equipe pro proprietário).
export async function enviarResumosDePeriodo({ periodo, anterior, rotulo, mensal, tipo }) {
  const hoje = hojeCampoGrande();
  const base = await carregarBase();
  const msgs = [], semTelefone = [];
  for (const e of base.equipe) {
    const telefone = formatarTelefoneWhats(e.telefone);
    if (!telefone) { semTelefone.push(e.nome); continue; }
    msgs.push({ telefone, mensagem: montarResumoPeriodo(base, e, { periodo, anterior, rotulo, mensal }) });
  }
  const prop = base.proprietario, telProp = prop && formatarTelefoneWhats(prop.telefone);
  if (telProp) msgs.push({ telefone: telProp, mensagem: montarResumoEquipe(base, { periodo, anterior, rotulo, mensal }) });
  // mesmo telefone do proprietário recebe dois textos: o tipo de dedupe precisa diferenciar, então grava o resumo da equipe com tipo próprio.
  const proprio = msgs.filter((m, i) => !(telProp && i === msgs.length - 1));
  const equipeMsg = telProp ? [msgs[msgs.length - 1]] : [];
  const n1 = await enfileirar(proprio, tipo, hoje);
  const n2 = await enfileirar(equipeMsg, `${tipo} (equipe)`, hoje);
  await registrarLog(`WhatsApp ${tipo}`, n1 + n2, semTelefone);
  return { enfileirados: n1 + n2, semTelefone };
}
