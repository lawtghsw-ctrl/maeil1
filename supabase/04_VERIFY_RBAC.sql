-- 로파워 Admin v2 권한분리 확인용 (조회만 수행)

-- 1) 사용자 / 역할
select u.email, p.name, p.role
from auth.users u
left join public.profiles p on p.id=u.id
order by case when p.role='ADMIN' then 0 else 1 end, u.email;

-- 2) ADMIN/STAFF helper 존재 확인
select proname, prosecdef
from pg_proc
where proname='is_app_admin';

-- 3) 주요 RLS policy 확인
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname='public'
  and tablename in (
    'profiles','settlement_entries','change_history','meta_leads',
    'negotiation_guidelines','customer_calculation_snapshots',
    'customers','payment_schedules','repayment_schedules','lenders','board_posts',
    'additional_contracts','recoveries'
  )
order by tablename, cmd, policyname;

-- 4) soft-delete 방지 trigger 확인
select event_object_table, trigger_name, action_timing, event_manipulation
from information_schema.triggers
where trigger_schema='public'
  and trigger_name='trg_prevent_staff_soft_delete'
order by event_object_table;
