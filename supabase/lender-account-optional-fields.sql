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
