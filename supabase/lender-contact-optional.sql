-- 사채업체 연락수단을 선택하고 연락정보를 비워도 저장 가능하도록 완화

alter table if exists public.lender_contacts
  alter column contact_value drop not null;

-- 과거에 연락정보 공백을 막는 CHECK 제약조건이 있다면 제거합니다.
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'lender_contacts'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%contact_value%'
  loop
    execute format('alter table public.lender_contacts drop constraint if exists %I', r.conname);
  end loop;
end $$;
