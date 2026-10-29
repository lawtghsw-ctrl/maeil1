-- User-requested independent schedule editing. No historical rows are rewritten.
-- Authentication, customer ownership, atomicity and recovery ledger references remain.
BEGIN;
SET LOCAL lock_timeout='5s';

DROP TRIGGER IF EXISTS trg_dowon_check_payment_balance ON public.payment_schedules;
DROP TRIGGER IF EXISTS trg_force_closed_repayment_zero ON public.repayment_schedules;
DROP INDEX IF EXISTS public.payment_schedules_rescheduled_from_unique_idx;
DROP INDEX IF EXISTS public.payment_schedules_one_active_child_idx;
DROP INDEX IF EXISTS public.repayment_schedules_one_active_child_idx;
CREATE INDEX IF NOT EXISTS repayment_schedules_active_parent_idx ON public.repayment_schedules(rescheduled_from_id)
 WHERE rescheduled_from_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.dowon_guard_allocated_payment()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.recovery_fee_allocations WHERE payment_schedule_id=old.id) THEN
  IF tg_op='DELETE' THEN RAISE EXCEPTION '환수 충당 이력이 있는 일정은 삭제할 수 없습니다'; END IF;
  IF new.deleted_at IS DISTINCT FROM old.deleted_at OR new.customer_id IS DISTINCT FROM old.customer_id
     OR new.rescheduled_from_id IS DISTINCT FROM old.rescheduled_from_id OR new.status='환불'
  THEN RAISE EXCEPTION '환수 충당 이력의 고객·연결·삭제는 환수 관리에서 변경해주세요'; END IF;
 END IF;
 RETURN CASE WHEN tg_op='DELETE' THEN old ELSE new END;
END;$$;

