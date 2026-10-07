-- ==========================================================================
-- ROPOWER V7.7 · 직원 운영기능 권한 확대
-- 목적
--   - ADMIN/STAFF 모두 정산 / 기간별 변동내역 / 데이터집계 외 운영기능 사용 가능
--   - 기존 운영 데이터는 삭제/초기화하지 않음
--   - 정산(settlement_entries), 기간별 변동내역(change_history)은 ADMIN 전용 유지
--   - profiles.role 직접 변경 제한도 유지
--
-- 적용 후 STAFF도 허용
--   고객/계약/입금분납/상환/사채업체/게시판/신규DB CRUD
--   추가계약/환수 삭제 및 수정
--   조율 가이드 설정/수정/삭제
--   조율 계산 이력 삭제
-- ==========================================================================

begin;

-- 1) 일반 운영 테이블의 삭제 권한을 로그인 사용자 전체에 허용
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customers','payment_schedules','repayment_schedules','lenders','board_posts',
    'additional_contracts','recoveries'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('alter table public.%I enable row level security', t);
      EXECUTE format('drop policy if exists "%s admin delete" on public.%I', replace(t,'_',' '), t);
      EXECUTE format('drop policy if exists "%s authenticated delete" on public.%I', replace(t,'_',' '), t);
      EXECUTE format('create policy "%s authenticated delete" on public.%I for delete to authenticated using (true)', replace(t,'_',' '), t);
      EXECUTE format('grant delete on public.%I to authenticated', t);
      -- V2에서 만든 STAFF soft-delete 차단 trigger 제거
      EXECUTE format('drop trigger if exists trg_prevent_staff_soft_delete on public.%I', t);
    END IF;
  END LOOP;
END $$;

-- 2) 신규 DB 삭제도 STAFF 허용
DO $$
BEGIN
  IF to_regclass('public.meta_leads') IS NOT NULL THEN
    alter table public.meta_leads enable row level security;
    drop policy if exists "meta leads admin delete" on public.meta_leads;
    drop policy if exists "meta leads authenticated delete" on public.meta_leads;
    create policy "meta leads authenticated delete" on public.meta_leads
      for delete to authenticated using (true);
    grant delete on public.meta_leads to authenticated;
  END IF;
END $$;

-- 3) 전사 조율 가이드 설정을 STAFF에도 허용
DO $$
BEGIN
  IF to_regclass('public.negotiation_guidelines') IS NOT NULL THEN
    alter table public.negotiation_guidelines enable row level security;

    drop policy if exists "negotiation guidelines admin insert" on public.negotiation_guidelines;
    drop policy if exists "negotiation guidelines admin update" on public.negotiation_guidelines;
    drop policy if exists "negotiation guidelines admin delete" on public.negotiation_guidelines;

    drop policy if exists "negotiation guidelines authenticated insert" on public.negotiation_guidelines;
    drop policy if exists "negotiation guidelines authenticated update" on public.negotiation_guidelines;
    drop policy if exists "negotiation guidelines authenticated delete" on public.negotiation_guidelines;

    create policy "negotiation guidelines authenticated insert" on public.negotiation_guidelines
      for insert to authenticated with check (true);
    create policy "negotiation guidelines authenticated update" on public.negotiation_guidelines
      for update to authenticated using (true) with check (true);
    create policy "negotiation guidelines authenticated delete" on public.negotiation_guidelines
      for delete to authenticated using (true);

    grant insert, update, delete on public.negotiation_guidelines to authenticated;
  END IF;
END $$;

-- 4) 조율 계산 이력 삭제도 STAFF 허용
DO $$
BEGIN
  IF to_regclass('public.customer_calculation_snapshots') IS NOT NULL THEN
    alter table public.customer_calculation_snapshots enable row level security;
    drop policy if exists "customer calculation snapshots admin delete" on public.customer_calculation_snapshots;
    drop policy if exists "customer calculation snapshots authenticated delete" on public.customer_calculation_snapshots;
    create policy "customer calculation snapshots authenticated delete" on public.customer_calculation_snapshots
      for delete to authenticated using (true);
    grant delete on public.customer_calculation_snapshots to authenticated;
  END IF;
END $$;

-- 5) 아래 권한은 의도적으로 변경하지 않습니다.
--    settlement_entries : ADMIN 전용
--    change_history     : ADMIN 전용
--    데이터집계          : 앱 라우트에서 ADMIN 전용
--    profiles.role      : 사용자가 자신의 역할을 ADMIN으로 변경하지 못하도록 기존 제한 유지

commit;
notify pgrst, 'reload schema';
