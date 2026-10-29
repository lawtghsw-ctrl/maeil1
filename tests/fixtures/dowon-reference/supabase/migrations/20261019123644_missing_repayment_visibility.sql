-- Store only the visibility preference; customer and financial records stay intact.
begin;
set local lock_timeout = '5s';

alter table public.customers
  add column if not exists hide_missing_repayment boolean not null default false;

comment on column public.customers.hide_missing_repayment is
  'true이면 업체수 대비 상환일정 수가 부족해도 상환일정 미등록 경고 목록에서 제외';

notify pgrst, 'reload schema';
commit;