CREATE OR REPLACE FUNCTION public.dowon_save_schedules_flexible(
 p_kind text,p_customer_id uuid,p_rows jsonb,p_carries jsonb,p_delete_ids uuid[]
) RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE item jsonb; part jsonb; parts jsonb; row_id uuid; amount numeric; paid numeric;
        part_amount numeric; changed integer; added integer:=0;
        payment public.payment_schedules%ROWTYPE; repayment public.repayment_schedules%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('payment','repayment') OR p_customer_id IS NULL
    OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_typeof(p_carries) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION '저장 요청 형식을 확인해주세요'; END IF;
 -- Every additional plan must be processed once, rather than silently dropped
 -- or inserted twice because its original row was missing or duplicated.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j
    WHERE nullif(j->>'id','') IS NOT NULL
    GROUP BY nullif(j->>'id','')::uuid HAVING count(*)>1)
 THEN RAISE EXCEPTION '같은 일정이 저장 목록에 중복되어 있습니다'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_carries) carry(key)
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j
      WHERE nullif(j->>'id','')::uuid::text=carry.key))
 THEN RAISE EXCEPTION '추가 일정의 원본 행이 저장 목록에 없습니다'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':'||p_kind,0));
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE nullif(j->>'id','')::uuid=ANY(p_delete_ids))
 THEN RAISE EXCEPTION '같은 일정을 수정과 삭제에 동시에 지정할 수 없습니다'; END IF;

 IF p_kind='payment' THEN
  UPDATE public.payment_schedules SET deleted_at=now()
   WHERE customer_id=p_customer_id AND id=ANY(p_delete_ids) AND deleted_at IS NULL
    AND coalesce(schedule_type,'일반') NOT IN ('환수','추가계약')
    AND source_recovery_id IS NULL AND source_additional_contract_id IS NULL;
 ELSE
  UPDATE public.repayment_schedules SET deleted_at=now()
   WHERE customer_id=p_customer_id AND id=ANY(p_delete_ids) AND deleted_at IS NULL;
 END IF;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>coalesce(cardinality(p_delete_ids),0) THEN RAISE EXCEPTION '삭제 대상의 고객 또는 현재 상태를 확인해주세요'; END IF;

 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  row_id:=nullif(item->>'id','')::uuid;
  amount:=coalesce((item->>CASE WHEN p_kind='payment' THEN 'dueAmount' ELSE 'amount' END)::numeric,0);
  paid:=coalesce((item->>'paidAmount')::numeric,0);
  IF amount<0 OR paid<0 OR amount::text IN ('NaN','Infinity','-Infinity') OR paid::text IN ('NaN','Infinity','-Infinity')
  THEN RAISE EXCEPTION '금액은 0 이상의 유한한 숫자로 입력해주세요'; END IF;

  IF p_kind='payment' THEN
   IF row_id IS NOT NULL THEN
    SELECT * INTO payment FROM public.payment_schedules WHERE id=row_id AND customer_id=p_customer_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION '현재 고객의 납부 일정을 찾지 못했습니다'; END IF;
    IF payment.schedule_type IN ('환수','추가계약') OR payment.source_recovery_id IS NOT NULL OR payment.source_additional_contract_id IS NOT NULL
    THEN RAISE EXCEPTION '자동 생성 일정은 추가계약·환수 관리에서 수정해주세요'; END IF;
    UPDATE public.payment_schedules SET due_date=nullif(item->>'dueDate','')::date,expected_amount=amount,
     paid_date=nullif(item->>'paidDate','')::date,paid_amount=paid,status=coalesce(nullif(item->>'status',''),'예정'),
     payment_method=coalesce(item->>'paymentMethod','계좌이체'),memo=coalesce(item->>'memo','') WHERE id=row_id;
   ELSE
    INSERT INTO public.payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,schedule_type)
    VALUES(p_customer_id,nullif(item->>'dueDate','')::date,amount,nullif(item->>'paidDate','')::date,paid,
     coalesce(nullif(item->>'status',''),'예정'),coalesce(item->>'paymentMethod','계좌이체'),coalesce(item->>'memo',''),'일반');
   END IF;
  ELSE
   IF row_id IS NOT NULL THEN
    SELECT * INTO repayment FROM public.repayment_schedules WHERE id=row_id AND customer_id=p_customer_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION '현재 고객의 상환 일정을 찾지 못했습니다'; END IF;
    UPDATE public.repayment_schedules SET lender_name=coalesce(item->>'lenderName',''),lender_contact_type=nullif(item->>'contactType',''),
     lender_contact_value=nullif(item->>'contactValue',''),repayment_date=nullif(item->>'dueDate','')::date,repayment_amount=amount,
     account_info=coalesce(item->>'account',''),status=coalesce(nullif(item->>'status',''),'예정'),memo=coalesce(item->>'memo',''),
     paid_amount=paid,paid_date=nullif(item->>'paidDate','')::date WHERE id=row_id;
   ELSE
    INSERT INTO public.repayment_schedules(customer_id,lender_name,lender_contact_type,lender_contact_value,repayment_date,
     repayment_amount,account_info,status,memo,paid_amount,paid_date)
    VALUES(p_customer_id,coalesce(item->>'lenderName',''),nullif(item->>'contactType',''),nullif(item->>'contactValue',''),
     nullif(item->>'dueDate','')::date,amount,coalesce(item->>'account',''),coalesce(nullif(item->>'status',''),'예정'),
     coalesce(item->>'memo',''),paid,nullif(item->>'paidDate','')::date);
   END IF;
  END IF;

  -- Add exactly the requested plans. Existing siblings, paid amounts, dates and
  -- parent status do not constrain these amounts. No automatic leftover rows.
  IF row_id IS NOT NULL AND p_carries ? row_id::text THEN
   parts:=p_carries->(row_id::text);
   IF jsonb_typeof(parts)='object' THEN parts:=jsonb_build_array(parts); END IF;
   IF jsonb_typeof(parts) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '추가 일정 형식을 확인해주세요'; END IF;
   IF p_kind='payment' THEN SELECT * INTO payment FROM public.payment_schedules WHERE id=row_id;
   ELSE SELECT * INTO repayment FROM public.repayment_schedules WHERE id=row_id; END IF;
   FOR part IN SELECT value FROM jsonb_array_elements(parts) LOOP
    part_amount:=coalesce((part->>CASE WHEN p_kind='payment' THEN 'dueAmount' ELSE 'amount' END)::numeric,0);
    IF part_amount<0 OR part_amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION '금액은 0 이상의 유한한 숫자로 입력해주세요'; END IF;
    IF p_kind='payment' THEN
     INSERT INTO public.payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,
      schedule_type,root_schedule_id,rescheduled_from_id,reschedule_sequence)
     VALUES(p_customer_id,nullif(part->>'dueDate','')::date,part_amount,NULL,0,'예정',payment.payment_method,
      coalesce(part->>'memo','재조율 일정'),'재약정',coalesce(payment.root_schedule_id,row_id),row_id,coalesce(payment.reschedule_sequence,0)+1);
    ELSE
     INSERT INTO public.repayment_schedules(customer_id,lender_name,lender_contact_type,lender_contact_value,repayment_date,
      repayment_amount,account_info,status,memo,paid_amount,paid_date,rescheduled_from_id,root_schedule_id,reschedule_sequence)
     VALUES(p_customer_id,repayment.lender_name,repayment.lender_contact_type,repayment.lender_contact_value,
      nullif(part->>'dueDate','')::date,part_amount,repayment.account_info,'예정',coalesce(part->>'memo','재조율 일정'),0,NULL,
      row_id,coalesce(repayment.root_schedule_id,row_id),coalesce(repayment.reschedule_sequence,0)+1);
    END IF;
    added:=added+1;
   END LOOP;
  END IF;
 END LOOP;
 RETURN added;
