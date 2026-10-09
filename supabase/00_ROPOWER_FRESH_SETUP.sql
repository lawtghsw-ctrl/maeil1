-- ============================================================================
-- 로파워 Admin 신규 Supabase 프로젝트 전체 설치 SQL
-- 용도: 협업 로펌용 '완전히 새로운' Supabase 프로젝트 1회 초기 구축
-- 주의: 기존 도원/태광 운영 Supabase에는 실행하지 마세요.
-- 데이터 복사가 아니라 빈 신규 DB 스키마를 만드는 스크립트입니다.
-- 기본 담당/조율 직원: 신홍규, 이중호 (앱 드롭다운은 두 명 모두 표시)
-- ============================================================================

begin;
create extension if not exists pgcrypto;

-- 0) 로그인 사용자 프로필
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'STAFF',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "profiles authenticated select" on public.profiles;
drop policy if exists "profiles own update" on public.profiles;
create policy "profiles authenticated select" on public.profiles for select to authenticated using (true);
create policy "profiles own update" on public.profiles for update to authenticated using (auth.uid()=id) with check (auth.uid()=id);
grant select,update on public.profiles to authenticated;

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id,name,role)
  values(new.id,coalesce(new.raw_user_meta_data->>'name',split_part(coalesce(new.email,''),'@',1),'사용자'),'STAFF')
  on conflict(id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created_ropower on auth.users;
create trigger on_auth_user_created_ropower
after insert on auth.users for each row execute function public.handle_new_auth_user();

-- 1) 고객
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  registered_at date,
  admin_created_at timestamptz not null default now(),
  name text,
  phone text,
  address text,
  birth_number text,
  manager text not null default '신홍규',
  sales_manager text not null default '신홍규',
  coordination_manager text not null default '신홍규',
  memo text not null default '',
  contract_date date,
  contract_amount numeric not null default 0,
  upfront_amount numeric not null default 0,
  installment_period integer not null default 0,
  lender_unit_price numeric not null default 0,
  lender_count integer not null default 0,
  is_accident boolean not null default false,
  accident_contract_amount numeric,
  accident_marked_at timestamptz,
  eformsign_document_id text,
  eformsign_status text,
  eformsign_updated_at timestamptz,
  deleted_at timestamptz
);
create index if not exists customers_admin_created_at_idx on public.customers(admin_created_at desc,id desc);
create index if not exists customers_phone_idx on public.customers(phone);
create index if not exists customers_name_idx on public.customers(name);
create index if not exists customers_is_accident_idx on public.customers(is_accident) where deleted_at is null;

-- 2) 입금/분납 일정
create table if not exists public.payment_schedules (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  due_date date,
  expected_amount numeric not null default 0,
  paid_date date,
  paid_amount numeric not null default 0,
  status text not null default '예정' check(status in ('예정','완료','연체','미납','환불')),
  payment_method text,
  memo text not null default '',
  schedule_type text not null default '일반',
  root_schedule_id uuid,
  rescheduled_from_id uuid,
  reschedule_sequence integer not null default 0,
  source_additional_contract_id uuid,
  source_recovery_id uuid,
  admin_created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists payment_schedules_customer_idx on public.payment_schedules(customer_id,due_date desc);

-- 3) 업체 상환 일정
create table if not exists public.repayment_schedules (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  lender_name text,
  lender_contact_type text,
  lender_contact_value text,
  repayment_date date,
  repayment_amount numeric not null default 0,
  account_info text not null default '',
  status text not null default '예정' check(status in ('예정','완료','상환완료','연체','보류','추심','종결')),
  memo text not null default '',
  admin_created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists repayment_schedules_customer_idx on public.repayment_schedules(customer_id,repayment_date desc);

-- 4) 사채업체 / 연락정보
create table if not exists public.lenders (
  id uuid primary key default gen_random_uuid(),
  created_at date default current_date,
  admin_created_at timestamptz not null default now(),
  name text not null default '',
  account_info text,
  memo text not null default '',
  deleted_at timestamptz
);
create table if not exists public.lender_contacts (
  id uuid primary key default gen_random_uuid(),
  lender_id uuid not null references public.lenders(id) on delete cascade,
  contact_type text not null default '',
  contact_value text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists lender_contacts_lender_idx on public.lender_contacts(lender_id,sort_order);

-- 5) 내부 게시판
create table if not exists public.board_posts (
  id uuid primary key default gen_random_uuid(),
  title text,
  body text,
  author text not null default '',
  post_date date default current_date,
  is_notice boolean not null default false,
  notice_order integer not null default 1,
  admin_created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists public.board_attachments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.board_posts(id) on delete cascade,
  file_name text not null default '',
  storage_path text not null default '',
  file_size bigint not null default 0,
  mime_type text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists board_attachments_post_idx on public.board_attachments(post_id,created_at);

-- 6) 정산
create table if not exists public.settlement_entries (
  id uuid primary key default gen_random_uuid(),
  payment_date date,
  client_name text,
  amount numeric not null default 0,
  payment_method text not null default '계좌이체',
  memo text not null default '',
  customer_id uuid references public.customers(id) on delete set null,
  source_payment_schedule_id uuid,
  entry_source text not null default 'manual',
  entry_type text not null default '계약',
  admin_created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists settlement_entries_date_idx on public.settlement_entries(payment_date desc,admin_created_at desc);

-- 7) 기본 RLS: 로그인 사용자만 내부 운영 데이터 CRUD
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers','payment_schedules','repayment_schedules','lenders','lender_contacts','board_posts','board_attachments','settlement_entries']
  LOOP
    EXECUTE format('alter table public.%I enable row level security',t);
    EXECUTE format('drop policy if exists "%s authenticated select" on public.%I',replace(t,'_',' '),t);
    EXECUTE format('drop policy if exists "%s authenticated insert" on public.%I',replace(t,'_',' '),t);
    EXECUTE format('drop policy if exists "%s authenticated update" on public.%I',replace(t,'_',' '),t);
    EXECUTE format('drop policy if exists "%s authenticated delete" on public.%I',replace(t,'_',' '),t);
    EXECUTE format('create policy "%s authenticated select" on public.%I for select to authenticated using (true)',replace(t,'_',' '),t);
    EXECUTE format('create policy "%s authenticated insert" on public.%I for insert to authenticated with check (true)',replace(t,'_',' '),t);
    EXECUTE format('create policy "%s authenticated update" on public.%I for update to authenticated using (true) with check (true)',replace(t,'_',' '),t);
    EXECUTE format('create policy "%s authenticated delete" on public.%I for delete to authenticated using (true)',replace(t,'_',' '),t);
    EXECUTE format('grant select,insert,update,delete on public.%I to authenticated',t);
  END LOOP;
