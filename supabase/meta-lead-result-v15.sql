-- v15 신규DB Meta 결과 드롭다운
-- 기존 데이터를 삭제/초기화하지 않고 결과 상태 컬럼만 추가합니다.

alter table if exists public.meta_leads
  add column if not exists lead_result text not null default '미분류';

update public.meta_leads
set lead_result = '전환'
where status = '고객등록완료'
  and coalesce(nullif(trim(lead_result), ''), '미분류') = '미분류';

create index if not exists meta_leads_lead_result_idx
  on public.meta_leads(lead_result);
