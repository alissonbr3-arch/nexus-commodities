-- Histórico das metas dos corretores (aplicado em 24/11/2026).
-- Cada mudança de meta vale a partir do dia em que foi feita; a meta de um mês é a última mudança
-- feita até o fim daquele mês. Assim, mudar a meta não reescreve os meses que já passaram.
create table if not exists public.nexus_metas_historico (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  meta_mensal_sacas numeric,
  vigente_desde date not null,
  created_at timestamptz not null default now()
);
create index if not exists nexus_metas_historico_user_idx on public.nexus_metas_historico (user_id, vigente_desde);
alter table public.nexus_metas_historico enable row level security;
create policy nexus_metas_historico_staff on public.nexus_metas_historico for all to authenticated
  using (is_nexus_staff(auth.uid())) with check (is_nexus_staff(auth.uid()));

create or replace function public.nexus_registrar_meta() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.meta_mensal_sacas is distinct from old.meta_mensal_sacas then
    insert into public.nexus_metas_historico (user_id, meta_mensal_sacas, vigente_desde)
    values (new.user_id, new.meta_mensal_sacas, (now() at time zone 'America/Campo_Grande')::date);
  end if;
  return new;
end $$;
create trigger nexus_equipe_meta_historico after insert or update of meta_mensal_sacas on public.nexus_equipe
  for each row execute function public.nexus_registrar_meta();
-- O histórico inicial foi preenchido a partir de nexus_audit_log (mudanças de meta_mensal_sacas).
