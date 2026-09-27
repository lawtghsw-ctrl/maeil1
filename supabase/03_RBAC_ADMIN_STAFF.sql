-- ============================================================================
-- 로파워 Admin v2 권한분리 (ADMIN / STAFF)
-- 이미 00_ROPOWER_FRESH_SETUP.sql 을 실행한 현재 로파워 Supabase에서 1회 실행하세요.
-- 운영 데이터는 삭제하지 않습니다.
--
-- ADMIN(최종관리자)
--   - 전체 메뉴
--   - 정산 / 기간별 변동내역 / 데이터 집계
--   - 삭제(soft delete / hard delete)
--   - 전사 조율 가이드 설정 및 계산 이력 삭제
--
-- STAFF(직원)
--   - 대시보드 / 신규DB / 고객 / 계약 / 입금분납 / 상환 / 업체 / 게시판
--   - 등록 및 수정
--   - 삭제 불가
--   - 정산 / 기간별 변동내역 / 데이터 집계 접근 불가
--   - 자신의 role을 ADMIN으로 변경 불가
-- ============================================================================

begin;

-- 1) role 값 정규화 + 제약조건
update public.profiles
set role = case when upper(coalesce(role,''))='ADMIN' then 'ADMIN' else 'STAFF' end,
    updated_at = now();

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('ADMIN','STAFF'));

-- 현재 로파워 계정 역할 확정
update public.profiles p
set role='ADMIN', updated_at=now()
from auth.users u
where p.id=u.id and lower(u.email) in (lower('doublestone@1.com'), lower('hsw@1.com'));

update public.profiles p
set role='STAFF',
    name=case
      when lower(u.email)=lower('shk@1.com') then '신홍규'
      when lower(u.email)=lower('wndgh1245@naver.com') then '이중호'
      else p.name
    end,
    updated_at=now()
from auth.users u
where p.id=u.id and lower(u.email) in (lower('shk@1.com'), lower('wndgh1245@naver.com'));

-- 2) 권한 판별 helper
create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select exists(
    select 1
    from public.profiles p
    where p.id=auth.uid() and p.role='ADMIN'
  );
$$;

revoke all on function public.is_app_admin() from public;
grant execute on function public.is_app_admin() to authenticated;

-- 3) 사용자가 본인 profile의 role을 직접 바꾸지 못하게 컬럼 권한 제한
-- SQL Editor / service_role은 계속 role 변경 가능
revoke update on public.profiles from authenticated;
grant update(name,updated_at) on public.profiles to authenticated;

-- 4) 최종관리자 전용: 정산
alter table public.settlement_entries enable row level security;
drop policy if exists "settlement entries authenticated select" on public.settlement_entries;
drop policy if exists "settlement entries authenticated insert" on public.settlement_entries;
drop policy if exists "settlement entries authenticated update" on public.settlement_entries;
drop policy if exists "settlement entries authenticated delete" on public.settlement_entries;
drop policy if exists "settlement entries admin select" on public.settlement_entries;
drop policy if exists "settlement entries admin insert" on public.settlement_entries;
drop policy if exists "settlement entries admin update" on public.settlement_entries;
drop policy if exists "settlement entries admin delete" on public.settlement_entries;

create policy "settlement entries admin select" on public.settlement_entries
for select to authenticated using (public.is_app_admin());
create policy "settlement entries admin insert" on public.settlement_entries
for insert to authenticated with check (public.is_app_admin());
create policy "settlement entries admin update" on public.settlement_entries
for update to authenticated using (public.is_app_admin()) with check (public.is_app_admin());
create policy "settlement entries admin delete" on public.settlement_entries
for delete to authenticated using (public.is_app_admin());

-- 자동 정산 trigger는 SECURITY DEFINER라 STAFF가 입금 완료처리해도 정상 자동연동됩니다.

-- 5) 최종관리자 전용: 기간별 변동내역
alter table public.change_history enable row level security;
drop policy if exists "change history authenticated select" on public.change_history;
drop policy if exists "change history admin select" on public.change_history;
create policy "change history admin select" on public.change_history
for select to authenticated using (public.is_app_admin());

-- 6) 신규 DB 삭제는 최종관리자만. 조회/등록/수정은 직원 허용.
alter table public.meta_leads enable row level security;
drop policy if exists "meta leads authenticated delete" on public.meta_leads;
drop policy if exists "meta leads admin delete" on public.meta_leads;
create policy "meta leads admin delete" on public.meta_leads
for delete to authenticated using (public.is_app_admin());

-- 7) 전사 조율 가이드라인 수정은 최종관리자만. 직원은 조회만 가능.
alter table public.negotiation_guidelines enable row level security;
drop policy if exists "negotiation guidelines authenticated insert" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines authenticated update" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines authenticated delete" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines admin insert" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines admin update" on public.negotiation_guidelines;
drop policy if exists "negotiation guidelines admin delete" on public.negotiation_guidelines;
create policy "negotiation guidelines admin insert" on public.negotiation_guidelines
for insert to authenticated with check (public.is_app_admin());
create policy "negotiation guidelines admin update" on public.negotiation_guidelines
for update to authenticated using (public.is_app_admin()) with check (public.is_app_admin());
create policy "negotiation guidelines admin delete" on public.negotiation_guidelines
for delete to authenticated using (public.is_app_admin());

-- 조율 계산 이력은 직원도 생성/조회 가능하지만 삭제는 최종관리자만.
alter table public.customer_calculation_snapshots enable row level security;
drop policy if exists "customer calculation snapshots authenticated delete" on public.customer_calculation_snapshots;
drop policy if exists "customer calculation snapshots admin delete" on public.customer_calculation_snapshots;
create policy "customer calculation snapshots admin delete" on public.customer_calculation_snapshots
for delete to authenticated using (public.is_app_admin());

-- 8) 물리 DELETE 권한을 최종관리자로 제한
-- lender_contacts / lender_customers / board_attachments는 수정 저장 과정에서 재작성되므로 제외합니다.
do $$
declare t text;
begin
  foreach t in array array[
    'customers','payment_schedules','repayment_schedules','lenders','board_posts',
    'additional_contracts','recoveries'
  ]
  loop
    execute format('drop policy if exists "%s authenticated delete" on public.%I',replace(t,'_',' '),t);
    execute format('drop policy if exists "%s admin delete" on public.%I',replace(t,'_',' '),t);
    execute format('create policy "%s admin delete" on public.%I for delete to authenticated using (public.is_app_admin())',replace(t,'_',' '),t);
  end loop;
end $$;

-- 9) soft delete(deleted_at)도 STAFF는 실행하지 못하도록 DB trigger로 차단
create or replace function public.prevent_staff_soft_delete()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  if not public.is_app_admin()
     and old.deleted_at is null
     and new.deleted_at is not null then
    raise exception '삭제는 최종관리자만 가능합니다.' using errcode='42501';
  end if;
  return new;
end;
$$;

-- deleted_at 컬럼이 있는 운영 테이블
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customers','payment_schedules','repayment_schedules','lenders','board_posts',
    'additional_contracts','recoveries'
  ]
  LOOP
    EXECUTE format('drop trigger if exists trg_prevent_staff_soft_delete on public.%I',t);
    EXECUTE format('create trigger trg_prevent_staff_soft_delete before update of deleted_at on public.%I for each row execute function public.prevent_staff_soft_delete()',t);
  END LOOP;
END $$;

commit;
notify pgrst, 'reload schema';
