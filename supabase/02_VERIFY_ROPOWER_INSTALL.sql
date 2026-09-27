-- 로파워 신규 설치 확인용 (읽기 전용)

-- 1) 핵심 테이블 존재 여부
select table_name
from information_schema.tables
where table_schema='public'
  and table_name in (
    'profiles','customers','payment_schedules','repayment_schedules','lenders','lender_contacts','lender_customers',
    'board_posts','board_attachments','settlement_entries','meta_leads','additional_contracts','recoveries',
    'change_history','negotiation_guidelines','customer_calculator_items','customer_calculation_snapshots'
  )
order by table_name;

-- 2) 신규DB 상태 CHECK
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid='public.meta_leads'::regclass
  and conname='meta_leads_status_check';

-- 3) 상환 상태 CHECK (추심/종결 포함 여부)
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid='public.repayment_schedules'::regclass
  and conname='repayment_schedules_status_check';

-- 4) Realtime 등록 테이블
select tablename
from pg_publication_tables
where pubname='supabase_realtime'
  and schemaname='public'
order by tablename;

-- 5) 업무 데이터가 비어 있는지 확인
select 'customers' table_name, count(*) row_count from public.customers
union all select 'meta_leads', count(*) from public.meta_leads
union all select 'payment_schedules', count(*) from public.payment_schedules
union all select 'repayment_schedules', count(*) from public.repayment_schedules
union all select 'lenders', count(*) from public.lenders
union all select 'settlement_entries', count(*) from public.settlement_entries
union all select 'board_posts', count(*) from public.board_posts
union all select 'additional_contracts', count(*) from public.additional_contracts
union all select 'recoveries', count(*) from public.recoveries;
