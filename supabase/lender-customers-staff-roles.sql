-- 사채업체 이용 의뢰인 + 영업/조율 담당자 분리
-- 기존 운영 데이터는 삭제하지 않습니다.

-- 1) 고객 / 신규DB 담당자 필드 추가
alter table if exists public.customers add column if not exists sales_manager text;
alter table if exists public.customers add column if not exists coordination_manager text;

-- 마이그레이션 보정값이 기간별 변동내역에 사용자 수정으로 쌓이지 않도록 잠시 audit trigger를 끕니다.
do $$
begin
  if exists(select 1 from pg_trigger where tgname='trg_change_history_customers' and not tgisinternal) then
    execute 'alter table public.customers disable trigger trg_change_history_customers';
  end if;
end $$;

update public.customers
set sales_manager = coalesce(nullif(sales_manager,''), nullif(manager,''), '신홍규'),
    coordination_manager = coalesce(nullif(coordination_manager,''), '신홍규')
where sales_manager is null or sales_manager = '' or coordination_manager is null or coordination_manager = '';

alter table if exists public.customers alter column sales_manager set default '신홍규';
alter table if exists public.customers alter column coordination_manager set default '신홍규';

alter table if exists public.meta_leads add column if not exists sales_manager text;
alter table if exists public.meta_leads add column if not exists coordination_manager text;

do $$
begin
  if exists(select 1 from pg_trigger where tgname='trg_change_history_meta_leads' and not tgisinternal) then
    execute 'alter table public.meta_leads disable trigger trg_change_history_meta_leads';
  end if;
end $$;

-- 기존 meta_leads manager 관련 CHECK가 있으면 제거합니다.
do $$
declare r record;
begin
  if to_regclass('public.meta_leads') is not null then
    for r in
      select conname
      from pg_constraint
      where conrelid='public.meta_leads'::regclass
        and contype='c'
        and pg_get_constraintdef(oid) ilike '%manager%'
    loop
      execute format('alter table public.meta_leads drop constraint if exists %I', r.conname);
    end loop;
  end if;
end $$;

update public.meta_leads
set sales_manager = coalesce(nullif(sales_manager,''), nullif(manager,''), '신홍규'),
    coordination_manager = coalesce(nullif(coordination_manager,''), '신홍규')
where sales_manager is null or sales_manager = '' or coordination_manager is null or coordination_manager = '';

alter table if exists public.meta_leads alter column sales_manager set default '신홍규';
alter table if exists public.meta_leads alter column coordination_manager set default '신홍규';

-- 기존 change history trigger가 있었다면 다시 켭니다.
do $$
begin
  if exists(select 1 from pg_trigger where tgname='trg_change_history_customers' and not tgisinternal) then
    execute 'alter table public.customers enable trigger trg_change_history_customers';
  end if;
  if exists(select 1 from pg_trigger where tgname='trg_change_history_meta_leads' and not tgisinternal) then
    execute 'alter table public.meta_leads enable trigger trg_change_history_meta_leads';
  end if;
end $$;

-- 2) 사채업체 ↔ 이용 의뢰인 다대다 연결 테이블
create table if not exists public.lender_customers (
  id uuid primary key default gen_random_uuid(),
  lender_id uuid not null references public.lenders(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(lender_id, customer_id)
);

create index if not exists lender_customers_lender_idx on public.lender_customers(lender_id);
create index if not exists lender_customers_customer_idx on public.lender_customers(customer_id);

alter table public.lender_customers enable row level security;
drop policy if exists "lender customers authenticated select" on public.lender_customers;
drop policy if exists "lender customers authenticated insert" on public.lender_customers;
drop policy if exists "lender customers authenticated update" on public.lender_customers;
drop policy if exists "lender customers authenticated delete" on public.lender_customers;

create policy "lender customers authenticated select" on public.lender_customers for select to authenticated using (true);
create policy "lender customers authenticated insert" on public.lender_customers for insert to authenticated with check (true);
create policy "lender customers authenticated update" on public.lender_customers for update to authenticated using (true) with check (true);
create policy "lender customers authenticated delete" on public.lender_customers for delete to authenticated using (true);

grant select,insert,update,delete on public.lender_customers to authenticated;

-- 3) 기존 상환일정에서 업체-의뢰인 관계를 안전하게 복원
-- 연락정보가 실제 입력되어 있고, 기존 중복판정 규칙(업체명+연락수단+공백 제거 연락정보)이 일치하는 건만 연결합니다.
insert into public.lender_customers(lender_id, customer_id)
select distinct l.id, r.customer_id
from public.repayment_schedules r
join public.lenders l
  on trim(coalesce(l.name,'')) = trim(coalesce(r.lender_name,''))
