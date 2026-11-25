// Ponte entre o painel da Nexus e o Google Drive da pasta NEXUS COMMODITIES.
// Fica no script.google.com da conta nexuscommodities@terra.com.br (dona da pasta), publicado como
// "App da Web"  executar como: Eu; quem pode acessar: Qualquer pessoa.
// O painel (funcao documento-ia no Netlify) manda o arquivo ja lido pela IA e este script
// acha (ou cria) a pasta do contrato e salva o arquivo la dentro.
//
// Em Configuracoes do projeto  Propriedades do script, criar TOKEN com a mesma senha que
// esta no Netlify como DRIVE_SCRIPT_TOKEN.

const PASTA_RAIZ_ID = "1DCPXx60Dr88Ar5mq77FuuAwsaO4y9OBq"; // NEXUS COMMODITIES
const MESES = ["JANEIRO", "FEVEREIRO", "MAR\u00C7O", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];

function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    const token = PropertiesService.getScriptProperties().getProperty("TOKEN");
    if (!token || p.token !== token) return resposta({ ok: false, erro: "Token inv\u00E1lido." });

    // "caminho": lista de pastas a partir de NEXUS COMMODITIES (ex.: ["PRODUTORES / CLIENTES", "FULANO DE TAL"]),
    // criadas se faltarem. Sem caminho: pasta do contrato.
    const pasta = Array.isArray(p.caminho) && p.caminho.length ? pastaPorCaminho(p.caminho) : pastaDoContrato(p.contrato, p.nome_pasta, p.data_negocio);
    let nome = p.nome_arquivo;
    // Pagamentos sao numerados na ordem: 01 - PGTO..., 02 - PGTO...
    if (nome.indexOf("{SEQ}") >= 0) {
      let n = 0;
      const arqs = pasta.getFiles();
      while (arqs.hasNext()) if (/PGTO/i.test(arqs.next().getName())) n++;
      nome = nome.replace("{SEQ}", String(n + 1).padStart(2, "0"));
    }
    const blob = Utilities.newBlob(Utilities.base64Decode(p.base64), p.mime, nome);
    const arquivo = pasta.createFile(blob);
    return resposta({ ok: true, nome: nome, url: arquivo.getUrl(), pasta: pasta.getName(), pasta_url: pasta.getUrl() });
  } catch (err) {
    return resposta({ ok: false, erro: String(err && err.message || err) });
  }
}

// Procura a pasta "Confirmacao CT-2026-108 - ..." em qualquer lugar dentro de NEXUS COMMODITIES;
// se nao existir, cria em CONFIRMACOES {ano} / MES {mm} ({MES} {ano}) pela data do negocio.
function pastaDoContrato(contrato, nomePasta, dataNegocio) {
  const raiz = DriveApp.getFolderById(PASTA_RAIZ_ID);
  if (contrato) {
    const achadas = DriveApp.searchFolders('title contains "' + contrato.replace(/"/g, "") + '" and trashed = false');
    while (achadas.hasNext()) {
      const f = achadas.next();
      if (f.getName().indexOf(contrato) >= 0 && dentroDe(f, PASTA_RAIZ_ID)) return f;
    }
  } else {
    return filha(raiz, "DOCUMENTOS SEM CONTRATO");
  }
  const d = dataNegocio ? new Date(dataNegocio + "T12:00:00") : new Date();
  const ano = d.getFullYear(), mes = d.getMonth();
  const pastaAno = filha(raiz, "CONFIRMAC\u00D5ES " + ano);
  const pastaMes = filha(pastaAno, "M\u00CAS " + String(mes + 1).padStart(2, "0") + " (" + MESES[mes] + " " + ano + ")");
  return filha(pastaMes, nomePasta || ("Confirma\u00E7\u00E3o " + contrato));
}

function pastaPorCaminho(caminho) {
  let pasta = DriveApp.getFolderById(PASTA_RAIZ_ID);
  for (let i = 0; i < caminho.length; i++) pasta = filhaSemDiferenciar(pasta, String(caminho[i]).trim());
  return pasta;
}

// Acha a subpasta ignorando maiusculas e acentos ("Joao da Silva" = "JO\u00C3O DA SILVA"); cria se nao existir.
function filhaSemDiferenciar(pai, nome) {
  const chave = function (s) { return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim(); };
  const alvo = chave(nome), it = pai.getFolders();
  while (it.hasNext()) { const f = it.next(); if (chave(f.getName()) === alvo) return f; }
  return pai.createFolder(nome);
}

function filha(pai, nome) {
  const it = pai.getFoldersByName(nome);
  return it.hasNext() ? it.next() : pai.createFolder(nome);
}

function dentroDe(pasta, idRaiz) {
  let atuais = [pasta];
  for (let nivel = 0; nivel < 6 && atuais.length; nivel++) {
    const proximas = [];
    for (const f of atuais) {
      const pais = f.getParents();
      while (pais.hasNext()) {
        const p = pais.next();
        if (p.getId() === idRaiz) return true;
        proximas.push(p);
      }
    }
    atuais = proximas;
  }
  return false;
}

function resposta(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Rode esta uma vez pelo editor (botao Executar) pra autorizar o acesso ao Drive.
function autorizar() {
  Logger.log(DriveApp.getFolderById(PASTA_RAIZ_ID).getName());
}
