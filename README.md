# Nexus Commodities — Painel de Coordenação

Site estático (single-file, `index.html`) com login e dados em tempo real via Supabase.
Já está publicado em: https://nexuscommodities.netlify.app/

## Estrutura

- `index.html` — site completo (HTML + CSS + JS embutidos). É este arquivo que precisa ser reenviado a cada atualização.
- `netlify.toml` — configuração mínima de deploy (sem build, publica a pasta raiz).

## Backend (Supabase)

- Projeto: `ixvdltjiswgcyxikxskr`
- URL e anon key já estão embutidos no `index.html` (constantes `SUPABASE_URL` / `SUPABASE_ANON_KEY`).
- Tabelas: `nexus_negocios`, `nexus_embarques`, `nexus_cadastros`, `nexus_tarefas`, `nexus_cotacoes`, `nexus_dolar`, `nexus_equipe`.
- Autenticação: e-mail/senha (Supabase Auth), 3 contas já criadas para os corretores.
- Cotação do dólar (PTAX) é atualizada automaticamente todo dia útil às 18h por uma tarefa agendada que já está rodando — não precisa mexer em nada aqui.

## Cotações automáticas (CBOT via Yahoo Finance)

- `netlify/functions/_cotacoes-lib.mjs` — lógica compartilhada: busca Soja Set/Nov/Mar
  (`ZSU26.CBT`/`ZSX26.CBT`/`ZSH27.CBT`) e Milho CBOT (`ZC=F`) na API não-oficial do
  Yahoo Finance, converte pra R$/saca usando o câmbio salvo em `nexus_dolar`, e grava
  em `nexus_cotacoes` (casando pela coluna `codigo`).
- `netlify/functions/atualizar-cotacoes.mjs` — versão invocável na hora (botão
  "Atualizar CBOT agora" na tela de Cotações, chama `/.netlify/functions/atualizar-cotacoes`).
- `netlify/functions/atualizar-cotacoes-cron.mjs` — mesma lógica, mas roda sozinha de
  hora em hora em dias úteis (`schedule` no próprio arquivo).
- Precisa da variável de ambiente `SUPABASE_SERVICE_ROLE_KEY` configurada no Netlify
  (Site settings → Environment variables) — é a chave `service_role` do projeto
  Supabase (Settings → API), usada só no servidor pra poder escrever na tabela
  ignorando RLS. **Nunca** coloque essa chave no `index.html` nem no código do site.
- Milho B3 e as demais linhas continuam manuais — não existe API acessível para isso
  (só licenciamento institucional direto com a B3).

## Como publicar uma atualização

Este site já está conectado à sua conta Netlify (site `nexuscommodities`). Duas formas de publicar depois de editar o `index.html`:

**Opção 1 — Netlify CLI (recomendado, permite automação futura):**

```bash
npm install -g netlify-cli
netlify login
netlify link          # escolha o site "nexuscommodities"
netlify deploy --prod --dir=.
```

**Opção 2 — Netlify Drop (manual):**

Acesse https://app.netlify.com/drop e arraste a pasta com o `index.html` por cima do site já existente (Site settings → mesmo site).

## Observação de segurança

O arquivo contém a `anon key` do Supabase, que é pública por design (protegida pelas políticas de RLS do banco). Não há senhas nem chaves privadas neste diretório.