END $$;

commit;


-- ============================================================================
-- Included migration: production-migration.sql
-- ============================================================================
-- 기존에 만든 스키마에 운영 UI 필드를 맞추는 추가 마이그레이션
alter table public.customers add column if not exists contract_date date;
alter table public.customers add column if not exists address text;
alter table public.customers add column if not exists birth_number text;

-- 상환 상태를 현재 Admin UI와 통일
alter table public.repayment_schedules drop constraint if exists repayment_schedules_status_check;
alter table public.repayment_schedules add constraint repayment_schedules_status_check
check (status in ('예정','상환완료','연체','보류'));

-- 게시판 첨부파일용 비공개 Storage bucket
insert into storage.buckets (id,name,public,file_size_limit)
values ('board-files','board-files',false,null)
on conflict (id) do update set public=false, file_size_limit=null;

-- 인증 사용자만 내부 첨부파일 접근
drop policy if exists "board files authenticated select" on storage.objects;
drop policy if exists "board files authenticated insert" on storage.objects;
drop policy if exists "board files authenticated update" on storage.objects;
drop policy if exists "board files authenticated delete" on storage.objects;

create policy "board files authenticated select"
on storage.objects for select to authenticated
using (bucket_id='board-files');

create policy "board files authenticated insert"
on storage.objects for insert to authenticated
with check (bucket_id='board-files');

create policy "board files authenticated update"
on storage.objects for update to authenticated
using (bucket_id='board-files')
with check (bucket_id='board-files');

create policy "board files authenticated delete"
on storage.objects for delete to authenticated
using (bucket_id='board-files');


-- ============================================================================
-- Included migration: eformsign-tracking.sql
-- ============================================================================
-- 이폼사인 문서 상태 추적용 컬럼 (한 번만 실행)
alter table public.customers add column if not exists eformsign_document_id text;
alter table public.customers add column if not exists eformsign_status text;
alter table public.customers add column if not exists eformsign_updated_at timestamptz;
create index if not exists idx_customers_eformsign_document_id on public.customers(eformsign_document_id);


-- ============================================================================
-- Included migration: eformsign-customer-fields.sql
-- ============================================================================
alter table public.customers add column if not exists address text;
alter table public.customers add column if not exists birth_number text;
notify pgrst, 'reload schema';


-- ============================================================================
-- Included migration: repayment-lender-contact.sql
-- ============================================================================
-- 상환 일정에 사채업체 연락수단/연락정보 저장 컬럼 추가
-- Supabase SQL Editor에서 한 번만 실행하세요.
alter table public.repayment_schedules
add column if not exists lender_contact_type text;

alter table public.repayment_schedules
add column if not exists lender_contact_value text;


-- ============================================================================
-- Included migration: lender-account-optional-fields.sql
-- ============================================================================
-- 사채업체 계좌정보 + 수기 입력 필드 선택사항 처리
alter table public.lenders add column if not exists account_info text;

-- 사용자가 직접 입력하는 날짜/텍스트는 비워서 저장할 수 있도록 허용
alter table public.customers alter column registered_at drop not null;
alter table public.customers alter column name drop not null;
alter table public.customers alter column phone drop not null;
alter table public.payment_schedules alter column due_date drop not null;
alter table public.repayment_schedules alter column repayment_date drop not null;
alter table public.repayment_schedules alter column lender_name drop not null;
alter table public.settlement_entries alter column payment_date drop not null;
alter table public.settlement_entries alter column client_name drop not null;
alter table public.board_posts alter column title drop not null;
alter table public.board_posts alter column body drop not null;


-- ============================================================================
-- Included migration: meta-leads.sql
-- ============================================================================
-- Meta 인스턴트 양식 신규 DB 저장 테이블
-- 현재 1차 구현에서는 Meta API 연결 전 Admin 내부 화면/고객전환 기능에 사용합니다.

