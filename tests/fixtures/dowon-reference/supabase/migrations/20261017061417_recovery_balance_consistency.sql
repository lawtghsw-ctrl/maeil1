-- Requires the existing V37.11.32 schema/functions. No historical data backfill.
-- Cash and immutable recovery allocations are separate ledgers.
BEGIN;
CREATE OR REPLACE FUNCTION public.dowon_save_payment_batch(p_customer_id uuid,p_rows jsonb,p_carries jsonb DEFAULT '{}'::jsonb,p_delete_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE item jsonb; r public.payment_schedules%ROWTYPE; row_id uuid; child_count int; new_count int:=0; carry_part jsonb; carry_parts jsonb; part_amount numeric; parts_sum numeric;
        amount numeric; paid numeric; due_day date; carry_day date; carry jsonb; allocated numeric:=0;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다'; END IF;
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_typeof(p_carries) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION '입력 형식 오류'; END IF;
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
  IF amount<0 OR paid<0 OR paid>amount OR amount<>trunc(amount) OR paid<>trunc(paid) THEN RAISE EXCEPTION '납부 금액 오류'; END IF;
  IF paid>0 AND nullif(item->>'paidDate','') IS NULL THEN RAISE EXCEPTION '실입금액이 있으면 실제 입금일이 필요합니다'; END IF;
  allocated:=0;
  IF row_id IS NOT NULL THEN
   SELECT * INTO r FROM public.payment_schedules WHERE id=row_id AND customer_id=p_customer_id AND deleted_at IS NULL FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION '원본 납부일정을 찾을 수 없습니다'; END IF;
   IF r.schedule_type IN ('환수','추가계약') OR r.source_recovery_id IS NOT NULL OR r.source_additional_contract_id IS NOT NULL
    THEN RAISE EXCEPTION '시스템 관리 일정 수정 불가'; END IF;
   IF EXISTS (SELECT 1 FROM public.payment_schedules WHERE rescheduled_from_id=row_id AND deleted_at IS NULL)
      AND (r.expected_amount IS DISTINCT FROM amount OR r.paid_amount IS DISTINCT FROM paid OR r.due_date IS DISTINCT FROM due_day)
    THEN RAISE EXCEPTION '이월 후 원본 금액과 예정일은 수정할 수 없습니다'; END IF;
   SELECT coalesce(sum(a.amount),0) INTO allocated FROM public.recovery_fee_allocations a WHERE a.payment_schedule_id=row_id;
   IF paid+allocated>amount THEN RAISE EXCEPTION '실입금과 환수 충당 합계가 예정금액을 초과합니다'; END IF;
   IF paid+allocated<amount AND item->>'status'='완료' THEN RAISE EXCEPTION '잔액이 있는 일정은 완료로 저장할 수 없습니다'; END IF;
   UPDATE public.payment_schedules SET due_date=due_day,expected_amount=amount,
     paid_date=nullif(item->>'paidDate','')::date,paid_amount=paid,status=coalesce(item->>'status','예정'),
     payment_method=coalesce(item->>'paymentMethod','계좌이체'),memo=coalesce(item->>'memo','')
   WHERE id=row_id;
  ELSE
   IF paid<amount AND item->>'status'='완료' THEN RAISE EXCEPTION '잔액이 있는 일정은 완료로 저장할 수 없습니다'; END IF;
   INSERT INTO public.payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,schedule_type)
   VALUES(p_customer_id,due_day,amount,nullif(item->>'paidDate','')::date,paid,coalesce(item->>'status','예정'),
   coalesce(item->>'paymentMethod','계좌이체'),coalesce(item->>'memo',''),'일반');
  END IF;
  IF row_id IS NOT NULL AND p_carries ? row_id::text THEN
   carry_parts:=p_carries->(row_id::text);
   -- 이전 클라이언트의 단일 객체 저장도 계속 허용 (전진 호환).
   IF jsonb_typeof(carry_parts)='object' THEN carry_parts:=jsonb_build_array(carry_parts); END IF;
   IF jsonb_typeof(carry_parts)<>'array' OR jsonb_array_length(carry_parts)=0 THEN RAISE EXCEPTION '재약정 형식 오류'; END IF;
   IF amount<=0 OR paid<0 OR paid+allocated>=amount OR due_day IS NULL
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
   IF parts_sum > (amount-paid-allocated) THEN RAISE EXCEPTION '분할 재약정 합계가 원본 잔액을 초과합니다'; END IF;
   -- 검증 후 같은 트랜잭션에서 모든 후속 일정을 등록.
   FOR carry_part IN SELECT value FROM jsonb_array_elements(carry_parts) LOOP
     INSERT INTO public.payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,
       schedule_type,root_schedule_id,rescheduled_from_id,reschedule_sequence)
     VALUES(p_customer_id,(carry_part->>'dueDate')::date,(carry_part->>'dueAmount')::numeric,NULL,0,'예정',coalesce(item->>'paymentMethod','계좌이체'),
       coalesce(carry_part->>'memo','연체 잔액 재약정'),'재약정',coalesce(r.root_schedule_id,row_id),row_id,coalesce(r.reschedule_sequence,0)+1);
     new_count:=new_count+1;
   END LOOP;
   -- 미배정 잔액은 별도의 연체 후속 일정으로 원금 보존. 실제 입금으로 기록하지 않습니다.
   IF parts_sum < (amount-paid-allocated) THEN
     INSERT INTO public.payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,
       schedule_type,root_schedule_id,rescheduled_from_id,reschedule_sequence)
     VALUES(p_customer_id,due_day,(amount-paid-allocated)-parts_sum,NULL,0,CASE WHEN item->>'status'='예정' AND due_day>=(now() AT TIME ZONE 'Asia/Seoul')::date THEN '예정' ELSE '연체' END,coalesce(item->>'paymentMethod','계좌이체'),
       '재조율 미배정 잔액 · 재약정 가능','재약정',coalesce(r.root_schedule_id,row_id),row_id,coalesce(r.reschedule_sequence,0)+1);
     new_count:=new_count+1;
   END IF;
  END IF;
 END LOOP;
  -- 기존 데이터에 후속 일정이 일부만 등록되어 있는 경우도 저장 가능하게 보정.
  -- 후속 합계가 원본 잔액 이하인 한 부족한 금액만 연체로 새로 연결한다.
  -- p_rows에 포함된 고객의 해당 원본만 처리하며, 이미 보정된 잔액은 다시 생성하지 않는다.
  FOR r IN SELECT parent.* FROM public.payment_schedules parent
       WHERE parent.customer_id=p_customer_id AND parent.deleted_at IS NULL
         AND coalesce(parent.schedule_type,'일반') NOT IN ('환수','추가계약')
         AND parent.source_recovery_id IS NULL AND parent.source_additional_contract_id IS NULL
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE nullif(j.value->>'id','')::uuid=parent.id)
         AND EXISTS (SELECT 1 FROM public.payment_schedules child WHERE child.rescheduled_from_id=parent.id AND child.deleted_at IS NULL)
       FOR UPDATE
  LOOP
    SELECT coalesce(sum(child.expected_amount),0) INTO parts_sum
      FROM public.payment_schedules child WHERE child.rescheduled_from_id=r.id AND child.deleted_at IS NULL;
    SELECT coalesce(sum(a.amount),0) INTO allocated FROM public.recovery_fee_allocations a WHERE a.payment_schedule_id=r.id;
    amount:=r.expected_amount-coalesce(r.paid_amount,0)-allocated;
    IF amount<0 OR parts_sum>amount THEN
      RAISE EXCEPTION '연결된 재약정 금액이 원본 잔액을 초과했습니다 (원본 %, 잔액 %, 후속 %)',r.id,amount,parts_sum;
    END IF;
    IF parts_sum<amount THEN
      INSERT INTO public.payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,
        schedule_type,root_schedule_id,rescheduled_from_id,reschedule_sequence)
      VALUES(r.customer_id,r.due_date,amount-parts_sum,NULL,0,
        CASE WHEN r.status='예정' AND r.due_date>=(now() AT TIME ZONE 'Asia/Seoul')::date THEN '예정' ELSE '연체' END,
        coalesce(r.payment_method,'계좌이체'),'재조율 미배정 잔액 · 기존 후속 일정 보정',
        '재약정',coalesce(r.root_schedule_id,r.id),r.id,coalesce(r.reschedule_sequence,0)+1);
      new_count:=new_count+1;
    END IF;
  END LOOP;
 RETURN new_count;
