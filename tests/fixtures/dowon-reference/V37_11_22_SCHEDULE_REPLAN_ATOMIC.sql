-- V37.11.22: 원본 예정 / 연체 일정 통합 재조율 허용. 기존 데이터 변경 없음.
-- 두 원자적 함수만 갱신하며 모든 금액 일치 검증 및 중복 후속 생성 차단 유지.
-- 반드시 운영 DB 백업 및 스테이징 테스트 후 실행.

-- V37.11.7 / 전액·부분 미납의 1:N 분할 재약정 (기존 원자적 RPC 보존)
-- Supabase SQL Editor에서 1회 실행. 기존 데이터를 UPDATE/DELETE하지 않습니다.
-- 기존 V37.9_ATOMIC_BATCH_CARRY.sql이 적용되어 있다는 전제입니다.
-- 운영 반영 전 함수/DB 백업 및 테스트 환경 검증을 권장합니다.
BEGIN;
CREATE OR REPLACE FUNCTION public.dowon_save_payment_batch(p_customer_id uuid,p_rows jsonb,p_carries jsonb DEFAULT '{}'::jsonb,p_delete_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE item jsonb; r public.payment_schedules%ROWTYPE; row_id uuid; child_count int; new_count int:=0; carry_part jsonb; carry_parts jsonb; part_amount numeric; parts_sum numeric;
        amount numeric; paid numeric; due_day date; carry_day date; carry jsonb;
BEGIN
 IF jsonb_typeof(p_rows) <> 'array' OR jsonb_typeof(p_carries) <> 'object' THEN RAISE EXCEPTION '입력 형식 오류'; END IF;
 -- 같은 고객을 대상으로 한 동시 일괄 저장은 반드시 직렬 실행.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text || ':payment',0));
 FOR r IN SELECT * FROM public.payment_schedules WHERE customer_id=p_customer_id AND deleted_at IS NULL
       AND id=ANY(p_delete_ids) AND schedule_type NOT IN ('환수','추가계약')
       AND source_recovery_id IS NULL AND source_additional_contract_id IS NULL FOR UPDATE
 LOOP
  IF EXISTS(SELECT 1 FROM public.payment_schedules WHERE rescheduled_from_id=r.id AND deleted_at IS NULL)
   THEN RAISE EXCEPTION '후속 이월 일정이 있는 원본은 삭제할 수 없습니다'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE nullif(j.value->>'id','')::uuid=r.id)
   THEN RAISE EXCEPTION '수정과 삭제 대상으로 동시에 지정된 납부 일정'; END IF;
  UPDATE public.payment_schedules SET deleted_at=now() WHERE id=r.id;
 END LOOP;
 IF (SELECT count(*) FROM public.payment_schedules WHERE customer_id=p_customer_id AND id=ANY(p_delete_ids)) <> cardinality(p_delete_ids)
  THEN RAISE EXCEPTION '삭제 대상이 다른 고객이거나 존재하지 않습니다'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  row_id:=nullif(item->>'id','')::uuid;
  amount:=coalesce((item->>'dueAmount')::numeric,0);
  paid:=coalesce((item->>'paidAmount')::numeric,0);
  due_day:=nullif(item->>'dueDate','')::date;
  IF amount<0 OR paid<0 OR paid>amount THEN RAISE EXCEPTION '납부 금액 오류'; END IF;
  IF paid>0 AND paid<amount AND item->>'status'='완료' THEN RAISE EXCEPTION '부분납부는 완료 상태로 저장할 수 없습니다'; END IF;
  IF row_id IS NOT NULL THEN
   SELECT * INTO r FROM public.payment_schedules WHERE id=row_id AND customer_id=p_customer_id AND deleted_at IS NULL FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION '원본 납부일정을 찾을 수 없습니다'; END IF;
   IF r.schedule_type IN ('환수','추가계약') OR r.source_recovery_id IS NOT NULL OR r.source_additional_contract_id IS NOT NULL
    THEN RAISE EXCEPTION '시스템 관리 일정 수정 불가'; END IF;
   IF EXISTS (SELECT 1 FROM public.payment_schedules WHERE rescheduled_from_id=row_id AND deleted_at IS NULL)
      AND (r.expected_amount IS DISTINCT FROM amount OR r.paid_amount IS DISTINCT FROM paid OR r.due_date IS DISTINCT FROM due_day)
    THEN RAISE EXCEPTION '이월 후 원본 금액과 예정일은 수정할 수 없습니다'; END IF;
   UPDATE public.payment_schedules SET due_date=due_day,expected_amount=amount,
     paid_date=nullif(item->>'paidDate','')::date,paid_amount=paid,status=coalesce(item->>'status','예정'),
     payment_method=coalesce(item->>'paymentMethod','계좌이체'),memo=coalesce(item->>'memo','')
   WHERE id=row_id;
  ELSE
   INSERT INTO public.payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,schedule_type)
   VALUES(p_customer_id,due_day,amount,nullif(item->>'paidDate','')::date,paid,coalesce(item->>'status','예정'),
   coalesce(item->>'paymentMethod','계좌이체'),coalesce(item->>'memo',''),'일반');
  END IF;
  IF row_id IS NOT NULL AND p_carries ? row_id::text THEN
   carry_parts:=p_carries->(row_id::text);
   -- 이전 클라이언트의 단일 객체 저장도 계속 허용 (전진 호환).
   IF jsonb_typeof(carry_parts)='object' THEN carry_parts:=jsonb_build_array(carry_parts); END IF;
   IF jsonb_typeof(carry_parts)<>'array' OR jsonb_array_length(carry_parts)=0 THEN RAISE EXCEPTION '재약정 형식 오류'; END IF;
   IF amount<=0 OR paid<0 OR paid>=amount OR due_day IS NULL
      OR coalesce(item->>'status','') NOT IN ('연체','미납','예정')
      OR (paid=0 AND nullif(item->>'paidDate','') IS NOT NULL)
      OR (paid>0 AND nullif(item->>'paidDate','') IS NULL)
   THEN RAISE EXCEPTION '연체/부분납부 원본 상태가 유효하지 않습니다'; END IF;
   IF EXISTS(SELECT 1 FROM public.payment_schedules WHERE rescheduled_from_id=row_id AND deleted_at IS NULL)
   THEN RAISE EXCEPTION '이미 후속 분납일정이 존재합니다'; END IF;
   parts_sum:=0;
   FOR carry_part IN SELECT value FROM jsonb_array_elements(carry_parts) LOOP
     carry_day:=nullif(carry_part->>'dueDate','')::date;
     part_amount:=nullif(carry_part->>'dueAmount','')::numeric;
     IF carry_day IS NULL OR part_amount IS NULL OR part_amount<=0
       THEN RAISE EXCEPTION '분할 재약정의 날짜 또는 금액이 유효하지 않습니다'; END IF;
     parts_sum:=parts_sum+part_amount;
   END LOOP;
   IF parts_sum IS DISTINCT FROM (amount-paid) THEN RAISE EXCEPTION '분할 재약정 합계가 잔액과 일치하지 않습니다'; END IF;
   -- 검증 후 같은 트랜잭션에서 모든 후속 일정을 등록.
   FOR carry_part IN SELECT value FROM jsonb_array_elements(carry_parts) LOOP
     INSERT INTO public.payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,
       schedule_type,root_schedule_id,rescheduled_from_id,reschedule_sequence)
     VALUES(p_customer_id,(carry_part->>'dueDate')::date,(carry_part->>'dueAmount')::numeric,NULL,0,'예정',coalesce(item->>'paymentMethod','계좌이체'),
       coalesce(carry_part->>'memo','연체 잔액 재약정'),'재약정',coalesce(r.root_schedule_id,row_id),row_id,coalesce(r.reschedule_sequence,0)+1);
     new_count:=new_count+1;
   END LOOP;
  END IF;
 END LOOP;
 RETURN new_count;
