-- 고객 조율 계산기 v2: 원금/기상환금액 기반 전사 공통 가이드
-- 기존 계산 이력과 고객/계약/입금/상환 데이터는 삭제하지 않습니다.
-- v1 SQL을 이미 실행한 프로젝트에서 1회 실행하세요.

begin;

-- 1) 전사 공통 가이드: 기간 + 연락수단별 공식에 필요한 값
alter table public.negotiation_guidelines
  add column if not exists default_period text,
  add column if not exists fixed_extra_amount numeric,
  add column if not exists principal_add_rate numeric;

update public.negotiation_guidelines
set default_period = coalesce(default_period, '1주'),
    fixed_extra_amount = coalesce(fixed_extra_amount, case when contact_type='번호' then 100000 else 0 end),
    principal_add_rate = coalesce(principal_add_rate, case when contact_type='번호' then 0 else 50 end)
where default_period is null
   or fixed_extra_amount is null
   or principal_add_rate is null;

alter table public.negotiation_guidelines
  alter column default_period set default '1주',
  alter column default_period set not null,
  alter column fixed_extra_amount set default 0,
  alter column fixed_extra_amount set not null,
  alter column principal_add_rate set default 0,
  alter column principal_add_rate set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_default_period_check') then
    alter table public.negotiation_guidelines
      add constraint negotiation_guidelines_default_period_check
      check (default_period in ('1주','2주','3주','4주','2달'));
  end if;
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_fixed_extra_amount_check') then
    alter table public.negotiation_guidelines
      add constraint negotiation_guidelines_fixed_extra_amount_check
      check (fixed_extra_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_principal_add_rate_check') then
    alter table public.negotiation_guidelines
      add constraint negotiation_guidelines_principal_add_rate_check
      check (principal_add_rate >= 0);
  end if;
end $$;

-- 최초 기본값. 기존 v2 값이 아직 없는 행만 위 update에서 채워지므로,
-- 이후 화면에서 수정한 전사 공통값을 이 SQL이 반복 덮어쓰지 않습니다.
insert into public.negotiation_guidelines(contact_type,default_period,fixed_extra_amount,principal_add_rate)
values
 ('번호','1주',100000,0),
 ('텔레그램','1주',0,50),
 ('카카오톡','1주',0,50),
 ('라인','1주',0,50)
on conflict (contact_type) do nothing;

-- 2) 업체별 계산에 필요한 실제 입력값
alter table public.customer_calculator_items
  add column if not exists cumulative_principal numeric,
  add column if not exists last_principal numeric,
  add column if not exists repaid_amount numeric,
  add column if not exists selected_period text;

update public.customer_calculator_items
set cumulative_principal = coalesce(cumulative_principal,0),
    last_principal = coalesce(last_principal,0),
    repaid_amount = coalesce(repaid_amount,0)
where cumulative_principal is null
   or last_principal is null
   or repaid_amount is null;

alter table public.customer_calculator_items
  alter column cumulative_principal set default 0,
  alter column cumulative_principal set not null,
  alter column last_principal set default 0,
  alter column last_principal set not null,
  alter column repaid_amount set default 0,
  alter column repaid_amount set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='customer_calculator_items_cumulative_principal_check') then
    alter table public.customer_calculator_items add constraint customer_calculator_items_cumulative_principal_check check (cumulative_principal >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='customer_calculator_items_last_principal_check') then
    alter table public.customer_calculator_items add constraint customer_calculator_items_last_principal_check check (last_principal >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='customer_calculator_items_repaid_amount_check') then
    alter table public.customer_calculator_items add constraint customer_calculator_items_repaid_amount_check check (repaid_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='customer_calculator_items_selected_period_check') then
    alter table public.customer_calculator_items add constraint customer_calculator_items_selected_period_check check (selected_period is null or selected_period in ('1주','2주','3주','4주','2달'));
  end if;
end $$;

-- 3) 기본값은 위 컬럼 최초 생성 시에만 채워지며, 이후 사용자가 수정한 공통값은 보존됩니다.

commit;
