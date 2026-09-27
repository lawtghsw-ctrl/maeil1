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