END;
$$;

COMMIT;

-- 도원 V37.11.10 업체 상환 연체/부분상환 1:N 재약정. 기존 기록 일괄 수정 없음.
-- V37.9 원자적 저장 함수가 설치되어 있어야 합니다.
-- 운영 DB 백업 및 테스트 환경 검증 후 적용하십시오.
BEGIN;
CREATE OR REPLACE FUNCTION public.dowon_save_repayment_batch(p_customer_id uuid,p_rows jsonb,p_carries jsonb DEFAULT '{}'::jsonb,p_delete_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE item jsonb; r public.repayment_schedules%ROWTYPE; row_id uuid; n_added int:=0;
 amount numeric; paid numeric; due_day date; carry_day date; carry jsonb; carry_parts jsonb; carry_part jsonb; part_amount numeric; parts_sum numeric;
BEGIN
 IF jsonb_typeof(p_rows)<>'array' OR jsonb_typeof(p_carries)<>'object' THEN RAISE EXCEPTION '입력 형식 오류'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text || ':repayment',0));
 FOR r IN SELECT * FROM public.repayment_schedules WHERE customer_id=p_customer_id
       AND deleted_at IS NULL AND id=ANY(p_delete_ids) FOR UPDATE LOOP
  IF EXISTS(SELECT 1 FROM public.repayment_schedules WHERE rescheduled_from_id=r.id AND deleted_at IS NULL)
   THEN RAISE EXCEPTION '이월 원본 일정 삭제 불가'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE nullif(j.value->>'id','')::uuid=r.id)
   THEN RAISE EXCEPTION '수정과 삭제 대상이 중복된 상환 일정'; END IF;
  UPDATE public.repayment_schedules SET deleted_at=now() WHERE id=r.id;
 END LOOP;
 IF (SELECT count(*) FROM public.repayment_schedules WHERE customer_id=p_customer_id AND id=ANY(p_delete_ids)) <> cardinality(p_delete_ids)
  THEN RAISE EXCEPTION '삭제 대상이 다른 고객이거나 존재하지 않습니다'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  row_id:=nullif(item->>'id','')::uuid;amount:=coalesce((item->>'amount')::numeric,0);
  paid:=coalesce((item->>'paidAmount')::numeric,0);
  due_day:=nullif(item->>'dueDate','')::date;
  IF amount<0 OR paid<0 OR paid>amount THEN RAISE EXCEPTION '상환 금액 오류'; END IF;
  IF paid>0 AND paid<amount AND item->>'status' IN ('완료','상환완료') THEN RAISE EXCEPTION '부분상환은 완료 상태로 저장할 수 없습니다'; END IF;
  IF row_id IS NOT NULL THEN
   SELECT * INTO r FROM public.repayment_schedules WHERE id=row_id AND customer_id=p_customer_id AND deleted_at IS NULL FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION '원본 상환일정을 찾을 수 없습니다'; END IF;
   IF EXISTS(SELECT 1 FROM public.repayment_schedules WHERE rescheduled_from_id=row_id AND deleted_at IS NULL)
     AND (r.repayment_amount IS DISTINCT FROM amount OR r.paid_amount IS DISTINCT FROM paid OR r.repayment_date IS DISTINCT FROM due_day)
     THEN RAISE EXCEPTION '이월 후 원본 상환금액 및 날짜 수정 불가'; END IF;
   UPDATE public.repayment_schedules SET lender_name=coalesce(item->>'lenderName',''),
     lender_contact_type=nullif(item->>'contactType',''),lender_contact_value=nullif(item->>'contactValue',''),
     repayment_date=due_day,repayment_amount=amount,account_info=coalesce(item->>'account',''),
     status=coalesce(item->>'status','예정'),memo=coalesce(item->>'memo',''),
     paid_amount=paid,paid_date=nullif(item->>'paidDate','')::date WHERE id=row_id;
  ELSE
   INSERT INTO public.repayment_schedules(customer_id,lender_name,lender_contact_type,lender_contact_value,
      repayment_date,repayment_amount,account_info,status,memo,paid_amount,paid_date)
   VALUES(p_customer_id,coalesce(item->>'lenderName',''),nullif(item->>'contactType',''),nullif(item->>'contactValue',''),
      due_day,amount,coalesce(item->>'account',''),coalesce(item->>'status','예정'),coalesce(item->>'memo',''),paid,nullif(item->>'paidDate','')::date);
  END IF;
  IF row_id IS NOT NULL AND p_carries ? row_id::text THEN
   carry_parts:=p_carries->(row_id::text);
   IF jsonb_typeof(carry_parts)='object' THEN carry_parts:=jsonb_build_array(carry_parts); END IF;
   IF jsonb_typeof(carry_parts)<>'array' OR jsonb_array_length(carry_parts)=0 THEN RAISE EXCEPTION '재약정 입력 형식 오류'; END IF;
   IF amount<=0 OR paid<0 OR paid>=amount OR due_day IS NULL OR coalesce(item->>'status','') NOT IN ('연체','예정')
     OR (paid>0 AND nullif(item->>'paidDate','') IS NULL)
     OR (paid=0 AND nullif(item->>'paidDate','') IS NOT NULL)
     THEN RAISE EXCEPTION '연체 또는 부분상환 원본 상태 오류'; END IF;
   IF EXISTS(SELECT 1 FROM public.repayment_schedules WHERE rescheduled_from_id=row_id AND deleted_at IS NULL)
     THEN RAISE EXCEPTION '이미 후속 상환일정이 존재합니다'; END IF;
   parts_sum:=0;
   FOR carry_part IN SELECT value FROM jsonb_array_elements(carry_parts) LOOP
     carry_day:=nullif(carry_part->>'dueDate','')::date;
     part_amount:=nullif(carry_part->>'amount','')::numeric;
     IF carry_day IS NULL OR part_amount IS NULL OR part_amount<=0
       THEN RAISE EXCEPTION '재약정 날짜 또는 금액 오류'; END IF;
     parts_sum:=parts_sum+part_amount;
   END LOOP;
   IF parts_sum IS DISTINCT FROM (amount-paid) THEN RAISE EXCEPTION '상환 재약정 분할 합계와 미납 잔액 불일치'; END IF;
   FOR carry_part IN SELECT value FROM jsonb_array_elements(carry_parts) LOOP
     INSERT INTO public.repayment_schedules(customer_id,lender_name,lender_contact_type,lender_contact_value,repayment_date,
       repayment_amount,account_info,status,memo,paid_amount,paid_date,rescheduled_from_id,root_schedule_id,reschedule_sequence)
     VALUES(p_customer_id,r.lender_name,r.lender_contact_type,r.lender_contact_value,(carry_part->>'dueDate')::date,
       (carry_part->>'amount')::numeric,r.account_info,'예정',coalesce(carry_part->>'memo','연체 잔액 재약정'),
       0,NULL,row_id,coalesce(r.root_schedule_id,row_id),coalesce(r.reschedule_sequence,0)+1);
     n_added:=n_added+1;
   END LOOP;
  END IF;
 END LOOP;
 RETURN n_added;
