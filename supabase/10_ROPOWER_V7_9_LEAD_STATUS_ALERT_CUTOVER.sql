-- ROPOWER V7.9 신규DB 상태/알림 전환
-- 실행 목적:
-- 1) 기존 '미분류' 표기를 '신규DB'로 변경
-- 2) 현재까지 이미 들어와 있는 DB는 상단 '신규 DB가 입고되었습니다' 알림에서 일괄 제외
-- 3) 이 SQL 실행 이후 새로 들어오는 외부 DB만 알림 대상이 되도록 기본값 true 설정
-- 기존 고객/계약/입금/정산 데이터는 건드리지 않습니다.

begin;

alter table public.meta_leads
  add column if not exists new_db_alert_enabled boolean;

-- 이 시점까지 존재하던 DB는 모두 기존 DB로 간주하여 알림에서 제외합니다.
update public.meta_leads
set new_db_alert_enabled = false
where new_db_alert_enabled is null;

alter table public.meta_leads
  alter column new_db_alert_enabled set default true;

alter table public.meta_leads
  alter column new_db_alert_enabled set not null;

-- 기존 '미분류' 데이터는 화면/DB 모두 '신규DB'로 정리합니다.
update public.meta_leads
set lead_result = '신규DB'
where lead_result is null
   or trim(lead_result) = ''
   or lead_result = '미분류';

commit;
