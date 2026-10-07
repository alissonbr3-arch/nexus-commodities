// Biblioteca compartilhada da nota fiscal (NFS-e) da comissão — usada pelo webhook do Asaas, pela
// sincronização a cada 30 min e pelos botões do painel. Não é uma function por si só.
const SUPABASE_URL = "https://ixvdltjiswgcyxikxskr.supabase.co";
const ASAAS_BASE_URL = "https://api.asaas.com/v3";
const FROM_EMAIL = "Nexus Commodities <contratos@nexuscommoditiesms.com.br>";
const BCC_NEXUS = "nexuscommodities@terra.com.br";
const ASSINATURA_EMAIL_HTML = `
  <table style="margin-top:24px;padding-top:16px;border-top:1px solid #ddd;font-family:Arial,Helvetica,sans-serif">
    <tr>
      <td style="padding-right:12px"><img src="https://painel.nexuscommoditiesms.com.br/logo-nexus.png" alt="Nexus Commodities" width="48" height="48" style="display:block"></td>
      <td style="font-size:12px;color:#555;line-height:1.5">
        <strong style="color:#111;font-size:13px">Nexus Commodities</strong><br>
        (67) 99130-9516<br>
        São Gabriel do Oeste - MS
      </td>
    </tr>
  </table>`;

function fmtMoney(v) { return "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function escapeHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

export function headersAdmin() {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: k, Authorization: `Bearer ${k}` };
}
const headersJson = () => ({ ...headersAdmin(), "Content-Type": "application/json", Prefer: "return=minimal" });

// Campos da nota fiscal no negócio a partir do objeto invoice do Asaas (webhook ou consulta direta).
export function patchDaNota(inv) {
  const patch = { nota_fiscal_status: inv.status };
  if (inv.number) patch.nota_fiscal_numero = String(inv.number);
  if (inv.pdfUrl) patch.nota_fiscal_url = inv.pdfUrl;
  if (inv.status === "AUTHORIZED") {
    patch.nota_fiscal_emitida_em = inv.effectiveDate || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    patch.nota_fiscal_erro = null;
  }
  if (inv.status === "ERROR") patch.nota_fiscal_erro = inv.statusDescription || "Erro na emissão da nota — veja o detalhe no painel do Asaas.";
  return patch;
}

