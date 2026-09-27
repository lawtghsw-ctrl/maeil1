-- 전자계약 기능 도입 전에 등록된 기존 고객의 표시 상태를 '서명완료'로 보정합니다.
-- 실제 이폼사인 문서 ID가 없는 기존 고객만 대상으로 하므로,
-- 이후 새로 발송한 전자계약 문서의 상태 추적에는 영향을 주지 않습니다.

update public.customers
set
  eformsign_status = 'doc_complete',
  eformsign_updated_at = coalesce(eformsign_updated_at, now())
where coalesce(trim(eformsign_document_id), '') = ''
  and coalesce(trim(eformsign_status), '') = ''
  and deleted_at is null;
