-- 추가 계약 / 환수 등록 / 상환 '종결' 상태 지원
-- 기존 운영 데이터는 삭제하지 않습니다.

begin;

-- 1) 상환일정: '종결' 상태 허용
alter table public.repayment_schedules drop constraint if exists repayment_schedules_status_check;
alter table public.repayment_schedules add constraint repayment_schedules_status_check
check (status in ('예정','상환완료','완료','연체','보류','종결'));

-- 종결 건은 금액이 항상 0원이 되도록 DB에서도 보호
create or replace function public.force_closed_repayment_zero()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  if new.status = '종결' then
    new.repayment_amount := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_force_closed_repayment_zero on public.repayment_schedules;
create trigger trg_force_closed_repayment_zero
before insert or update on public.repayment_schedules
for each row execute function public.force_closed_repayment_zero();

-- 2) 추가 계약
create table if not exists public.additional_contracts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  contract_date date,
  contract_amount numeric not null default 0,
  upfront_amount numeric not null default 0,
  installment_period integer not null default 0,
  lender_unit_price numeric not null default 0,
  lender_count integer not null default 0,
  memo text not null default '',
  admin_created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists additional_contracts_customer_idx on public.additional_contracts(customer_id, admin_created_at desc);

alter table public.additional_contracts enable row level security;
drop policy if exists "additional contracts authenticated select" on public.additional_contracts;
drop policy if exists "additional contracts authenticated insert" on public.additional_contracts;
drop policy if exists "additional contracts authenticated update" on public.additional_contracts;
drop policy if exists "additional contracts authenticated delete" on public.additional_contracts;
create policy "additional contracts authenticated select" on public.additional_contracts for select to authenticated using (true);
create policy "additional contracts authenticated insert" on public.additional_contracts for insert to authenticated with check (true);
create policy "additional contracts authenticated update" on public.additional_contracts for update to authenticated using (true) with check (true);
create policy "additional contracts authenticated delete" on public.additional_contracts for delete to authenticated using (true);
grant select,insert,update,delete on public.additional_contracts to authenticated;

-- 3) 환수 등록
create table if not exists public.recoveries (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  recovery_date date,
  lender_name text not null default '',
  recovery_type text not null default '',
  amount numeric not null default 0,
  payment_method text not null default '계좌이체',
  memo text not null default '',
  admin_created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists recoveries_customer_idx on public.recoveries(customer_id, admin_created_at desc);
create index if not exists recoveries_date_idx on public.recoveries(recovery_date desc, admin_created_at desc);

alter table public.recoveries enable row level security;
drop policy if exists "recoveries authenticated select" on public.recoveries;
drop policy if exists "recoveries authenticated insert" on public.recoveries;
drop policy if exists "recoveries authenticated update" on public.recoveries;
drop policy if exists "recoveries authenticated delete" on public.recoveries;
create policy "recoveries authenticated select" on public.recoveries for select to authenticated using (true);
create policy "recoveries authenticated insert" on public.recoveries for insert to authenticated with check (true);
create policy "recoveries authenticated update" on public.recoveries for update to authenticated using (true) with check (true);
create policy "recoveries authenticated delete" on public.recoveries for delete to authenticated using (true);
grant select,insert,update,delete on public.recoveries to authenticated;

-- 4) 입금/분납 일정에 원본 연결값 추가
alter table public.payment_schedules add column if not exists source_additional_contract_id uuid;
alter table public.payment_schedules add column if not exists source_recovery_id uuid;

alter table public.payment_schedules drop constraint if exists payment_schedules_schedule_type_check;
alter table public.payment_schedules add constraint payment_schedules_schedule_type_check
check (schedule_type in ('일반','재약정','추가계약','환수'));

create unique index if not exists payment_schedules_additional_contract_unique_idx
on public.payment_schedules(source_additional_contract_id)
where source_additional_contract_id is not null and deleted_at is null;
create unique index if not exists payment_schedules_recovery_unique_idx
on public.payment_schedules(source_recovery_id)
where source_recovery_id is not null and deleted_at is null;

-- 5) 추가계약 선납금 -> 입금/분납 자동연동
create or replace function public.sync_additional_contract_payment()
returns trigger
language plpgsql
set search_path=public
as $$
declare
  v_payment_id uuid;
