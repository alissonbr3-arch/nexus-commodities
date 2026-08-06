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
