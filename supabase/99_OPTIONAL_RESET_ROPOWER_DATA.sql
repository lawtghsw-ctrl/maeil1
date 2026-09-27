-- ============================================================================
-- [위험/선택] 로파워 복제 프로젝트의 업무 데이터만 전부 비우는 SQL
-- ============================================================================
-- 반드시 '새 로파워용 Supabase 프로젝트'인지 확인한 뒤에만 실행하세요.
-- 기존 도원/태광 운영 DB에는 절대로 실행하지 마세요.
-- Auth 사용자(profiles)는 유지합니다. 업무 데이터만 초기화합니다.

begin;
truncate table
  public.board_attachments,
  public.board_posts,
  public.change_history,
  public.customer_calculation_snapshots,
  public.customer_calculator_items,
  public.negotiation_guidelines,
  public.lender_customers,
  public.lender_contacts,
  public.recoveries,
  public.additional_contracts,
  public.settlement_entries,
  public.repayment_schedules,
  public.payment_schedules,
  public.meta_leads,
  public.lenders,
  public.customers
restart identity cascade;
commit;