END;
$$;

REVOKE ALL ON FUNCTION public.dowon_save_payment_batch(uuid,jsonb,jsonb,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_save_payment_batch(uuid,jsonb,jsonb,uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.dowon_guard_allocated_payment()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE used numeric;
BEGIN
 SELECT coalesce(sum(amount),0) INTO used FROM public.recovery_fee_allocations WHERE payment_schedule_id=old.id;
 IF used>0 THEN
  IF tg_op='DELETE' THEN RAISE EXCEPTION '환수 충당 이력이 있는 일정은 삭제할 수 없습니다'; END IF;
  IF new.deleted_at IS DISTINCT FROM old.deleted_at OR new.customer_id IS DISTINCT FROM old.customer_id
     OR new.expected_amount IS DISTINCT FROM old.expected_amount OR new.rescheduled_from_id IS DISTINCT FROM old.rescheduled_from_id
     OR new.status='환불' THEN RAISE EXCEPTION '환수 충당 원본 금액·연결은 변경할 수 없습니다'; END IF;
  IF new.paid_amount IS NULL OR new.paid_amount<0 OR new.paid_amount+used>new.expected_amount
  THEN RAISE EXCEPTION '실입금과 환수 충당 합계가 예정금액을 초과합니다'; END IF;
 END IF;
 RETURN CASE WHEN tg_op='DELETE' THEN old ELSE new END;
END;$$;

-- Serialize direct child inserts against recovery allocation's parent row lock.
CREATE OR REPLACE FUNCTION public.dowon_lock_payment_parent()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE parent public.payment_schedules%ROWTYPE;
BEGIN
  IF tg_op='UPDATE' AND new.rescheduled_from_id IS DISTINCT FROM old.rescheduled_from_id
  THEN RAISE EXCEPTION '기존 재약정 연결은 변경할 수 없습니다'; END IF;
 IF new.rescheduled_from_id IS NOT NULL THEN
  IF new.rescheduled_from_id=new.id THEN RAISE EXCEPTION '자기 자신에게 연결할 수 없습니다'; END IF;
  SELECT * INTO parent FROM public.payment_schedules WHERE id=new.rescheduled_from_id FOR UPDATE;
  IF NOT FOUND OR parent.customer_id IS DISTINCT FROM new.customer_id OR parent.deleted_at IS NOT NULL
  THEN RAISE EXCEPTION '유효한 동일 고객 원본 일정이 필요합니다'; END IF;
 END IF;
 RETURN new;
END;$$;
CREATE TRIGGER trg_dowon_lock_payment_parent BEFORE INSERT OR UPDATE OF rescheduled_from_id,customer_id ON public.payment_schedules
FOR EACH ROW EXECUTE FUNCTION public.dowon_lock_payment_parent();

-- Validate final transaction state: batch repair and split may temporarily differ.
CREATE OR REPLACE FUNCTION public.dowon_check_payment_balance()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE p public.payment_schedules%ROWTYPE; total numeric; used numeric;
BEGIN
 FOR p IN SELECT * FROM public.payment_schedules
  WHERE id IN (new.id,new.rescheduled_from_id) AND deleted_at IS NULL
 LOOP
  SELECT coalesce(sum(expected_amount),0) INTO total FROM public.payment_schedules WHERE rescheduled_from_id=p.id AND deleted_at IS NULL;
  SELECT coalesce(sum(amount),0) INTO used FROM public.recovery_fee_allocations WHERE payment_schedule_id=p.id;
  IF total>p.expected_amount-coalesce(p.paid_amount,0)-used
  THEN RAISE EXCEPTION '후속 일정이 실입금과 충당을 제외한 원본 잔액을 초과합니다'; END IF;
 END LOOP;
 RETURN NULL;
END;$$;
CREATE CONSTRAINT TRIGGER trg_dowon_check_payment_balance AFTER INSERT OR UPDATE ON public.payment_schedules
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.dowon_check_payment_balance();

CREATE OR REPLACE FUNCTION public.dowon_split_rescheduled_payment(p_source_id uuid,p_new_date date,p_amount numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE src public.payment_schedules%ROWTYPE; parent public.payment_schedules%ROWTYPE;
        new_id uuid; current_total numeric; parent_balance numeric;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다'; END IF;
 IF p_new_date IS NULL OR p_amount IS NULL OR p_amount<=0 OR p_amount<>trunc(p_amount)
 THEN RAISE EXCEPTION '새 날짜와 금액을 확인해주세요'; END IF;
 SELECT * INTO src FROM public.payment_schedules WHERE id=p_source_id AND deleted_at IS NULL;
 IF NOT FOUND OR src.rescheduled_from_id IS NULL OR src.schedule_type<>'재약정'
 THEN RAISE EXCEPTION '기존 재약정 일정을 선택해주세요'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(src.customer_id::text || ':payment',0));
 SELECT * INTO src FROM public.payment_schedules WHERE id=p_source_id AND deleted_at IS NULL FOR UPDATE;
 SELECT * INTO parent FROM public.payment_schedules WHERE id=src.rescheduled_from_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR parent.customer_id IS DISTINCT FROM src.customer_id THEN RAISE EXCEPTION '원본을 찾지 못했습니다'; END IF;
 IF EXISTS(SELECT 1 FROM public.payment_schedules WHERE rescheduled_from_id=src.id AND deleted_at IS NULL)
 THEN RAISE EXCEPTION '다음 재약정이 연결된 일정은 분할할 수 없습니다'; END IF;
 IF EXISTS(SELECT 1 FROM public.recovery_fee_allocations WHERE payment_schedule_id=src.id)
 THEN RAISE EXCEPTION '충당 이력이 있는 일정은 금액 분할 대신 잔액 재약정을 사용해주세요'; END IF;
 IF src.expected_amount-p_amount<=0 OR src.expected_amount-p_amount<src.paid_amount
 THEN RAISE EXCEPTION '추가 금액이 기존 일정의 미입금 잔액을 초과합니다'; END IF;
 SELECT coalesce(sum(expected_amount),0) INTO current_total FROM public.payment_schedules
 WHERE rescheduled_from_id=parent.id AND deleted_at IS NULL;
 parent_balance:=parent.expected_amount-coalesce(parent.paid_amount,0)-(SELECT coalesce(sum(a.amount),0) FROM public.recovery_fee_allocations a WHERE a.payment_schedule_id=parent.id);
 IF current_total>parent_balance THEN RAISE EXCEPTION '기존 재약정 합계가 원본 잔액을 초과합니다'; END IF;
 UPDATE public.payment_schedules SET expected_amount=expected_amount-p_amount WHERE id=src.id;
 INSERT INTO public.payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,schedule_type,root_schedule_id,rescheduled_from_id,reschedule_sequence)
 VALUES(src.customer_id,p_new_date,p_amount,NULL,0,'예정',src.payment_method,'기존 재약정 잔액 분할','재약정',coalesce(src.root_schedule_id,parent.id),parent.id,coalesce(src.reschedule_sequence,1)) RETURNING id INTO new_id;
 RETURN new_id;
END;
$$;
REVOKE ALL ON FUNCTION public.dowon_split_rescheduled_payment(uuid,date,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dowon_split_rescheduled_payment(uuid,date,numeric) TO authenticated;

-- A scheduled installment can receive cash before its due date.
create or replace function public.dowon_sync_partial_payment_settlement()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_name text;
begin
  if new.deleted_at is not null or new.status not in ('연체','미납','예정')
     or new.paid_date is null or coalesce(new.paid_amount,0)<=0
     or new.schedule_type='환수' then
    return new;
  end if;
  select name into v_name from public.customers where id=new.customer_id;
  -- 기존 자동연동 행이 존재하면 금액 / 날짜를 갱신 (정산 중복 행 생성 방지)
  insert into public.settlement_entries
  (payment_date,client_name,amount,payment_method,memo,customer_id,
   source_payment_schedule_id,entry_source,entry_type,deleted_at)
  values(new.paid_date,coalesce(v_name,''),new.paid_amount,
         coalesce(nullif(new.payment_method,''),'계좌이체'),
         '[입금/분납 자동연동] 부분납부 실제입금 · '||coalesce(new.memo,''),
         new.customer_id,new.id,'payment','계약',null)
  on conflict (source_payment_schedule_id) where source_payment_schedule_id is not null
    do update set payment_date=excluded.payment_date,client_name=excluded.client_name,
      amount=excluded.amount,payment_method=excluded.payment_method,memo=excluded.memo,
      customer_id=excluded.customer_id,entry_source='payment',entry_type='계약',deleted_at=null;
  return new;
end;$$;

-- Internal audit writer is invoked by owner-executed audit triggers, not clients.
REVOKE EXECUTE ON FUNCTION public.write_change_history(text,text,text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.dowon_lock_payment_parent() FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.dowon_check_payment_balance() FROM PUBLIC,anon,authenticated;
COMMIT;
