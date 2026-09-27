-- 로파워 v4: Google Sheet 상담신청 추가정보를 메모가 아닌 전용 컬럼으로 분리
-- 기존 고객/계약/입금 데이터는 삭제하지 않습니다.

begin;

alter table public.meta_leads
  add column if not exists collection_intensity text not null default '',
  add column if not exists principal_amount text not null default '',
  add column if not exists repayment_total text not null default '',
  add column if not exists evidence text not null default '',
  add column if not exists third_party_damage text not null default '';

-- v3에서 자동 생성된 메모가 남아 있는 경우, 가능한 값만 전용 컬럼으로 옮깁니다.
update public.meta_leads
set
  collection_intensity = case
    when collection_intensity = '' then coalesce((regexp_match(memo, E'(^|\\n)추심강도:[ \\t]*([^\\r\\n]*)'))[2], '')
    else collection_intensity
  end,
  principal_amount = case
    when principal_amount = '' then coalesce((regexp_match(memo, E'(^|\\n)대여원금:[ \\t]*([^\\r\\n]*)'))[2], '')
    else principal_amount
  end,
  repayment_total = case
    when repayment_total = '' then coalesce((regexp_match(memo, E'(^|\\n)상환총액:[ \\t]*([^\\r\\n]*)'))[2], '')
    else repayment_total
  end,
  evidence = case
    when evidence = '' then coalesce((regexp_match(memo, E'(^|\\n)증거보유:[ \\t]*([^\\r\\n]*)'))[2], '')
    else evidence
  end,
  third_party_damage = case
    when third_party_damage = '' then coalesce((regexp_match(memo, E'(^|\\n)주변인피해:[ \\t]*([^\\r\\n]*)'))[2], '')
    else third_party_damage
  end
where memo ~ E'(^|\\n)(추심강도|대여원금|상환총액|증거보유|주변인피해):';

-- 자동 생성된 5개 라인만 메모에서 제거하고 직원이 직접 적은 다른 메모는 보존합니다.
update public.meta_leads
set memo = trim(both E' \\t\\r\\n' from regexp_replace(
  memo,
  E'(^|\\n)(추심강도|대여원금|상환총액|증거보유|주변인피해):[^\\r\\n]*(\\r?\\n|$)',
  E'\\1',
  'g'
))
where memo ~ E'(^|\\n)(추심강도|대여원금|상환총액|증거보유|주변인피해):';

commit;

-- 확인용
select
  count(*) as total_leads,
  count(*) filter (where collection_intensity <> '') as with_collection_intensity,
  count(*) filter (where principal_amount <> '') as with_principal_amount,
  count(*) filter (where repayment_total <> '') as with_repayment_total,
  count(*) filter (where evidence <> '') as with_evidence,
  count(*) filter (where third_party_damage <> '') as with_third_party_damage
from public.meta_leads;
