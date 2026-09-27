-- 추가계약 재조율 구분 필드 추가
-- 기존 추가계약 데이터는 모두 일반 추가계약(false)으로 유지합니다.

alter table public.additional_contracts
  add column if not exists is_renegotiation boolean not null default false;

comment on column public.additional_contracts.is_renegotiation is
  'true이면 재조율 추가계약. 재조율 업체수는 고객 전체 업체수 합산에서 제외';