begin
  select id into v_payment_id
  from public.payment_schedules
  where source_additional_contract_id = new.id
  order by admin_created_at desc nulls last
  limit 1;

  if new.deleted_at is not null or coalesce(new.upfront_amount,0) <= 0 then
    if v_payment_id is not null then
      update public.payment_schedules
      set deleted_at=coalesce(deleted_at,now())
      where id=v_payment_id;
    end if;
    return new;
  end if;

  if v_payment_id is null then
    insert into public.payment_schedules(
      customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,
      schedule_type,reschedule_sequence,source_additional_contract_id
    ) values (
      new.customer_id,new.contract_date,new.upfront_amount,new.contract_date,new.upfront_amount,'완료','계좌이체',
      '추가 계약 선납금 자동 반영','추가계약',0,new.id
    );
  else
    update public.payment_schedules
    set customer_id=new.customer_id,
        due_date=new.contract_date,
        expected_amount=new.upfront_amount,
        paid_date=new.contract_date,
        paid_amount=new.upfront_amount,
        status='완료',
        memo='추가 계약 선납금 자동 반영',
        schedule_type='추가계약',
        deleted_at=null
    where id=v_payment_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_additional_contract_payment on public.additional_contracts;
create trigger trg_sync_additional_contract_payment
after insert or update on public.additional_contracts
for each row execute function public.sync_additional_contract_payment();

-- 6) 환수 -> 입금/분납 자동연동
create or replace function public.sync_recovery_payment()
returns trigger
language plpgsql
set search_path=public
as $$
declare
  v_payment_id uuid;
  v_memo text;
begin
  select id into v_payment_id
  from public.payment_schedules
  where source_recovery_id = new.id
  order by admin_created_at desc nulls last
  limit 1;

  if new.deleted_at is not null then
    if v_payment_id is not null then
      update public.payment_schedules set deleted_at=coalesce(deleted_at,now()) where id=v_payment_id;
    end if;
    return new;
  end if;

  v_memo := '[환수] ' || coalesce(nullif(new.lender_name,''),'업체 미지정')
    || case when coalesce(new.recovery_type,'')<>'' then ' · '||new.recovery_type else '' end
    || case when coalesce(new.memo,'')<>'' then ' · '||new.memo else '' end;

  if v_payment_id is null then
    insert into public.payment_schedules(
      customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,
      schedule_type,reschedule_sequence,source_recovery_id
    ) values (
      new.customer_id,new.recovery_date,new.amount,new.recovery_date,new.amount,'완료',new.payment_method,v_memo,
      '환수',0,new.id
    );
  else
    update public.payment_schedules
    set customer_id=new.customer_id,
        due_date=new.recovery_date,
        expected_amount=new.amount,
        paid_date=new.recovery_date,
        paid_amount=new.amount,
        status='완료',
        payment_method=new.payment_method,
        memo=v_memo,
        schedule_type='환수',
        deleted_at=null
    where id=v_payment_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_recovery_payment on public.recoveries;
create trigger trg_sync_recovery_payment
after insert or update on public.recoveries
for each row execute function public.sync_recovery_payment();

-- 7) updated_at 자동 갱신
create or replace function public.touch_admin_updated_at()
returns trigger language plpgsql set search_path=public as $$
begin new.updated_at=now(); return new; end; $$;
drop trigger if exists trg_touch_additional_contracts on public.additional_contracts;
create trigger trg_touch_additional_contracts before update on public.additional_contracts for each row execute function public.touch_admin_updated_at();
drop trigger if exists trg_touch_recoveries on public.recoveries;
create trigger trg_touch_recoveries before update on public.recoveries for each row execute function public.touch_admin_updated_at();

-- 8) 기간별 변동내역 연동 (기존 audit 함수가 있을 때만)
do $$
begin
  if to_regprocedure('public.audit_change_history_generic()') is not null then
    execute 'drop trigger if exists trg_change_history_additional_contracts on public.additional_contracts';
    execute 'create trigger trg_change_history_additional_contracts after insert or update or delete on public.additional_contracts for each row execute function public.audit_change_history_generic(''계약 관리'')';
    -- 환수는 payment_schedules의 자동연동 행이 입금/분납 이력을 남기므로 중복 로그를 만들지 않습니다.
    execute 'drop trigger if exists trg_change_history_recoveries on public.recoveries';
  end if;
end $$;

commit;
