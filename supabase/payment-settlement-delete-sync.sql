-- 입금/분납 완료 -> 로펌 정산표 자동연동 + 연결 데이터 삭제 동기화
-- 기존 완료 입금건은 자동 백필하지 않습니다. 이 SQL 실행 이후 새로 완료되는 건부터 자동연동됩니다.
-- 고객/입금/상환/추가계약/환수의 기존 운영 데이터는 유지합니다.

begin;

-- 1) 정산표에 자동연동 원본 식별 컬럼 추가
alter table public.settlement_entries add column if not exists customer_id uuid;
alter table public.settlement_entries add column if not exists source_payment_schedule_id uuid;
alter table public.settlement_entries add column if not exists entry_source text not null default 'manual';
alter table public.settlement_entries add column if not exists entry_type text not null default '계약';
alter table public.settlement_entries add column if not exists deleted_at timestamptz;

alter table public.settlement_entries drop constraint if exists settlement_entries_entry_source_check;
alter table public.settlement_entries add constraint settlement_entries_entry_source_check
check (entry_source in ('manual','payment'));

alter table public.settlement_entries drop constraint if exists settlement_entries_entry_type_check;
alter table public.settlement_entries add constraint settlement_entries_entry_type_check
check (entry_type in ('계약','환수'));

create unique index if not exists settlement_entries_source_payment_unique_idx
on public.settlement_entries(source_payment_schedule_id)
where source_payment_schedule_id is not null;

create index if not exists settlement_entries_customer_idx
on public.settlement_entries(customer_id, payment_date desc, admin_created_at desc);

-- 2) 완료 입금건을 로펌 정산표로 자동 연동
create or replace function public.sync_payment_schedule_to_settlement()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_payment_id uuid;
  v_customer_id uuid;
  v_customer_name text;
  v_status text;
  v_paid_date date;
  v_paid_amount numeric;
  v_payment_method text;
  v_schedule_type text;
  v_payment_memo text;
  v_deleted_at timestamptz;
  v_settlement_id uuid;
  v_should_create boolean := false;
  v_type text;
  v_memo text;
begin
  if tg_op = 'DELETE' then
    v_payment_id := old.id;
    update public.settlement_entries
       set deleted_at = coalesce(deleted_at, now())
     where source_payment_schedule_id = v_payment_id
       and deleted_at is null;
    return old;
  end if;

  v_payment_id := new.id;
  v_customer_id := new.customer_id;
  v_status := coalesce(new.status,'');
  v_paid_date := new.paid_date;
  v_paid_amount := coalesce(new.paid_amount,0);
  v_payment_method := coalesce(nullif(new.payment_method,''),'계좌이체');
  v_schedule_type := coalesce(nullif(new.schedule_type,''),'일반');
  v_payment_memo := coalesce(new.memo,'');
  v_deleted_at := new.deleted_at;

  select id into v_settlement_id
    from public.settlement_entries
   where source_payment_schedule_id = v_payment_id
   limit 1;

  -- 기존 자동연동 행이 있으면 완료건의 수정도 그대로 동기화합니다.
  if v_settlement_id is not null then
    if v_deleted_at is not null or v_status <> '완료' or v_paid_date is null or v_paid_amount <= 0 then
      update public.settlement_entries
         set deleted_at = coalesce(deleted_at, now())
       where id = v_settlement_id;
      return new;
    end if;
    v_should_create := true;
  else
    -- 기존 완료 데이터 전체를 갑자기 정산표에 넣지 않도록,
    -- 신규 완료 INSERT 또는 '완료가 아닌 상태 -> 완료' 전환일 때만 최초 생성합니다.
    if tg_op = 'INSERT' then
      v_should_create := v_deleted_at is null and v_status='완료' and v_paid_date is not null and v_paid_amount>0;
    elsif tg_op = 'UPDATE' then
      v_should_create := old.status is distinct from '완료'
        and v_deleted_at is null and v_status='완료' and v_paid_date is not null and v_paid_amount>0;
    end if;
  end if;

  if not v_should_create then
    return new;
  end if;

  select name into v_customer_name
    from public.customers
   where id = v_customer_id
   limit 1;

  v_type := case when v_schedule_type='환수' then '환수' else '계약' end;
  v_memo := '[입금/분납 자동연동]'
    || case when v_schedule_type='재약정' then ' 재약정'
            when v_schedule_type='추가계약' then ' 추가계약 선납'
            when v_schedule_type='환수' then ' 환수'
            else ' 계약 입금' end
    || case when v_payment_memo<>'' then ' · '||v_payment_memo else '' end;

  if v_settlement_id is null then
    insert into public.settlement_entries(
      payment_date, client_name, amount, payment_method, memo,
      customer_id, source_payment_schedule_id, entry_source, entry_type, deleted_at
    ) values (
      v_paid_date, coalesce(v_customer_name,''), v_paid_amount, v_payment_method, v_memo,
      v_customer_id, v_payment_id, 'payment', v_type, null
    );
  else
    update public.settlement_entries
       set payment_date = v_paid_date,
           client_name = coalesce(v_customer_name,''),
           amount = v_paid_amount,
           payment_method = v_payment_method,
           memo = v_memo,
           customer_id = v_customer_id,
           entry_source = 'payment',
           entry_type = v_type,
           deleted_at = null
     where id = v_settlement_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_payment_schedule_to_settlement on public.payment_schedules;
create trigger trg_sync_payment_schedule_to_settlement
after insert or update or delete on public.payment_schedules
for each row execute function public.sync_payment_schedule_to_settlement();

-- 3) 고객 이름 변경 시 자동 정산표 고객명도 같이 갱신
create or replace function public.sync_customer_name_to_settlement()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  if old.name is distinct from new.name then
    update public.settlement_entries
       set client_name = coalesce(new.name,'')
     where customer_id = new.id
       and entry_source = 'payment';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_customer_name_to_settlement on public.customers;
create trigger trg_sync_customer_name_to_settlement
after update of name on public.customers
for each row execute function public.sync_customer_name_to_settlement();

-- 4) 고객 삭제(soft delete) 시 연결 업무데이터도 같은 시점에 숨김/삭제 처리
create or replace function public.cascade_customer_soft_delete()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.payment_schedules
       set deleted_at = coalesce(deleted_at, new.deleted_at)
     where customer_id = new.id and deleted_at is null;

    update public.repayment_schedules
       set deleted_at = coalesce(deleted_at, new.deleted_at)
     where customer_id = new.id and deleted_at is null;

    if to_regclass('public.additional_contracts') is not null then
      update public.additional_contracts
         set deleted_at = coalesce(deleted_at, new.deleted_at)
       where customer_id = new.id and deleted_at is null;
    end if;

    if to_regclass('public.recoveries') is not null then
      update public.recoveries
         set deleted_at = coalesce(deleted_at, new.deleted_at)
       where customer_id = new.id and deleted_at is null;
    end if;

    update public.settlement_entries
       set deleted_at = coalesce(deleted_at, new.deleted_at)
     where customer_id = new.id and deleted_at is null;

    if to_regclass('public.lender_customers') is not null then
      delete from public.lender_customers where customer_id = new.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cascade_customer_soft_delete on public.customers;
create trigger trg_cascade_customer_soft_delete
after update of deleted_at on public.customers
for each row execute function public.cascade_customer_soft_delete();

commit;