END;
$$;
REVOKE ALL ON FUNCTION public.dowon_save_repayment_batch(uuid,jsonb,jsonb,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dowon_save_repayment_batch(uuid,jsonb,jsonb,uuid[]) TO authenticated;
COMMIT;

-- 미분배 환수 확정 시 50% 성공보수율을 DB에서 검증합니다. 기존 확정분 재계산 없음.
create or replace function public.dowon_apply_recovery_split(p_recovery_id uuid,p_success_fee numeric,p_allocations jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare v_r public.recoveries%rowtype; v_item jsonb;v_id uuid;v_amount numeric;v_total numeric:=0;v_current numeric;v_used numeric;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다';end if;
 select * into v_r from public.recoveries where id=p_recovery_id and deleted_at is null for update;
 if not found then raise exception '환수 내역을 찾을 수 없습니다'; end if;
 if exists(select 1 from public.recovery_fee_splits where recovery_id=p_recovery_id) then raise exception '이미 분배된 환수금입니다. 기존 분배는 변경할 수 없습니다';end if;
 if p_success_fee is null or p_success_fee<0 or p_success_fee<>trunc(p_success_fee) then raise exception '성공보수 금액 오류';end if;
 if p_success_fee<>trunc(v_r.amount/2) then raise exception '신규 환수의 성공보수는 실제 입금액의 50%%입니다';end if;
 if jsonb_typeof(p_allocations) <> 'array' then raise exception '분납 충당 목록 형식 오류';end if;
 if jsonb_array_length(p_allocations)>100 then raise exception '충당 건수가 너무 많습니다';end if;
 if (select count(*) from jsonb_array_elements(p_allocations) x)<>(select count(distinct x->>'paymentId') from jsonb_array_elements(p_allocations) x) then raise exception '중복 분납 일정이 있습니다';end if;
 for v_item in select value from jsonb_array_elements(p_allocations) loop
  v_id:=(v_item->>'paymentId')::uuid;v_amount:=(v_item->>'amount')::numeric;
  if v_amount is null or v_amount<=0 or v_amount<>trunc(v_amount) then raise exception '충당금액은 양의 정수여야 합니다';end if;
  select greatest(0,expected_amount-coalesce(paid_amount,0)) into v_current
   from public.payment_schedules where id=v_id and customer_id=v_r.customer_id and deleted_at is null
   and coalesce(schedule_type,'일반') not in ('환수','추가계약') and status <> '환불' for update;
  if not found then raise exception '선택한 분납 일정이 유효하지 않습니다';end if;
  -- 재약정 후속이 존재하는 원본은 이중 충당 방지를 위해 제외
  if exists(select 1 from public.payment_schedules where rescheduled_from_id=v_id and deleted_at is null) then raise exception '재약정 후속이 있는 원본은 충당할 수 없습니다';end if;
  select coalesce(sum(amount),0) into v_used from public.recovery_fee_allocations where payment_schedule_id=v_id;
  if v_amount>v_current-v_used then raise exception '해당 일정의 충당 가능 잔액을 초과했습니다';end if;
  v_total:=v_total+v_amount;
 end loop;
 if p_success_fee+v_total>v_r.amount then raise exception '성공보수와 분납 충당액이 환수금액을 초과했습니다';end if;
 insert into public.recovery_fee_splits(recovery_id,customer_id,success_fee,applied_fee,refund_due) values(p_recovery_id,v_r.customer_id,p_success_fee,v_total,v_r.amount-p_success_fee-v_total);
 for v_item in select value from jsonb_array_elements(p_allocations) loop
  insert into public.recovery_fee_allocations(recovery_id,customer_id,payment_schedule_id,amount)
  values(p_recovery_id,v_r.customer_id,(v_item->>'paymentId')::uuid,(v_item->>'amount')::numeric);
 end loop;
end;$$;
revoke all on function public.dowon_apply_recovery_split(uuid,numeric,jsonb) from public,anon;
grant execute on function public.dowon_apply_recovery_split(uuid,numeric,jsonb) to authenticated;

