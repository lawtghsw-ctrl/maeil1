-- Meta 인스턴트 양식 신규 DB 저장 테이블
-- 현재 1차 구현에서는 Meta API 연결 전 Admin 내부 화면/고객전환 기능에 사용합니다.

create table if not exists public.meta_leads (
  id uuid primary key default gen_random_uuid(),
  meta_lead_id text unique,
  meta_native_lead_id text,
  created_at timestamptz not null default now(),
  customer_name text not null default '',
  phone_number text not null default '',
  manager text not null default '신홍규',
  sales_manager text not null default '신홍규',
  coordination_manager text not null default '신홍규',
  lender_count integer not null default 0 check (lender_count >= 0),
  memo text not null default '',
  collection_intensity text not null default '',
  principal_amount text not null default '',
  repayment_total text not null default '',
  evidence text not null default '',
  third_party_damage text not null default '',
  lead_result text not null default '미분류',
  meta_event_name text,
  meta_event_sent_at timestamptz,
  meta_event_error text,
  status text not null default '신규' check (status in ('신규','고객등록완료')),
  customer_id uuid references public.customers(id) on delete set null,
  converted_at timestamptz
);

create index if not exists meta_leads_created_at_idx on public.meta_leads(created_at desc);
create index if not exists meta_leads_status_idx on public.meta_leads(status);

alter table public.meta_leads enable row level security;

drop policy if exists "meta leads authenticated select" on public.meta_leads;
drop policy if exists "meta leads authenticated insert" on public.meta_leads;
drop policy if exists "meta leads authenticated update" on public.meta_leads;
drop policy if exists "meta leads authenticated delete" on public.meta_leads;

create policy "meta leads authenticated select"
on public.meta_leads for select to authenticated
using (true);

create policy "meta leads authenticated insert"
on public.meta_leads for insert to authenticated
with check (true);

create policy "meta leads authenticated update"
on public.meta_leads for update to authenticated
using (true)
with check (true);

create policy "meta leads authenticated delete"
on public.meta_leads for delete to authenticated
using (true);