join public.lender_contacts lc
  on lc.lender_id = l.id
 and lc.contact_type = r.lender_contact_type
 and regexp_replace(coalesce(lc.contact_value,''), '\s+', '', 'g') = regexp_replace(coalesce(r.lender_contact_value,''), '\s+', '', 'g')
where r.customer_id is not null
  and coalesce(r.deleted_at::text,'') = ''
  and coalesce(l.deleted_at::text,'') = ''
  and regexp_replace(coalesce(r.lender_contact_value,''), '\s+', '', 'g') <> ''
on conflict (lender_id, customer_id) do nothing;

-- 4) 기간별 변동내역: 영업/조율 담당자 변경도 고객관리 변경으로 기록
create or replace function public.audit_change_history_customer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_has_contract_old boolean := false;
  v_has_contract_new boolean := false;
  v_customer_changed boolean := false;
  v_contract_changed boolean := false;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    perform public.write_change_history('고객 관리','등록',tg_table_name,new.id::text,null,v_new);
    v_has_contract_new := new.contract_date is not null
      or coalesce(new.contract_amount,0) <> 0
      or coalesce(new.upfront_amount,0) <> 0
      or coalesce(new.installment_period,0) <> 0;
    if v_has_contract_new then
      perform public.write_change_history('계약 관리','등록',tg_table_name,new.id::text,null,v_new);
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    perform public.write_change_history('고객 관리','삭제',tg_table_name,old.id::text,v_old,null);
    v_has_contract_old := old.contract_date is not null
      or coalesce(old.contract_amount,0) <> 0
      or coalesce(old.upfront_amount,0) <> 0
      or coalesce(old.installment_period,0) <> 0;
    if v_has_contract_old then
      perform public.write_change_history('계약 관리','삭제',tg_table_name,old.id::text,v_old,null);
    end if;
    return old;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);

  if old.deleted_at is null and new.deleted_at is not null then
    perform public.write_change_history('고객 관리','삭제',tg_table_name,new.id::text,v_old,v_new);
    if old.contract_date is not null or coalesce(old.contract_amount,0) <> 0 then
      perform public.write_change_history('계약 관리','삭제',tg_table_name,new.id::text,v_old,v_new);
    end if;
    return new;
  end if;

  v_customer_changed :=
    old.registered_at is distinct from new.registered_at or
    old.name is distinct from new.name or
    old.phone is distinct from new.phone or
    old.address is distinct from new.address or
    old.birth_number is distinct from new.birth_number or
    old.manager is distinct from new.manager or
    old.sales_manager is distinct from new.sales_manager or
    old.coordination_manager is distinct from new.coordination_manager or
    old.memo is distinct from new.memo;

  v_contract_changed :=
    old.contract_date is distinct from new.contract_date or
    old.contract_amount is distinct from new.contract_amount or
    old.upfront_amount is distinct from new.upfront_amount or
    old.installment_period is distinct from new.installment_period or
    old.lender_unit_price is distinct from new.lender_unit_price or
    old.lender_count is distinct from new.lender_count;

  if v_customer_changed then
    perform public.write_change_history('고객 관리','수정',tg_table_name,new.id::text,v_old,v_new);
  end if;

  if v_contract_changed then
    v_has_contract_old := old.contract_date is not null
      or coalesce(old.contract_amount,0) <> 0
      or coalesce(old.upfront_amount,0) <> 0
      or coalesce(old.installment_period,0) <> 0;
    v_has_contract_new := new.contract_date is not null
      or coalesce(new.contract_amount,0) <> 0
      or coalesce(new.upfront_amount,0) <> 0
      or coalesce(new.installment_period,0) <> 0;
    if v_has_contract_old or v_has_contract_new then
      perform public.write_change_history(
        '계약 관리',
        case when not v_has_contract_old and v_has_contract_new then '등록' else '수정' end,
        tg_table_name,new.id::text,v_old,v_new
      );
    end if;
  end if;

  return new;
end;
$$;

-- 업체 이용 의뢰인 연결/해제도 사채업체 관리 변동내역으로 기록
-- change_history가 설치된 환경에서만 trigger 생성
do $$
begin
  if to_regprocedure('public.audit_change_history_generic()') is not null then
    execute 'drop trigger if exists trg_change_history_lender_customers on public.lender_customers';
    execute 'create trigger trg_change_history_lender_customers after insert or update or delete on public.lender_customers for each row execute function public.audit_change_history_generic(''사채업체 관리'')';
  end if;
end $$;