create table if not exists public.meta_leads (
  id uuid primary key default gen_random_uuid(),
  meta_lead_id text unique,
  meta_native_lead_id text,
  created_at timestamptz not null default now(),
  customer_name text not null default '',
  phone_number text not null default '',
  manager text not null default '신홍규',
  sales_manager text not null default '신홍규',
  coordination_manager text not null default '신홍규',
  lender_count integer not null default 0 check (lender_count >= 0),
  memo text not null default '',
  collection_intensity text not null default '',
  principal_amount text not null default '',
  repayment_total text not null default '',
  evidence text not null default '',
  third_party_damage text not null default '',
  lead_result text not null default '신규DB',
  new_db_alert_enabled boolean not null default true,
  meta_event_name text,
  meta_event_sent_at timestamptz,
  meta_event_error text,
  status text not null default '신규' check (status in ('신규','고객등록완료')),
  customer_id uuid references public.customers(id) on delete set null,
  converted_at timestamptz
);

create index if not exists meta_leads_created_at_idx on public.meta_leads(created_at desc);
create index if not exists meta_leads_status_idx on public.meta_leads(status);

alter table public.meta_leads enable row level security;

drop policy if exists "meta leads authenticated select" on public.meta_leads;
drop policy if exists "meta leads authenticated insert" on public.meta_leads;
drop policy if exists "meta leads authenticated update" on public.meta_leads;
drop policy if exists "meta leads authenticated delete" on public.meta_leads;

create policy "meta leads authenticated select"
on public.meta_leads for select to authenticated
using (true);

create policy "meta leads authenticated insert"
on public.meta_leads for insert to authenticated
with check (true);

create policy "meta leads authenticated update"
on public.meta_leads for update to authenticated
using (true)
with check (true);

create policy "meta leads authenticated delete"
on public.meta_leads for delete to authenticated
using (true);


-- ============================================================================
-- Included migration: meta-lead-result-v15.sql
-- ============================================================================
-- v15 신규DB Meta 결과 드롭다운
-- 기존 데이터를 삭제/초기화하지 않고 결과 상태 컬럼만 추가합니다.

alter table if exists public.meta_leads
  add column if not exists lead_result text not null default '신규DB';

alter table if exists public.meta_leads
  add column if not exists new_db_alert_enabled boolean not null default true;

update public.meta_leads
set lead_result = '전환'
where status = '고객등록완료'
  and coalesce(nullif(trim(lead_result), ''), '신규DB') in ('미분류','신규DB');

create index if not exists meta_leads_lead_result_idx
  on public.meta_leads(lead_result);


-- ============================================================================
-- Included migration: change-history.sql
-- ============================================================================
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


-- ============================================================================
-- Included migration: registration-time-order.sql
-- ============================================================================
-- 실제 등록시간 기준 최신순 정렬용 마이그레이션

begin;
-- 기존 업무 날짜(등록일/계약일/예정일/상환일/입금일)는 화면 표시용으로 그대로 유지합니다.
-- admin_created_at은 정렬 전용 실제 생성시각이며, 이후 신규 INSERT는 DB가 now()로 자동 기록합니다.
-- 기존 데이터는 change_history의 '등록' 시각이 있으면 우선 복원하고,
-- 복원할 수 없는 과거 데이터는 기존 날짜 또는 본 마이그레이션 시각을 기준으로 안정적으로 배치합니다.

alter table public.customers add column if not exists admin_created_at timestamptz;
alter table public.payment_schedules add column if not exists admin_created_at timestamptz;
alter table public.repayment_schedules add column if not exists admin_created_at timestamptz;
alter table public.lenders add column if not exists admin_created_at timestamptz;
alter table public.board_posts add column if not exists admin_created_at timestamptz;
alter table public.settlement_entries add column if not exists admin_created_at timestamptz;

-- 기존 데이터의 정렬시각을 채우는 작업 자체가 "기간별 변동내역"에 수정 이력으로 쌓이지 않도록
-- 이 프로젝트의 change-history trigger만 잠시 비활성화합니다. 다른 업무 trigger는 건드리지 않습니다.
do $$
begin
  if exists (select 1 from pg_trigger where tgrelid='public.customers'::regclass and tgname='trg_change_history_customers' and not tgisinternal) then
    execute 'alter table public.customers disable trigger trg_change_history_customers';
  end if;
  if exists (select 1 from pg_trigger where tgrelid='public.payment_schedules'::regclass and tgname='trg_change_history_payments' and not tgisinternal) then
    execute 'alter table public.payment_schedules disable trigger trg_change_history_payments';
  end if;
  if exists (select 1 from pg_trigger where tgrelid='public.repayment_schedules'::regclass and tgname='trg_change_history_repayments' and not tgisinternal) then
    execute 'alter table public.repayment_schedules disable trigger trg_change_history_repayments';
  end if;
  if exists (select 1 from pg_trigger where tgrelid='public.lenders'::regclass and tgname='trg_change_history_lenders' and not tgisinternal) then
    execute 'alter table public.lenders disable trigger trg_change_history_lenders';
  end if;
  if exists (select 1 from pg_trigger where tgrelid='public.board_posts'::regclass and tgname='trg_change_history_board' and not tgisinternal) then
    execute 'alter table public.board_posts disable trigger trg_change_history_board';
  end if;
  if exists (select 1 from pg_trigger where tgrelid='public.settlement_entries'::regclass and tgname='trg_change_history_settlements' and not tgisinternal) then
    execute 'alter table public.settlement_entries disable trigger trg_change_history_settlements';
  end if;
