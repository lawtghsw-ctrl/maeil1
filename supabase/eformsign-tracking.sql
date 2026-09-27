-- 이폼사인 문서 상태 추적용 컬럼 (한 번만 실행)
alter table public.customers add column if not exists eformsign_document_id text;
alter table public.customers add column if not exists eformsign_status text;
alter table public.customers add column if not exists eformsign_updated_at timestamptz;
create index if not exists idx_customers_eformsign_document_id on public.customers(eformsign_document_id);