// Manda a nota autorizada por e-mail (PDF anexado + link) pro(s) e-mail(s) de cadastro de quem
// paga a comissão (o tomador da nota), com cópia oculta pra Nexus. Sem `forcar`, manda UMA vez só
// por nota (a primeira function que "reservar" a coluna nota_fiscal_email_enviado_em é quem envia
// — webhook e sincronização podem chegar juntos). Com `forcar` (botão do painel), reenvia.
export async function enviarEmailDaNota(inv, { forcar = false, enviadoPor = null } = {}) {
  const resendKey = process.env.RESEND_API_KEY;
  const asaasKey = process.env.ASAAS_API_KEY;
  const alvo = `${SUPABASE_URL}/rest/v1/nexus_negocios?nota_fiscal_asaas_id=eq.${inv.id}`;
  const agora = new Date().toISOString();

  let negocios;
  if (forcar) {
    negocios = await (await fetch(`${alvo}&deleted_at=is.null&select=*`, { headers: headersAdmin() })).json().catch(() => []);
  } else {
    const claim = await fetch(`${alvo}&nota_fiscal_email_enviado_em=is.null`, {
      method: "PATCH", headers: { ...headersAdmin(), "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ nota_fiscal_email_enviado_em: agora, nota_fiscal_email_erro: null }),
    });
    negocios = await claim.json().catch(() => []);
    if (!Array.isArray(negocios) || negocios.length === 0) return { ok: true, jaEnviado: true };
  }
  if (!Array.isArray(negocios) || negocios.length === 0) return { ok: false, erro: "Negócio da nota não encontrado." };

  const liberar = async (erro) => {
    await fetch(alvo, { method: "PATCH", headers: headersJson(), body: JSON.stringify({ nota_fiscal_email_enviado_em: forcar ? undefined : null, nota_fiscal_email_erro: erro }) });
    await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
      method: "POST", headers: headersJson(),
      body: JSON.stringify({ negocio_id: negocios[0].id, tipo: "Nota fiscal por e-mail", destinatarios: "—", enviado_por: enviadoPor, sucesso: false, erro }),
    }).catch(() => {});
    return { ok: false, erro };
  };

  const base = negocios[0];
  const pagadorId = base.comissao_pagador === "Comprador" ? base.cliente_id : base.produtor_id;
  const cad = (await (await fetch(`${SUPABASE_URL}/rest/v1/nexus_cadastros?id=eq.${pagadorId}&select=nome,email,emails_extra`, { headers: headersAdmin() })).json().catch(() => []))[0];
  if (!cad) return liberar("Não encontrei o cadastro de quem recebe a nota.");
  const destinatarios = [...new Set([cad.email, ...(cad.emails_extra || [])].filter(Boolean))];
  if (!destinatarios.length) return liberar(`${cad.nome} não tem e-mail cadastrado — cadastre em Cadastros e use "Enviar por e-mail" na nota.`);
  if (!resendKey) return liberar("RESEND_API_KEY não configurada.");

  const contratos = negocios.map(n => n.numero_contrato || "—").join(", ");
  const numero = inv.number ? String(inv.number) : (base.nota_fiscal_numero || "");
  const valor = inv.value != null ? Number(inv.value) : negocios.reduce((s, n) => s + Number(n.comissao || 0), 0);
  const pdfUrl = inv.pdfUrl || base.nota_fiscal_url;

  let anexo = null;
  if (pdfUrl) {
    try {
      const r = await fetch(pdfUrl, { headers: { access_token: asaasKey || "" } });
      const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : null;
      if (buf && buf.length > 1000 && buf.length < 7_000_000 && buf.slice(0, 4).toString() === "%PDF") {
        anexo = { filename: `NFS-e ${numero || "nota"} - ${cad.nome}.pdf`.replace(/[\\/]/g, "-"), content: buf.toString("base64") };
      }
    } catch {}
  }

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_EMAIL, to: destinatarios, bcc: BCC_NEXUS,
        subject: `Nota Fiscal de Serviço${numero ? " nº " + numero : ""} — Nexus Commodities`,
        html: `<p>Olá, ${escapeHtml(cad.nome)}!</p><p>Segue ${anexo ? "em anexo " : ""}a Nota Fiscal de Serviço${numero ? " nº " + escapeHtml(numero) : ""}, no valor de <strong>${fmtMoney(valor)}</strong>, referente à comissão de intermediação — ${negocios.length === 1 ? "Confirmação de Negócio" : "Confirmações de Negócio"} nº ${escapeHtml(contratos)}.</p>${pdfUrl ? `<p>Também pode abrir a nota por aqui: <a href="${escapeHtml(pdfUrl)}">${escapeHtml(pdfUrl)}</a></p>` : ""}<p>Qualquer dúvida, fale com seu corretor.</p>${ASSINATURA_EMAIL_HTML}`,
        ...(anexo ? { attachments: [anexo] } : {}),
      }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.message || JSON.stringify(j));
  } catch (e) {
    return liberar(`Falha no envio do e-mail: ${String(e.message || e)}`);
  }

  await fetch(alvo, { method: "PATCH", headers: headersJson(), body: JSON.stringify({ nota_fiscal_email_enviado_em: agora, nota_fiscal_email_erro: null }) });
  await fetch(`${SUPABASE_URL}/rest/v1/nexus_email_log`, {
    method: "POST", headers: headersJson(),
    body: JSON.stringify({ negocio_id: base.id, tipo: "Nota fiscal por e-mail", destinatarios: `${destinatarios.join(", ")} — contratos: ${contratos}${anexo ? "" : " (sem PDF anexado, só o link)"}`, enviado_por: enviadoPor, sucesso: true, erro: null }),
  }).catch(() => {});
  return { ok: true, destinatarios, comAnexo: !!anexo };
}

// Grava o estado atual da nota no negócio e, se acabou de ser autorizada, manda por e-mail.
export async function aplicarNotaDoAsaas(inv) {
  await fetch(`${SUPABASE_URL}/rest/v1/nexus_negocios?nota_fiscal_asaas_id=eq.${inv.id}`, {
    method: "PATCH", headers: headersJson(), body: JSON.stringify(patchDaNota(inv)),
  });
  if (inv.status === "AUTHORIZED") return enviarEmailDaNota(inv);
  return { ok: true };
}

// Pergunta direto ao Asaas o estado da nota e aplica (e envia o e-mail se for o caso).
export async function sincronizarNotaDoAsaas(invId) {
  const r = await fetch(`${ASAAS_BASE_URL}/invoices/${invId}`, { headers: { access_token: process.env.ASAAS_API_KEY } });
  const inv = await r.json().catch(() => ({}));
  if (!r.ok || !inv.status) return { ok: false, erro: inv.errors?.[0]?.description || `Asaas retornou ${r.status}` };
  const email = await aplicarNotaDoAsaas(inv);
  return { ok: true, status: inv.status, email, invoice: inv };
}
