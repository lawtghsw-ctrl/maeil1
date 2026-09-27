-- 사채업체 관리 삭제와 고객 상환일정을 완전히 분리합니다.
-- 1) 업체 삭제는 실제 DELETE 대신 deleted_at 소프트 삭제로 처리합니다.
-- 2) 과거 스키마에 repayment_schedules -> lenders FK가 남아 있다면 제거합니다.

alter table public.lenders
  add column if not exists deleted_at timestamptz;

do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    join pg_class child on child.oid = c.conrelid
    join pg_namespace n on n.oid = child.relnamespace
    join pg_class parent on parent.oid = c.confrelid
    where c.contype = 'f'
      and n.nspname = 'public'
      and child.relname = 'repayment_schedules'
      and parent.relname = 'lenders'
  loop
    execute format('alter table public.repayment_schedules drop constraint if exists %I', r.conname);
  end loop;
end $$;

-- 확인용: 아래 결과가 0행이면 repayment_schedules와 lenders 사이 FK가 없습니다.
select c.conname as remaining_fk
from pg_constraint c
join pg_class child on child.oid = c.conrelid
join pg_namespace n on n.oid = child.relnamespace
join pg_class parent on parent.oid = c.confrelid
where c.contype = 'f'
  and n.nspname = 'public'
  and child.relname = 'repayment_schedules'
  and parent.relname = 'lenders';
