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
