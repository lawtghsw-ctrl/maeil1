-- 상환일정 상태에 "추심" 추가
-- 기존 운영 데이터는 삭제/초기화하지 않고 CHECK 제약만 안전하게 확장합니다.

alter table public.repayment_schedules
  drop constraint if exists repayment_schedules_status_check;

alter table public.repayment_schedules
  add constraint repayment_schedules_status_check
  check (status in ('예정','완료','상환완료','연체','보류','추심','종결'));