END;$$;
REVOKE ALL ON FUNCTION public.dowon_save_schedules_flexible(text,uuid,jsonb,jsonb,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_save_schedules_flexible(text,uuid,jsonb,jsonb,uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.dowon_save_payment_batch(p_customer_id uuid,p_rows jsonb,p_carries jsonb DEFAULT '{}'::jsonb,p_delete_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS integer LANGUAGE sql SECURITY INVOKER SET search_path=public AS $$
 SELECT public.dowon_save_schedules_flexible('payment',p_customer_id,p_rows,p_carries,p_delete_ids);
$$;
CREATE OR REPLACE FUNCTION public.dowon_save_repayment_batch(p_customer_id uuid,p_rows jsonb,p_carries jsonb DEFAULT '{}'::jsonb,p_delete_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS integer LANGUAGE sql SECURITY INVOKER SET search_path=public AS $$
 SELECT public.dowon_save_schedules_flexible('repayment',p_customer_id,p_rows,p_carries,p_delete_ids);
$$;
REVOKE ALL ON FUNCTION public.dowon_save_payment_batch(uuid,jsonb,jsonb,uuid[]),public.dowon_save_repayment_batch(uuid,jsonb,jsonb,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_save_payment_batch(uuid,jsonb,jsonb,uuid[]),public.dowon_save_repayment_batch(uuid,jsonb,jsonb,uuid[]) TO authenticated;

-- Compatibility for old clients: adding a linked schedule no longer subtracts
-- from a sibling or requires the linked amount to fit the original balance.
CREATE OR REPLACE FUNCTION public.dowon_split_rescheduled_payment(p_source_id uuid,p_new_date date,p_amount numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE src public.payment_schedules%ROWTYPE; parent public.payment_schedules%ROWTYPE; new_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다'; END IF;
 IF p_amount IS NULL OR p_amount<0 OR p_amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION '금액을 확인해주세요'; END IF;
 SELECT * INTO src FROM public.payment_schedules WHERE id=p_source_id AND deleted_at IS NULL;
 IF NOT FOUND OR src.rescheduled_from_id IS NULL THEN RAISE EXCEPTION '연결할 재약정 일정을 찾지 못했습니다'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(src.customer_id::text||':payment',0));
 SELECT * INTO parent FROM public.payment_schedules WHERE id=src.rescheduled_from_id FOR UPDATE;
 IF NOT FOUND OR parent.customer_id IS DISTINCT FROM src.customer_id THEN RAISE EXCEPTION '같은 고객의 원본 일정이 필요합니다'; END IF;
 INSERT INTO public.payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,
  schedule_type,root_schedule_id,rescheduled_from_id,reschedule_sequence)
 VALUES(src.customer_id,p_new_date,p_amount,NULL,0,'예정',src.payment_method,'재조율 일정 추가','재약정',
  coalesce(src.root_schedule_id,parent.id),parent.id,coalesce(src.reschedule_sequence,1)) RETURNING id INTO new_id;
 RETURN new_id;
END;$$;
REVOKE ALL ON FUNCTION public.dowon_split_rescheduled_payment(uuid,date,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_split_rescheduled_payment(uuid,date,numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.dowon_save_payment_with_carry(p_id uuid,p_due_date date,p_expected_amount numeric,p_paid_date date,p_paid_amount numeric,p_status text,p_method text,p_memo text,p_carry_date date,p_carry_memo text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE source_row public.payment_schedules%ROWTYPE; previous_ids uuid[]; child_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다'; END IF;
 SELECT * INTO source_row FROM public.payment_schedules WHERE id=p_id AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION '원본 납부 일정을 찾지 못했습니다'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(source_row.customer_id::text||':payment',0));
 SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO previous_ids FROM public.payment_schedules WHERE rescheduled_from_id=p_id;
 PERFORM public.dowon_save_payment_batch(source_row.customer_id,jsonb_build_array(jsonb_build_object('id',p_id,'dueDate',p_due_date,
  'dueAmount',p_expected_amount,'paidDate',p_paid_date,'paidAmount',p_paid_amount,'status',p_status,'paymentMethod',p_method,'memo',p_memo)),
  jsonb_build_object(p_id::text,jsonb_build_array(jsonb_build_object('dueDate',p_carry_date,
   'dueAmount',greatest(0,coalesce(p_expected_amount,0)-coalesce(p_paid_amount,0)),'memo',p_carry_memo))),'{}'::uuid[]);
 SELECT id INTO child_id FROM public.payment_schedules WHERE rescheduled_from_id=p_id AND NOT(id=ANY(previous_ids)) LIMIT 1;
 RETURN child_id;
END;$$;
REVOKE ALL ON FUNCTION public.dowon_save_payment_with_carry(uuid,date,numeric,date,numeric,text,text,text,date,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_save_payment_with_carry(uuid,date,numeric,date,numeric,text,text,text,date,text) TO authenticated;
COMMIT;
