-- 기간별 변동내역
-- 1) 아래 SQL 전체를 Supabase SQL Editor에서 1회 실행하세요.
-- 2) 앞으로의 등록/수정/삭제는 DB trigger가 실제 저장 시각으로 자동 기록합니다.
-- 3) 이 SQL을 실행한 시점 이전의 변동내역은 모두 초기화하고, 실행 이후 발생하는 실제 변경만 기록합니다.

create table if not exists public.change_history (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  category text not null,
  action text not null check (action in ('등록','수정','삭제')),
  table_name text not null,
  record_id text not null,
  actor_id uuid null,
  actor_name text null,
  source text not null default 'live',
  old_data jsonb null,
  new_data jsonb null,
  dedupe_key text null unique,
  created_at timestamptz not null default now()
);

create index if not exists change_history_occurred_at_idx on public.change_history (occurred_at desc);
create index if not exists change_history_category_occurred_at_idx on public.change_history (category, occurred_at desc);

alter table public.change_history enable row level security;
drop policy if exists "change history authenticated select" on public.change_history;
create policy "change history authenticated select"
on public.change_history for select to authenticated
using (true);

grant select on public.change_history to authenticated;
revoke insert, update, delete on public.change_history from authenticated;

create or replace function public.write_change_history(
  p_category text,
  p_action text,
  p_table_name text,
  p_record_id text,
  p_old_data jsonb,
  p_new_data jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_actor_name text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is not null then
    select p.name into v_actor_name
    from public.profiles p
    where p.id = v_actor_id
    limit 1;
  end if;

  insert into public.change_history(
    occurred_at, category, action, table_name, record_id,
    actor_id, actor_name, source, old_data, new_data
  ) values (
    now(), p_category, p_action, p_table_name, coalesce(p_record_id,''),
    v_actor_id, coalesce(v_actor_name, case when v_actor_id is null then '시스템' else '사용자' end),
    'live', p_old_data, p_new_data
  );
end;
$$;

create or replace function public.audit_change_history_generic()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_action text;
  v_record_id text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_action := '등록';
    v_record_id := coalesce(v_new->>'id','');
    perform public.write_change_history(tg_argv[0], v_action, tg_table_name, v_record_id, null, v_new);
    return new;
  elsif tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_action := '삭제';
    v_record_id := coalesce(v_old->>'id','');
    perform public.write_change_history(tg_argv[0], v_action, tg_table_name, v_record_id, v_old, null);
    return old;
  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_record_id := coalesce(v_new->>'id',v_old->>'id','');
    if coalesce(v_old->>'deleted_at','') = '' and coalesce(v_new->>'deleted_at','') <> '' then
      v_action := '삭제';
    else
      v_action := '수정';
    end if;
    perform public.write_change_history(tg_argv[0], v_action, tg_table_name, v_record_id, v_old, v_new);
    return new;
  end if;
end;
$$;

-- customers 한 테이블에서 고객관리/계약관리 이력을 분리합니다.
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

  -- soft delete
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

-- Trigger 연결. 해당 테이블이 존재하는 경우에만 생성합니다.
do $$
begin
  if to_regclass('public.customers') is not null then
    execute 'drop trigger if exists trg_change_history_customers on public.customers';
    execute 'create trigger trg_change_history_customers after insert or update or delete on public.customers for each row execute function public.audit_change_history_customer()';
  end if;
  if to_regclass('public.payment_schedules') is not null then
    execute 'drop trigger if exists trg_change_history_payments on public.payment_schedules';
    execute 'create trigger trg_change_history_payments after insert or update or delete on public.payment_schedules for each row execute function public.audit_change_history_generic(''입금/분납 관리'')';
  end if;
  if to_regclass('public.repayment_schedules') is not null then
    execute 'drop trigger if exists trg_change_history_repayments on public.repayment_schedules';
    execute 'create trigger trg_change_history_repayments after insert or update or delete on public.repayment_schedules for each row execute function public.audit_change_history_generic(''상환 일정 관리'')';
  end if;
  if to_regclass('public.lenders') is not null then
    execute 'drop trigger if exists trg_change_history_lenders on public.lenders';
    execute 'create trigger trg_change_history_lenders after insert or update or delete on public.lenders for each row execute function public.audit_change_history_generic(''사채업체 관리'')';
  end if;
  if to_regclass('public.settlement_entries') is not null then
    execute 'drop trigger if exists trg_change_history_settlements on public.settlement_entries';
    execute 'create trigger trg_change_history_settlements after insert or update or delete on public.settlement_entries for each row execute function public.audit_change_history_generic(''정산'')';
  end if;
  if to_regclass('public.board_posts') is not null then
    execute 'drop trigger if exists trg_change_history_board on public.board_posts';
    execute 'create trigger trg_change_history_board after insert or update or delete on public.board_posts for each row execute function public.audit_change_history_generic(''내부 게시판'')';
  end if;
  if to_regclass('public.meta_leads') is not null then
    execute 'drop trigger if exists trg_change_history_meta_leads on public.meta_leads';
    execute 'create trigger trg_change_history_meta_leads after insert or update or delete on public.meta_leads for each row execute function public.audit_change_history_generic(''신규 DB'')';
  end if;
end $$;

-- 변동내역 초기화
-- 사용자의 명시적 요청에 따라 change_history 로그만 삭제합니다.
-- customers / payment_schedules / repayment_schedules / lenders 등 실제 운영 데이터는 건드리지 않습니다.
-- 이 DELETE가 실행된 시점부터 새로 발생하는 등록/수정/삭제만 trigger로 기록됩니다.
delete from public.change_history;