end $$;

do $$
declare
  v_migration_time timestamptz := now();
begin
  if to_regclass('public.change_history') is not null then
    update public.customers c
       set admin_created_at = coalesce(
         (select min(h.occurred_at)
            from public.change_history h
           where h.table_name = 'customers'
             and h.record_id = c.id::text
             and h.action = '등록'),
         (c.registered_at::timestamp at time zone 'Asia/Seoul'),
         v_migration_time
       )
     where c.admin_created_at is null;

    update public.payment_schedules p
       set admin_created_at = coalesce(
         (select min(h.occurred_at)
            from public.change_history h
           where h.table_name = 'payment_schedules'
             and h.record_id = p.id::text
             and h.action = '등록'),
         v_migration_time
       )
     where p.admin_created_at is null;

    update public.repayment_schedules r
       set admin_created_at = coalesce(
         (select min(h.occurred_at)
            from public.change_history h
           where h.table_name = 'repayment_schedules'
             and h.record_id = r.id::text
             and h.action = '등록'),
         v_migration_time
       )
     where r.admin_created_at is null;

    update public.lenders l
       set admin_created_at = coalesce(
         (select min(h.occurred_at)
            from public.change_history h
           where h.table_name = 'lenders'
             and h.record_id = l.id::text
             and h.action = '등록'),
         l.created_at::timestamptz,
         v_migration_time
       )
     where l.admin_created_at is null;

    update public.board_posts b
       set admin_created_at = coalesce(
         (select min(h.occurred_at)
            from public.change_history h
           where h.table_name = 'board_posts'
             and h.record_id = b.id::text
             and h.action = '등록'),
         (b.post_date::timestamp at time zone 'Asia/Seoul'),
         v_migration_time
       )
     where b.admin_created_at is null;

    update public.settlement_entries s
       set admin_created_at = coalesce(
         (select min(h.occurred_at)
            from public.change_history h
           where h.table_name = 'settlement_entries'
             and h.record_id = s.id::text
             and h.action = '등록'),
         v_migration_time
       )
     where s.admin_created_at is null;
  else
    update public.customers
       set admin_created_at = coalesce(
         (registered_at::timestamp at time zone 'Asia/Seoul'),
         v_migration_time
       )
     where admin_created_at is null;

    update public.payment_schedules set admin_created_at = v_migration_time where admin_created_at is null;
    update public.repayment_schedules set admin_created_at = v_migration_time where admin_created_at is null;
    update public.lenders set admin_created_at = coalesce(created_at::timestamptz, v_migration_time) where admin_created_at is null;
    update public.board_posts set admin_created_at = coalesce((post_date::timestamp at time zone 'Asia/Seoul'), v_migration_time) where admin_created_at is null;
    update public.settlement_entries set admin_created_at = v_migration_time where admin_created_at is null;
  end if;
end $$;

alter table public.customers alter column admin_created_at set default now();
alter table public.customers alter column admin_created_at set not null;
alter table public.payment_schedules alter column admin_created_at set default now();
alter table public.payment_schedules alter column admin_created_at set not null;
alter table public.repayment_schedules alter column admin_created_at set default now();
alter table public.repayment_schedules alter column admin_created_at set not null;
alter table public.lenders alter column admin_created_at set default now();
alter table public.lenders alter column admin_created_at set not null;
alter table public.board_posts alter column admin_created_at set default now();
alter table public.board_posts alter column admin_created_at set not null;
alter table public.settlement_entries alter column admin_created_at set default now();
alter table public.settlement_entries alter column admin_created_at set not null;

create index if not exists customers_admin_created_at_idx on public.customers (admin_created_at desc, id desc);
create index if not exists payment_schedules_admin_created_at_idx on public.payment_schedules (admin_created_at desc, id desc);
create index if not exists repayment_schedules_admin_created_at_idx on public.repayment_schedules (admin_created_at desc, id desc);
create index if not exists lenders_admin_created_at_idx on public.lenders (admin_created_at desc, id desc);
create index if not exists board_posts_admin_created_at_idx on public.board_posts (admin_created_at desc, id desc);
create index if not exists settlement_entries_admin_created_at_idx on public.settlement_entries (admin_created_at desc, id desc);

-- change-history trigger 원복
do $$
begin
  if exists (select 1 from pg_trigger where tgrelid='public.customers'::regclass and tgname='trg_change_history_customers' and not tgisinternal) then
    execute 'alter table public.customers enable trigger trg_change_history_customers';
  end if;
  if exists (select 1 from pg_trigger where tgrelid='public.payment_schedules'::regclass and tgname='trg_change_history_payments' and not tgisinternal) then
    execute 'alter table public.payment_schedules enable trigger trg_change_history_payments';
  end if;
  if exists (select 1 from pg_trigger where tgrelid='public.repayment_schedules'::regclass and tgname='trg_change_history_repayments' and not tgisinternal) then
    execute 'alter table public.repayment_schedules enable trigger trg_change_history_repayments';
  end if;
  if exists (select 1 from pg_trigger where tgrelid='public.lenders'::regclass and tgname='trg_change_history_lenders' and not tgisinternal) then
    execute 'alter table public.lenders enable trigger trg_change_history_lenders';
  end if;
  if exists (select 1 from pg_trigger where tgrelid='public.board_posts'::regclass and tgname='trg_change_history_board' and not tgisinternal) then
    execute 'alter table public.board_posts enable trigger trg_change_history_board';
  end if;
  if exists (select 1 from pg_trigger where tgrelid='public.settlement_entries'::regclass and tgname='trg_change_history_settlements' and not tgisinternal) then
    execute 'alter table public.settlement_entries enable trigger trg_change_history_settlements';
  end if;
