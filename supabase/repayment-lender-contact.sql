-- 상환 일정에 사채업체 연락수단/연락정보 저장 컬럼 추가
-- Supabase SQL Editor에서 한 번만 실행하세요.
alter table public.repayment_schedules
add column if not exists lender_contact_type text;

alter table public.repayment_schedules
add column if not exists lender_contact_value text;
