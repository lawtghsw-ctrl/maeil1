-- 고객 맞춤형 조율·경제효과 계산기
-- 기존 고객/계약/입금/상환 데이터는 삭제하거나 변경하지 않습니다.

begin;

-- 1) 연락수단별 공통 조율 가이드라인
create table if not exists public.negotiation_guidelines (
  id uuid primary key default gen_random_uuid(),
  contact_type text not null unique,
  default_period text not null default '1주' check (default_period in ('1주','2주','3주','4주','2달')),
  fixed_extra_amount numeric not null default 0 check (fixed_extra_amount >= 0),
  principal_add_rate numeric not null default 0 check (principal_add_rate >= 0),
  min_days integer not null default 0 check (min_days >= 0),
  standard_days integer not null default 0 check (standard_days >= 0),
  max_days integer not null default 0 check (max_days >= 0),
  min_reduction_rate numeric not null default 0 check (min_reduction_rate >= 0 and min_reduction_rate <= 100),
  standard_reduction_rate numeric not null default 0 check (standard_reduction_rate >= 0 and standard_reduction_rate <= 100),
  max_reduction_rate numeric not null default 0 check (max_reduction_rate >= 0 and max_reduction_rate <= 100),
  memo text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 기본 가이드 공식
insert into public.negotiation_guidelines(contact_type,default_period,fixed_extra_amount,principal_add_rate)
values ('번호','1주',100000,0),('텔레그램','1주',0,50),('카카오톡','1주',0,50),('라인','1주',0,50)
on conflict (contact_type) do nothing;

-- 2) 고객별/상환업체별 계산기 실무 입력값
create table if not exists public.customer_calculator_items (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  repayment_schedule_id uuid not null references public.repayment_schedules(id) on delete cascade,
  cumulative_principal numeric not null default 0 check (cumulative_principal >= 0),
  last_principal numeric not null default 0 check (last_principal >= 0),
  repaid_amount numeric not null default 0 check (repaid_amount >= 0),
  selected_period text check (selected_period is null or selected_period in ('1주','2주','3주','4주','2달')),
  extension_fee numeric not null default 0 check (extension_fee >= 0),
  extension_cycle_days integer not null default 0 check (extension_cycle_days >= 0),
  expected_extension_count integer not null default 0 check (expected_extension_count >= 0),
  target_amount numeric check (target_amount is null or target_amount >= 0),
  target_days integer check (target_days is null or target_days >= 0),
  memo text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(customer_id, repayment_schedule_id)
);
create index if not exists customer_calculator_items_customer_idx
  on public.customer_calculator_items(customer_id, updated_at desc);

-- 3) 계산 결과 Snapshot 이력
create table if not exists public.customer_calculation_snapshots (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  scenario text not null default 'standard' check (scenario in ('conservative','standard','favorable')),
  total_contract_fee numeric not null default 0,
  current_repayment_amount numeric not null default 0,
  expected_negotiated_amount numeric not null default 0,
  reduction_benefit numeric not null default 0,
  extension_savings numeric not null default 0,
  total_economic_benefit numeric not null default 0,
  net_economic_benefit numeric not null default 0,
  benefit_multiple numeric not null default 0,
  snapshot_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists customer_calculation_snapshots_customer_idx
  on public.customer_calculation_snapshots(customer_id, created_at desc);

-- 4) updated_at 자동 갱신
create or replace function public.touch_customer_calculator_updated_at()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_negotiation_guidelines on public.negotiation_guidelines;
create trigger trg_touch_negotiation_guidelines
before update on public.negotiation_guidelines
for each row execute function public.touch_customer_calculator_updated_at();

drop trigger if exists trg_touch_customer_calculator_items on public.customer_calculator_items;
create trigger trg_touch_customer_calculator_items
before update on public.customer_calculator_items
for each row execute function public.touch_customer_calculator_updated_at();

-- 5) RLS / authenticated 권한
alter table public.negotiation_guidelines enable row level security;
alter table public.customer_calculator_items enable row level security;
alter table public.customer_calculation_snapshots enable row level security;

drop policy if exists "negotiation guidelines authenticated select" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines authenticated insert" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines authenticated update" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines authenticated delete" on public.negotiation_guidelines;
create policy "negotiation guidelines authenticated select" on public.negotiation_guidelines for select to authenticated using (true);
create policy "negotiation guidelines authenticated insert" on public.negotiation_guidelines for insert to authenticated with check (true);
create policy "negotiation guidelines authenticated update" on public.negotiation_guidelines for update to authenticated using (true) with check (true);
create policy "negotiation guidelines authenticated delete" on public.negotiation_guidelines for delete to authenticated using (true);

drop policy if exists "customer calculator authenticated select" on public.customer_calculator_items;
drop policy if exists "customer calculator authenticated insert" on public.customer_calculator_items;
drop policy if exists "customer calculator authenticated update" on public.customer_calculator_items;
drop policy if exists "customer calculator authenticated delete" on public.customer_calculator_items;
create policy "customer calculator authenticated select" on public.customer_calculator_items for select to authenticated using (true);
create policy "customer calculator authenticated insert" on public.customer_calculator_items for insert to authenticated with check (true);
create policy "customer calculator authenticated update" on public.customer_calculator_items for update to authenticated using (true) with check (true);
create policy "customer calculator authenticated delete" on public.customer_calculator_items for delete to authenticated using (true);

drop policy if exists "customer calculation snapshots authenticated select" on public.customer_calculation_snapshots;
drop policy if exists "customer calculation snapshots authenticated insert" on public.customer_calculation_snapshots;
drop policy if exists "customer calculation snapshots authenticated update" on public.customer_calculation_snapshots;
drop policy if exists "customer calculation snapshots authenticated delete" on public.customer_calculation_snapshots;
create policy "customer calculation snapshots authenticated select" on public.customer_calculation_snapshots for select to authenticated using (true);
create policy "customer calculation snapshots authenticated insert" on public.customer_calculation_snapshots for insert to authenticated with check (true);
create policy "customer calculation snapshots authenticated update" on public.customer_calculation_snapshots for update to authenticated using (true) with check (true);
create policy "customer calculation snapshots authenticated delete" on public.customer_calculation_snapshots for delete to authenticated using (true);

grant select,insert,update,delete on public.negotiation_guidelines to authenticated;
grant select,insert,update,delete on public.customer_calculator_items to authenticated;
grant select,insert,update,delete on public.customer_calculation_snapshots to authenticated;

commit;