end $$;

commit;


-- ============================================================================
-- Included migration: payment-reschedule-analytics.sql
-- ============================================================================
-- 연체 → 재약정 납부일정 연결 구조
-- 기존 입금/분납 데이터는 삭제하지 않습니다.
-- 기존 일정은 모두 '일반' 일정으로 유지되고, 이후 재약정 일정만 별도 연결됩니다.

begin;

alter table public.payment_schedules add column if not exists schedule_type text;
alter table public.payment_schedules add column if not exists root_schedule_id uuid;
alter table public.payment_schedules add column if not exists rescheduled_from_id uuid;
alter table public.payment_schedules add column if not exists reschedule_sequence integer;

-- 기존 데이터 보정이 기간별 변동내역에 대량의 수정 로그로 찍히지 않도록
-- 이 migration 동안에만 입금/분납 변경로그 trigger를 잠시 끕니다.
do $$
begin
  if exists (select 1 from pg_trigger where tgrelid='public.payment_schedules'::regclass and tgname='trg_change_history_payments' and not tgisinternal) then
    execute 'alter table public.payment_schedules disable trigger trg_change_history_payments';
  end if;
end $$;

update public.payment_schedules set schedule_type='일반' where schedule_type is null or schedule_type='';
update public.payment_schedules set root_schedule_id=id where root_schedule_id is null;
update public.payment_schedules set reschedule_sequence=0 where reschedule_sequence is null;

alter table public.payment_schedules alter column schedule_type set default '일반';
alter table public.payment_schedules alter column schedule_type set not null;
alter table public.payment_schedules alter column reschedule_sequence set default 0;
alter table public.payment_schedules alter column reschedule_sequence set not null;

alter table public.payment_schedules drop constraint if exists payment_schedules_schedule_type_check;
alter table public.payment_schedules add constraint payment_schedules_schedule_type_check
check (schedule_type in ('일반','재약정'));

-- 자기 자신을 원본 일정으로 자동 연결합니다. 재약정 일정은 Admin이 원본 root를 지정합니다.
create or replace function public.set_payment_schedule_root()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  if new.root_schedule_id is null then
    new.root_schedule_id := new.id;
  end if;
  if new.schedule_type is null or new.schedule_type = '' then
    new.schedule_type := '일반';
  end if;
  if new.reschedule_sequence is null then
    new.reschedule_sequence := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_payment_schedule_root on public.payment_schedules;
create trigger trg_set_payment_schedule_root
before insert on public.payment_schedules
for each row execute function public.set_payment_schedule_root();

-- 동일한 납부건에서 같은 단계의 재약정이 중복 생성되는 실수를 방지합니다.
create unique index if not exists payment_schedules_rescheduled_from_unique_idx
on public.payment_schedules(rescheduled_from_id)
where rescheduled_from_id is not null and deleted_at is null;

create index if not exists payment_schedules_root_schedule_idx
on public.payment_schedules(root_schedule_id,reschedule_sequence,admin_created_at desc);

create index if not exists payment_schedules_schedule_type_idx
on public.payment_schedules(schedule_type,admin_created_at desc);

-- 변경로그 trigger가 기존에 있었다면 즉시 다시 활성화합니다.
do $$
begin
  if exists (select 1 from pg_trigger where tgrelid='public.payment_schedules'::regclass and tgname='trg_change_history_payments' and not tgisinternal) then
    execute 'alter table public.payment_schedules enable trigger trg_change_history_payments';
  end if;
end $$;

commit;


-- ============================================================================
-- Included migration: additional-contract-recovery-repayment-closed.sql
-- ============================================================================
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


-- ============================================================================
-- Included migration: additional-contract-renegotiation-v10.sql
-- ============================================================================
-- 추가계약 재조율 구분 필드 추가
-- 기존 추가계약 데이터는 모두 일반 추가계약(false)으로 유지합니다.

alter table public.additional_contracts
  add column if not exists is_renegotiation boolean not null default false;

comment on column public.additional_contracts.is_renegotiation is
  'true이면 재조율 추가계약. 재조율 업체수는 고객 전체 업체수 합산에서 제외';


-- ============================================================================
-- Included migration: payment-settlement-delete-sync.sql
-- ============================================================================
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


-- ============================================================================
-- Included migration: lender-delete-decouple.sql
-- ============================================================================
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


-- ============================================================================
-- Included migration: repayment-lender-sync-fix.sql
-- ============================================================================
-- 상환완료 상태 호환 + 사채업체 자동등록 중복 제한 해제
-- 기존 데이터는 삭제하지 않습니다.

-- 1) 구버전('완료')과 현재 UI('상환완료')를 모두 허용
alter table public.repayment_schedules
  drop constraint if exists repayment_schedules_status_check;

alter table public.repayment_schedules
  add constraint repayment_schedules_status_check
  check (status in ('예정','완료','상환완료','연체','보류'));

-- 2) lender_contacts에 연락처 중복을 막는 UNIQUE 제약조건이 있으면 모두 제거
do $$
declare r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.lender_contacts'::regclass
      and contype = 'u'
  loop
    execute format('alter table public.lender_contacts drop constraint if exists %I', r.conname);
  end loop;
