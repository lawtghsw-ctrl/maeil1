-- Ropower 신규 DB 정렬 보정 V6
-- 목적: Google Sheet 원본 행 번호를 저장하고, 과거 연동 데이터에도 행 번호를 복원합니다.
-- 기존 고객/계약/입금/상환 데이터는 건드리지 않습니다.

begin;

alter table public.meta_leads
  add column if not exists source_row_number bigint;

-- 기존 Google Sheet 연동 건은 meta_lead_id가
-- gsheet:<spreadsheet_id>:<sheet_id>:<row_number> 형태이므로 마지막 값을 복원합니다.
update public.meta_leads
set source_row_number = split_part(meta_lead_id, ':', 4)::bigint
where source_row_number is null
  and meta_lead_id ~ '^gsheet:[^:]+:[^:]+:[0-9]+$';

create index if not exists meta_leads_source_row_number_idx
  on public.meta_leads(source_row_number desc);

commit;

-- 확인용: 가장 큰 시트 행 번호가 위에 나오는지 확인
select source_row_number, created_at, customer_name, phone_number
from public.meta_leads
where source_row_number is not null
order by source_row_number desc
limit 20;
