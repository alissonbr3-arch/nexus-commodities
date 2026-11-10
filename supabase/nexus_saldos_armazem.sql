-- Saldo de grão que o produtor tem guardado em cada armazém, por inscrição estadual (fazenda),
-- grão e safra. É o número que o próprio produtor informa ("tenho X sacas de soja no armazém Y
-- na IE Z") — vai junto no Relatório de Negócios pra ele ver, além do que vendeu com a Nexus,
-- quanto ainda tem em cada armazém.
create table if not exists public.nexus_saldos_armazem (
  id uuid primary key default gen_random_uuid(),
  produtor_id uuid not null references public.nexus_cadastros(id) on delete cascade,
  armazem_id uuid references public.nexus_cadastros(id) on delete set null,
  armazem_nome text,                       -- quando o armazém não está cadastrado na Nexus
  fazenda_id uuid references public.nexus_fazendas(id) on delete set null, -- = inscrição estadual
  grao text not null,
  safra text,
  quantidade numeric not null default 0,   -- sacas
  data_referencia date not null default current_date, -- quando o produtor informou o saldo
  obs text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nexus_saldos_armazem_tem_armazem check (armazem_id is not null or coalesce(trim(armazem_nome), '') <> '')
);
create index if not exists nexus_saldos_armazem_produtor_idx on public.nexus_saldos_armazem (produtor_id);

alter table public.nexus_saldos_armazem enable row level security;

drop policy if exists nexus_saldos_armazem_staff on public.nexus_saldos_armazem;
create policy nexus_saldos_armazem_staff on public.nexus_saldos_armazem
  for all to authenticated using (is_nexus_staff(auth.uid())) with check (is_nexus_staff(auth.uid()));

-- Portal do cliente: o produtor só enxerga os próprios saldos.
drop policy if exists nexus_saldos_armazem_cliente_select on public.nexus_saldos_armazem;
create policy nexus_saldos_armazem_cliente_select on public.nexus_saldos_armazem
  for select using (produtor_id = any (nexus_meus_cadastro_ids(auth.uid())));

drop trigger if exists nexus_saldos_armazem_audit on public.nexus_saldos_armazem;
create trigger nexus_saldos_armazem_audit after insert or delete or update on public.nexus_saldos_armazem
  for each row execute function nexus_audit_trigger();