end $$;

-- 3) 제약조건과 별개로 생성된 UNIQUE INDEX가 있으면 제거 (PK 인덱스 제외)
do $$
declare r record;
begin
  for r in
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'lender_contacts'
      and indexdef ilike 'create unique index%'
      and indexdef not ilike '%(id)%'
  loop
    execute format('drop index if exists public.%I', r.indexname);
  end loop;
end $$;


-- ============================================================================
-- Included migration: lender-contact-optional.sql
-- ============================================================================
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


-- ============================================================================
-- Included migration: lender-customers-staff-roles.sql
-- ============================================================================
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


-- ============================================================================
-- Included migration: customer-accident-status.sql
-- ============================================================================
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


-- ============================================================================
-- Included migration: repayment-collection-status.sql
-- ============================================================================
-- 상환일정 상태에 "추심" 추가
-- 기존 운영 데이터는 삭제/초기화하지 않고 CHECK 제약만 안전하게 확장합니다.

alter table public.repayment_schedules
  drop constraint if exists repayment_schedules_status_check;

alter table public.repayment_schedules
  add constraint repayment_schedules_status_check
  check (status in ('예정','완료','상환완료','연체','보류','추심','종결'));


-- ============================================================================
-- Included migration: customer-negotiation-calculator.sql
-- ============================================================================
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


-- ============================================================================
-- Included migration: customer-negotiation-calculator-v2.sql
-- ============================================================================
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


-- ============================================================================
-- Included migration: customer-negotiation-calculator-v3.sql
-- ============================================================================
-- 고객 조율 계산기 v3
-- 누적 원금/기상환금액 입력 없이, 연락수단 x 기간별 원화 감액 가이드액으로 빠른 조율금액을 계산합니다.
-- 기존 고객/계약/입금/상환/계산이력 데이터는 삭제하지 않습니다.
-- v1/v2 SQL을 실행한 프로젝트에서 1회 실행하세요.

begin;

alter table public.negotiation_guidelines
  add column if not exists guide_1w_amount numeric,
  add column if not exists guide_2w_amount numeric,
  add column if not exists guide_3w_amount numeric,
  add column if not exists guide_4w_amount numeric,
  add column if not exists guide_2m_amount numeric;

update public.negotiation_guidelines
set guide_1w_amount = coalesce(guide_1w_amount, 0),
    guide_2w_amount = coalesce(guide_2w_amount, 0),
    guide_3w_amount = coalesce(guide_3w_amount, 0),
    guide_4w_amount = coalesce(guide_4w_amount, 0),
    guide_2m_amount = coalesce(guide_2m_amount, 0)
where guide_1w_amount is null
   or guide_2w_amount is null
   or guide_3w_amount is null
   or guide_4w_amount is null
   or guide_2m_amount is null;

