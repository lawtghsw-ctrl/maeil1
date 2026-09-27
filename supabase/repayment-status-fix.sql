-- 상환 일정 상태값을 현재 Admin UI와 일치시키는 안전한 단일 마이그레이션
-- 기존 데이터/테이블은 삭제하거나 초기화하지 않습니다.

alter table public.repayment_schedules
  drop constraint if exists repayment_schedules_status_check;

-- 예전 버전에서 '완료'로 저장된 값이 있다면 현재 UI의 '상환완료'로 통일합니다.
update public.repayment_schedules
set status = '상환완료'
where status = '완료';

alter table public.repayment_schedules
  add constraint repayment_schedules_status_check
  check (status in ('예정','상환완료','연체','보류'));
