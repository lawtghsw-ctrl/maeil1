-- 고객 사고자 표시 기능
-- 기존 고객/입금/상환/정산 데이터는 삭제하거나 초기화하지 않습니다.
-- 사고자 계약금액은 기존 계약 원본을 덮어쓰지 않고 별도 조정값으로 보존합니다.

begin;

alter table public.customers
  add column if not exists is_accident boolean not null default false;

alter table public.customers
  add column if not exists accident_contract_amount numeric;

alter table public.customers
  add column if not exists accident_marked_at timestamptz;

create index if not exists customers_is_accident_idx
  on public.customers (is_accident)
  where deleted_at is null;

commit;