alter table public.negotiation_guidelines
  alter column guide_1w_amount set default 0,
  alter column guide_1w_amount set not null,
  alter column guide_2w_amount set default 0,
  alter column guide_2w_amount set not null,
  alter column guide_3w_amount set default 0,
  alter column guide_3w_amount set not null,
  alter column guide_4w_amount set default 0,
  alter column guide_4w_amount set not null,
  alter column guide_2m_amount set default 0,
  alter column guide_2m_amount set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_guide_1w_amount_check') then
    alter table public.negotiation_guidelines add constraint negotiation_guidelines_guide_1w_amount_check check (guide_1w_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_guide_2w_amount_check') then
    alter table public.negotiation_guidelines add constraint negotiation_guidelines_guide_2w_amount_check check (guide_2w_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_guide_3w_amount_check') then
    alter table public.negotiation_guidelines add constraint negotiation_guidelines_guide_3w_amount_check check (guide_3w_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_guide_4w_amount_check') then
    alter table public.negotiation_guidelines add constraint negotiation_guidelines_guide_4w_amount_check check (guide_4w_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_guide_2m_amount_check') then
    alter table public.negotiation_guidelines add constraint negotiation_guidelines_guide_2m_amount_check check (guide_2m_amount >= 0);
  end if;
end $$;

-- 네 연락수단 행이 없는 환경도 안전하게 보완합니다.
insert into public.negotiation_guidelines(contact_type,default_period,guide_1w_amount,guide_2w_amount,guide_3w_amount,guide_4w_amount,guide_2m_amount)
values
 ('번호','1주',0,0,0,0,0),
 ('텔레그램','1주',0,0,0,0,0),
 ('카카오톡','1주',0,0,0,0,0),
 ('라인','1주',0,0,0,0,0)
on conflict (contact_type) do nothing;

commit;


-- ============================================================================
-- Included migration: meta-crm-realtime-v16.sql
-- ============================================================================
-- v16: 신규DB Meta CRM 피드백 + Admin 실시간 반영
-- 기존 데이터를 삭제/초기화하지 않습니다.

alter table if exists public.meta_leads
  add column if not exists meta_native_lead_id text,
  add column if not exists meta_event_name text,
  add column if not exists meta_event_sent_at timestamptz,
  add column if not exists meta_event_error text;

create index if not exists meta_leads_native_lead_id_idx
  on public.meta_leads(meta_native_lead_id)
  where meta_native_lead_id is not null;

-- 기존 v15 lead_result 컬럼이 없는 환경도 안전하게 보완
alter table if exists public.meta_leads
  add column if not exists lead_result text not null default '신규DB';

alter table if exists public.meta_leads
  add column if not exists new_db_alert_enabled boolean not null default true;

-- Supabase Realtime publication에 운영 테이블을 안전하게 추가합니다.
do $$
declare
  t text;
  tables text[] := array[
    'customers',
    'payment_schedules',
    'repayment_schedules',
    'lenders',
    'lender_contacts',
    'lender_customers',
    'board_posts',
    'board_attachments',
    'settlement_entries',
    'meta_leads',
    'additional_contracts',
    'recoveries',
    'change_history',
    'negotiation_guidelines',
    'customer_calculator_items',
    'customer_calculation_snapshots'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is not null
       and not exists (
         select 1
         from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = t
       ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ============================================================================
-- 로파워 Fresh Setup 최종 보정
-- ============================================================================

-- 새 프로젝트 직원 기본값
alter table public.customers alter column manager set default '신홍규';
alter table public.customers alter column sales_manager set default '신홍규';
alter table public.customers alter column coordination_manager set default '신홍규';
alter table public.meta_leads alter column manager set default '신홍규';
alter table public.meta_leads alter column sales_manager set default '신홍규';
alter table public.meta_leads alter column coordination_manager set default '신홍규';

-- 신규DB 상태는 현재 Admin과 정확히 일치
alter table public.meta_leads drop constraint if exists meta_leads_status_check;
alter table public.meta_leads add constraint meta_leads_status_check check(status in ('신규','고객등록완료'));

-- 최종 상환 상태: 추심/종결 포함
alter table public.repayment_schedules drop constraint if exists repayment_schedules_status_check;
alter table public.repayment_schedules add constraint repayment_schedules_status_check
check(status in ('예정','완료','상환완료','연체','보류','추심','종결'));

-- 모든 신규 설치 테이블을 Realtime publication에 추가
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customers','payment_schedules','repayment_schedules','lenders','lender_contacts','lender_customers',
    'board_posts','board_attachments','settlement_entries','meta_leads','additional_contracts','recoveries',
    'change_history','negotiation_guidelines','customer_calculator_items','customer_calculation_snapshots'
  ]
  LOOP
    IF to_regclass('public.'||t) IS NOT NULL AND NOT EXISTS (
      select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) THEN
      EXECUTE format('alter publication supabase_realtime add table public.%I',t);
    END IF;
  END LOOP;
END $$;

notify pgrst, 'reload schema';

-- 신규 설치 권한 최종 보정
grant usage on schema public to authenticated;
grant select,insert,update,delete on public.customers to authenticated;
grant select,insert,update,delete on public.payment_schedules to authenticated;
grant select,insert,update,delete on public.repayment_schedules to authenticated;
grant select,insert,update,delete on public.lenders to authenticated;
grant select,insert,update,delete on public.lender_contacts to authenticated;
grant select,insert,update,delete on public.lender_customers to authenticated;
grant select,insert,update,delete on public.board_posts to authenticated;
grant select,insert,update,delete on public.board_attachments to authenticated;
grant select,insert,update,delete on public.settlement_entries to authenticated;
grant select,insert,update,delete on public.meta_leads to authenticated;
grant select,insert,update,delete on public.additional_contracts to authenticated;
grant select,insert,update,delete on public.recoveries to authenticated;
notify pgrst, 'reload schema';


-- ============================================================================
-- Included v2 migration: 03_RBAC_ADMIN_STAFF.sql
-- ============================================================================
-- ============================================================================
-- 로파워 Admin v2 권한분리 (ADMIN / STAFF)
-- 이미 00_ROPOWER_FRESH_SETUP.sql 을 실행한 현재 로파워 Supabase에서 1회 실행하세요.
-- 운영 데이터는 삭제하지 않습니다.
--
-- ADMIN(최종관리자)
--   - 전체 메뉴
--   - 정산 / 기간별 변동내역 / 데이터 집계
--   - 삭제(soft delete / hard delete)
--   - 전사 조율 가이드 설정 및 계산 이력 삭제
--
-- STAFF(직원)
--   - 대시보드 / 신규DB / 고객 / 계약 / 입금분납 / 상환 / 업체 / 게시판
--   - 등록 및 수정
--   - 삭제 불가
--   - 정산 / 기간별 변동내역 / 데이터 집계 접근 불가
--   - 자신의 role을 ADMIN으로 변경 불가
-- ============================================================================

begin;

-- 1) role 값 정규화 + 제약조건
update public.profiles
set role = case when upper(coalesce(role,''))='ADMIN' then 'ADMIN' else 'STAFF' end,
    updated_at = now();

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('ADMIN','STAFF'));

-- 현재 로파워 계정 역할 확정
update public.profiles p
set role='ADMIN', updated_at=now()
from auth.users u
where p.id=u.id and lower(u.email) in (lower('doublestone@1.com'), lower('hsw@1.com'));

update public.profiles p
set role='STAFF',
    name=case
      when lower(u.email)=lower('shk@1.com') then '신홍규'
      when lower(u.email)=lower('wndgh1245@naver.com') then '이중호'
      else p.name
    end,
    updated_at=now()
from auth.users u
where p.id=u.id and lower(u.email) in (lower('shk@1.com'), lower('wndgh1245@naver.com'));

-- 2) 권한 판별 helper
create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select exists(
    select 1
    from public.profiles p
    where p.id=auth.uid() and p.role='ADMIN'
  );
$$;

revoke all on function public.is_app_admin() from public;
grant execute on function public.is_app_admin() to authenticated;

-- 3) 사용자가 본인 profile의 role을 직접 바꾸지 못하게 컬럼 권한 제한
-- SQL Editor / service_role은 계속 role 변경 가능
revoke update on public.profiles from authenticated;
grant update(name,updated_at) on public.profiles to authenticated;

-- 4) 최종관리자 전용: 정산
alter table public.settlement_entries enable row level security;
drop policy if exists "settlement entries authenticated select" on public.settlement_entries;
drop policy if exists "settlement entries authenticated insert" on public.settlement_entries;
drop policy if exists "settlement entries authenticated update" on public.settlement_entries;
drop policy if exists "settlement entries authenticated delete" on public.settlement_entries;
drop policy if exists "settlement entries admin select" on public.settlement_entries;
drop policy if exists "settlement entries admin insert" on public.settlement_entries;
drop policy if exists "settlement entries admin update" on public.settlement_entries;
drop policy if exists "settlement entries admin delete" on public.settlement_entries;

create policy "settlement entries admin select" on public.settlement_entries
for select to authenticated using (public.is_app_admin());
create policy "settlement entries admin insert" on public.settlement_entries
for insert to authenticated with check (public.is_app_admin());
create policy "settlement entries admin update" on public.settlement_entries
for update to authenticated using (public.is_app_admin()) with check (public.is_app_admin());
create policy "settlement entries admin delete" on public.settlement_entries
for delete to authenticated using (public.is_app_admin());

-- 자동 정산 trigger는 SECURITY DEFINER라 STAFF가 입금 완료처리해도 정상 자동연동됩니다.

-- 5) 최종관리자 전용: 기간별 변동내역
alter table public.change_history enable row level security;
drop policy if exists "change history authenticated select" on public.change_history;
drop policy if exists "change history admin select" on public.change_history;
create policy "change history admin select" on public.change_history
for select to authenticated using (public.is_app_admin());

-- 6) 신규 DB 삭제는 최종관리자만. 조회/등록/수정은 직원 허용.
alter table public.meta_leads enable row level security;
drop policy if exists "meta leads authenticated delete" on public.meta_leads;
drop policy if exists "meta leads admin delete" on public.meta_leads;
create policy "meta leads admin delete" on public.meta_leads
for delete to authenticated using (public.is_app_admin());

-- 7) 전사 조율 가이드라인 수정은 최종관리자만. 직원은 조회만 가능.
alter table public.negotiation_guidelines enable row level security;
drop policy if exists "negotiation guidelines authenticated insert" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines authenticated update" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines authenticated delete" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines admin insert" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines admin update" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines admin delete" on public.negotiation_guidelines;
create policy "negotiation guidelines admin insert" on public.negotiation_guidelines
for insert to authenticated with check (public.is_app_admin());
create policy "negotiation guidelines admin update" on public.negotiation_guidelines
for update to authenticated using (public.is_app_admin()) with check (public.is_app_admin());
create policy "negotiation guidelines admin delete" on public.negotiation_guidelines
for delete to authenticated using (public.is_app_admin());

-- 조율 계산 이력은 직원도 생성/조회 가능하지만 삭제는 최종관리자만.
alter table public.customer_calculation_snapshots enable row level security;
drop policy if exists "customer calculation snapshots authenticated delete" on public.customer_calculation_snapshots;
drop policy if exists "customer calculation snapshots admin delete" on public.customer_calculation_snapshots;
create policy "customer calculation snapshots admin delete" on public.customer_calculation_snapshots
for delete to authenticated using (public.is_app_admin());

-- 8) 물리 DELETE 권한을 최종관리자로 제한
-- lender_contacts / lender_customers / board_attachments는 수정 저장 과정에서 재작성되므로 제외합니다.
do $$
declare t text;
begin
  foreach t in array array[
    'customers','payment_schedules','repayment_schedules','lenders','board_posts',
    'additional_contracts','recoveries'
  ]
  loop
    execute format('drop policy if exists "%s authenticated delete" on public.%I',replace(t,'_',' '),t);
    execute format('drop policy if exists "%s admin delete" on public.%I',replace(t,'_',' '),t);
    execute format('create policy "%s admin delete" on public.%I for delete to authenticated using (public.is_app_admin())',replace(t,'_',' '),t);
  end loop;
end $$;

-- 9) soft delete(deleted_at)도 STAFF는 실행하지 못하도록 DB trigger로 차단
create or replace function public.prevent_staff_soft_delete()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  if not public.is_app_admin()
     and old.deleted_at is null
     and new.deleted_at is not null then
    raise exception '삭제는 최종관리자만 가능합니다.' using errcode='42501';
  end if;
  return new;
end;
$$;

-- deleted_at 컬럼이 있는 운영 테이블
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customers','payment_schedules','repayment_schedules','lenders','board_posts',
    'additional_contracts','recoveries'
  ]
  LOOP
    EXECUTE format('drop trigger if exists trg_prevent_staff_soft_delete on public.%I',t);
    EXECUTE format('create trigger trg_prevent_staff_soft_delete before update of deleted_at on public.%I for each row execute function public.prevent_staff_soft_delete()',t);
  END LOOP;
END $$;

commit;
notify pgrst, 'reload schema';

