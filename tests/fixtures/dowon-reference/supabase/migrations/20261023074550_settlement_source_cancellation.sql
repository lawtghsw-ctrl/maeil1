-- New confirmations cancel the underlying transaction atomically. Existing
-- user_deleted rows remain historical display decisions and are never replayed.
BEGIN;
-- A refund cancellation retains the immutable original bank fact. Existing
-- hidden statements keep their old display meaning; neither flag is replayed.
ALTER TABLE public.recovery_refunds ADD COLUMN cancelled_at timestamptz;
CREATE FUNCTION public.dowon_guard_refund_cash_cancellation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE parent public.recoveries%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '반환 원본은 삭제할 수 없습니다. 취소 이력으로 보존해주세요';END IF;
 IF TG_OP='INSERT' THEN
  IF new.cancelled_at IS NOT NULL THEN RAISE EXCEPTION '취소된 반환 원본을 새로 등록할 수 없습니다';END IF;
  RETURN new;
 END IF;
 IF to_jsonb(new)-ARRAY['settlement_hidden','cancelled_at'] IS DISTINCT FROM to_jsonb(old)-ARRAY['settlement_hidden','cancelled_at']
  THEN RAISE EXCEPTION '반환 금액·날짜·수취인·원본 연결은 변경할 수 없습니다';END IF;
 IF new.cancelled_at IS DISTINCT FROM old.cancelled_at THEN
  IF old.cancelled_at IS NOT NULL OR new.cancelled_at IS NULL THEN RAISE EXCEPTION '취소된 반환 기록은 복구할 수 없습니다. 새 반환 거래로 등록해주세요';END IF;
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다';END IF;
  -- Direct column updates already hold the child row. Never wait for a parent
  -- held by the canonical parent-first RPC (which would create a lock cycle).
  SELECT * INTO parent FROM public.recoveries WHERE id=old.recovery_id AND deleted_at IS NULL FOR UPDATE NOWAIT;
  IF NOT FOUND OR parent.accounting_version<>1 OR parent.customer_id IS DISTINCT FROM old.customer_id
   THEN RAISE EXCEPTION '신형 환수의 별도 반환은 환수 등록에서 확인해주세요';END IF;
  new.cancelled_at:=clock_timestamp();
 END IF;
 RETURN new;
END;$$;
CREATE TRIGGER trg_dowon_refund_cash_cancellation BEFORE INSERT OR UPDATE OR DELETE ON public.recovery_refunds
 FOR EACH ROW EXECUTE FUNCTION public.dowon_guard_refund_cash_cancellation();
REVOKE ALL ON FUNCTION public.dowon_guard_refund_cash_cancellation() FROM PUBLIC,anon,authenticated;
GRANT UPDATE(cancelled_at) ON public.recovery_refunds TO authenticated;

-- Audit-only privilege boundary, matching the application's existing audit
-- triggers. This function cannot write financial tables or accept SQL inputs.
CREATE FUNCTION public.dowon_audit_refund_cash_cancellation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor uuid:=auth.uid();request_id uuid;proof_key text;
BEGIN
 IF TG_OP<>'UPDATE' OR old.cancelled_at IS NOT NULL OR new.cancelled_at IS NULL OR actor IS NULL
  THEN RAISE EXCEPTION '유효한 반환 취소 전이와 로그인 정보가 필요합니다';END IF;
 request_id:=coalesce(nullif(current_setting('dowon.settlement_cancel_request',true),'')::uuid,gen_random_uuid());
 proof_key:='settlement_source_cancellation:'||actor::text||':refund:'||new.id::text||':'||request_id::text;
 -- A duplicate key fails the cancellation atomically; never discard an audit.
 INSERT INTO public.change_history(category,action,table_name,record_id,actor_id,actor_name,source,old_data,new_data,dedupe_key)
  VALUES('환수 등록','수정','recovery_refunds',new.id::text,actor,'사용자','settlement_source_cancellation',to_jsonb(old),to_jsonb(new),proof_key);
 RETURN new;
END;$$;
CREATE TRIGGER trg_dowon_refund_cash_cancellation_audit AFTER UPDATE ON public.recovery_refunds
 FOR EACH ROW WHEN (old.cancelled_at IS NULL AND new.cancelled_at IS NOT NULL)
 EXECUTE FUNCTION public.dowon_audit_refund_cash_cancellation();
REVOKE ALL ON FUNCTION public.dowon_audit_refund_cash_cancellation() FROM PUBLIC,anon,authenticated;

-- Preserve the established writers and their ACLs. Change only each audited
-- refund predicate; a different installed definition aborts this migration.
DO $$
DECLARE signature text;old_predicate text;new_predicate text;definition text;matches integer;
BEGIN
 FOR signature,old_predicate,new_predicate IN SELECT * FROM (VALUES
  ('public.dowon_prepare_recovery_details()','FROM recovery_refunds WHERE recovery_id=new.id','FROM recovery_refunds WHERE recovery_id=new.id AND cancelled_at IS NULL'),
  ('public.sync_recovery_payment()','FROM recovery_refunds WHERE recovery_id=new.id','FROM recovery_refunds WHERE recovery_id=new.id AND cancelled_at IS NULL'),
  ('public.dowon_save_recovery_batch_v2(uuid,jsonb,uuid[],uuid,jsonb)','FROM recovery_refunds WHERE recovery_id=row_id)','FROM recovery_refunds WHERE recovery_id=row_id AND cancelled_at IS NULL)')
 ) predicates LOOP
  IF to_regprocedure(signature) IS NULL THEN RAISE EXCEPTION 'Required recovery writer is missing: %',signature;END IF;
  definition:=pg_get_functiondef(to_regprocedure(signature));
  matches:=(length(definition)-length(replace(definition,old_predicate,'')))/length(old_predicate);
  IF matches<>1 THEN RAISE EXCEPTION 'Unexpected installed refund predicate in %; migration rolled back',signature;END IF;
  EXECUTE replace(definition,old_predicate,new_predicate);
 END LOOP;
END;$$;

CREATE FUNCTION public.dowon_cancel_settlement(p_id uuid,p_expected jsonb,p_request_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE
 v_actor uuid:=auth.uid();v_input jsonb;v_previous dowon_private.save_requests%ROWTYPE;v_inner_key uuid;
 v_statement public.settlement_entries%ROWTYPE;v_payment public.payment_schedules%ROWTYPE;
 v_recovery public.recoveries%ROWTYPE;v_additional public.additional_contracts%ROWTYPE;
 v_refund public.recovery_refunds%ROWTYPE;v_refund_before jsonb;v_refund_after jsonb;v_parent_snapshot jsonb;v_client_name text;v_prior_request text;
 v_customer uuid;v_kind text;v_locked_kind text;v_actual jsonb;v_payment_snapshot jsonb:='null';v_source_snapshot jsonb:='null';
 v_versions jsonb;v_payload jsonb;v_returns numeric;v_source_before jsonb;v_source_after jsonb;
BEGIN
 IF v_actor IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다';END IF;
 IF p_id IS NULL OR p_request_key IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
  OR coalesce(p_expected->>'kind','') NOT IN ('manual','payment','recovery','additional','recovery_return','refund')
  THEN RAISE EXCEPTION '삭제 요청 정보를 새로 불러온 뒤 다시 확인해주세요';END IF;
 v_input:=jsonb_build_object('operation','cancel_settlement','version',1,'id',p_id,'expected',p_expected);
 PERFORM pg_advisory_xact_lock(hashtextextended(v_actor::text||':'||p_request_key::text,0));
 SELECT * INTO v_previous FROM dowon_private.save_requests WHERE actor_id=v_actor AND request_key=p_request_key;
 IF FOUND THEN
  IF v_previous.payload IS DISTINCT FROM v_input THEN RAISE EXCEPTION '동일 요청 키의 내용이 변경되었습니다';END IF;
  RETURN jsonb_build_object('id',p_id,'kind',p_expected->>'kind','cancelled',true);
 END IF;
 IF p_expected->>'kind'='refund' THEN
  SELECT * INTO v_refund FROM public.recovery_refunds WHERE id=p_id;
  IF NOT FOUND OR v_refund.cancelled_at IS NOT NULL OR v_refund.settlement_hidden
   THEN RAISE EXCEPTION '이미 취소·미표기되었거나 변경된 반환 기록입니다. 새로고침해주세요';END IF;
  v_customer:=v_refund.customer_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_customer::text||':payment',0));
  PERFORM id FROM public.customers WHERE id=v_customer AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '반환 고객 원본을 새로 불러온 뒤 확인해주세요';END IF;
  SELECT * INTO v_recovery FROM public.recoveries WHERE id=v_refund.recovery_id AND customer_id=v_customer AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_recovery.accounting_version<>1 THEN RAISE EXCEPTION '신형 환수의 별도 반환은 환수 등록에서 확인해주세요';END IF;
  SELECT * INTO v_refund FROM public.recovery_refunds WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_refund.cancelled_at IS NOT NULL OR v_refund.settlement_hidden OR v_refund.amount<=0
   OR v_refund.customer_id IS DISTINCT FROM v_customer OR v_refund.recovery_id IS DISTINCT FROM v_recovery.id
   THEN RAISE EXCEPTION '다른 화면에서 반환 원본이 변경되었습니다. 새로고침해주세요';END IF;
  SELECT coalesce(nullif(name,''),'-') INTO v_client_name FROM public.customers WHERE id=v_customer;
  v_parent_snapshot:=jsonb_build_object('id',v_recovery.id,'customer_id',v_recovery.customer_id,'row_version',v_recovery.row_version,
   'accounting_version',v_recovery.accounting_version,'recovery_date',v_recovery.recovery_date,'lender_name',coalesce(v_recovery.lender_name,''),
   'depositor_name',coalesce(v_recovery.depositor_name,''),'amount',v_recovery.amount,'payment_method',coalesce(nullif(v_recovery.payment_method,''),'계좌이체'),
   'memo',coalesce(v_recovery.memo,''),'installment_amount',coalesce(v_recovery.installment_amount,0),
   'client_return_amount',coalesce(v_recovery.client_return_amount,0),'success_fee_amount',coalesce(v_recovery.success_fee_amount,0));
  v_actual:=jsonb_build_object('kind','refund','payment',NULL,'recovery',v_parent_snapshot,
   'source',jsonb_build_object('id',v_refund.id,'recovery_id',v_refund.recovery_id,'customer_id',v_refund.customer_id,
    'refund_date',v_refund.refund_date,'amount',v_refund.amount,'recipient_name',coalesce(v_refund.recipient_name,''),
    'payment_method',coalesce(nullif(v_refund.payment_method,''),'계좌이체'),'memo',coalesce(v_refund.memo,''),'settlement_hidden',v_refund.settlement_hidden),
   'settlement',jsonb_build_object('id','refund:'||v_refund.id::text,'amount',-v_refund.amount,'payment_date',v_refund.refund_date,
    'client_name',coalesce(v_client_name,'-'),'payment_method',coalesce(nullif(v_refund.payment_method,''),'계좌이체'),
    'memo','환수금 고객 반환 [수취인:'||v_refund.recipient_name||']'||CASE WHEN v_refund.memo<>'' THEN ' · '||v_refund.memo ELSE '' END,
    'entry_source','refund','entry_type','반환','customer_id',v_customer,'source_payment_schedule_id',NULL,'source_recovery_id',NULL,'recovery_component',NULL));
  IF v_actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION '반환 금액·날짜·수취인·환수 버전이 변경되었습니다. 새로고침해주세요';END IF;
  v_refund_before:=to_jsonb(v_refund);v_source_before:=to_jsonb(v_recovery);
  v_prior_request:=current_setting('dowon.settlement_cancel_request',true);
  PERFORM set_config('dowon.settlement_cancel_request',p_request_key::text,true);
  UPDATE public.recovery_refunds SET cancelled_at=clock_timestamp() WHERE id=p_id AND cancelled_at IS NULL RETURNING to_jsonb(recovery_refunds) INTO v_refund_after;
  PERFORM set_config('dowon.settlement_cancel_request',coalesce(v_prior_request,''),true);
  SELECT to_jsonb(r) INTO v_source_after FROM public.recoveries r WHERE id=v_recovery.id;
  IF v_refund_after IS NULL OR v_refund_after->>'cancelled_at' IS NULL
   OR v_refund_after-'cancelled_at' IS DISTINCT FROM v_refund_before-'cancelled_at'
   OR v_source_after IS DISTINCT FROM v_source_before THEN
   RAISE EXCEPTION '반환 취소의 원본 보존을 확인하지 못해 전체 변경을 취소했습니다';END IF;
  INSERT INTO dowon_private.save_requests(actor_id,request_key,payload,result) VALUES(v_actor,p_request_key,v_input,1);
  RETURN jsonb_build_object('id',p_id,'kind','refund','cancelled',true);
 END IF;
 IF EXISTS(SELECT 1 FROM public.recovery_refunds WHERE id=p_id) THEN RAISE EXCEPTION '반환 거래 종류를 새로 불러온 뒤 확인해주세요';END IF;
 SELECT * INTO v_statement FROM public.settlement_entries WHERE id=p_id;
 IF NOT FOUND OR v_statement.deleted_at IS NOT NULL OR v_statement.user_deleted
  THEN RAISE EXCEPTION '이미 삭제되었거나 변경된 정산 내역입니다. 새로고침해주세요';END IF;

 -- Read only enough provenance to choose the SAME customer advisory lock as
 -- existing schedule/recovery writers. Recheck everything after row locking.
 IF coalesce(v_statement.entry_source,'manual')='manual' THEN
  IF v_statement.source_payment_schedule_id IS NOT NULL OR v_statement.source_recovery_id IS NOT NULL OR v_statement.recovery_component IS NOT NULL
   THEN RAISE EXCEPTION '원본이 연결된 수기 내역은 전용 원본 관리에서 확인해주세요';END IF;
  v_kind:='manual';
 ELSIF v_statement.entry_source='payment' AND v_statement.source_payment_schedule_id IS NOT NULL THEN
  SELECT * INTO v_payment FROM public.payment_schedules WHERE id=v_statement.source_payment_schedule_id;
  IF NOT FOUND THEN RAISE EXCEPTION '연결된 입금 원본을 찾지 못했습니다. 원본 관리에서 확인해주세요';END IF;
  v_customer:=v_payment.customer_id;
  v_kind:=CASE WHEN v_payment.source_recovery_id IS NOT NULL THEN 'recovery'
   WHEN v_payment.source_additional_contract_id IS NOT NULL THEN 'additional' ELSE 'payment' END;
 ELSIF v_statement.entry_source='recovery' AND v_statement.source_recovery_id IS NOT NULL AND v_statement.recovery_component='client_return' THEN
  SELECT * INTO v_recovery FROM public.recoveries WHERE id=v_statement.source_recovery_id;
  IF NOT FOUND THEN RAISE EXCEPTION '연결된 환수 원본을 찾지 못했습니다. 환수 등록에서 확인해주세요';END IF;
  v_customer:=v_recovery.customer_id;v_kind:='recovery_return';
 ELSE RAISE EXCEPTION '지원하지 않는 원본 연결입니다. 새로고침 후 전용 원본 관리에서 확인해주세요';
 END IF;
 v_locked_kind:=v_kind;
 IF v_customer IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(v_customer::text||':payment',0));
  IF v_kind='additional' THEN PERFORM pg_advisory_xact_lock(hashtextextended(v_customer::text||':additional',0));END IF;
  PERFORM id FROM public.customers WHERE id=v_customer AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '고객 원본을 새로 불러온 뒤 다시 확인해주세요';END IF;
  IF v_kind='additional' THEN
   SELECT * INTO v_additional FROM public.additional_contracts WHERE id=v_payment.source_additional_contract_id AND customer_id=v_customer AND deleted_at IS NULL FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION '추가 계약 원본을 새로 불러온 뒤 다시 확인해주세요';END IF;
  END IF;
  PERFORM id FROM public.payment_schedules WHERE customer_id=v_customer AND deleted_at IS NULL ORDER BY id FOR UPDATE;
  PERFORM id FROM public.recoveries WHERE customer_id=v_customer AND deleted_at IS NULL ORDER BY id FOR UPDATE;
 END IF;
 SELECT * INTO v_statement FROM public.settlement_entries WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v_statement.deleted_at IS NOT NULL OR v_statement.user_deleted
  THEN RAISE EXCEPTION '다른 화면에서 정산 내역이 변경되었습니다. 새로고침해주세요';END IF;

 IF coalesce(v_statement.entry_source,'manual')='manual' THEN
  IF v_statement.source_payment_schedule_id IS NOT NULL OR v_statement.source_recovery_id IS NOT NULL OR v_statement.recovery_component IS NOT NULL
   THEN RAISE EXCEPTION '원본이 연결된 수기 내역은 전용 원본 관리에서 확인해주세요';END IF;
  v_kind:='manual';
 ELSIF v_statement.entry_source='payment' AND v_statement.source_payment_schedule_id IS NOT NULL THEN
  SELECT * INTO v_payment FROM public.payment_schedules WHERE id=v_statement.source_payment_schedule_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_payment.customer_id IS DISTINCT FROM v_customer OR v_payment.paid_amount<=0 OR v_payment.paid_date IS NULL
   OR v_payment.status='환불' OR v_statement.amount IS DISTINCT FROM v_payment.paid_amount OR v_statement.payment_date IS DISTINCT FROM v_payment.paid_date
   OR (v_payment.source_recovery_id IS NOT NULL AND v_payment.source_additional_contract_id IS NOT NULL)
   THEN RAISE EXCEPTION '입금 원본의 금액·날짜·연결이 변경되었습니다. 새로고침해주세요';END IF;
  v_kind:=CASE WHEN v_payment.source_recovery_id IS NOT NULL THEN 'recovery'
   WHEN v_payment.source_additional_contract_id IS NOT NULL THEN 'additional' ELSE 'payment' END;
  IF v_kind='payment' AND v_payment.schedule_type IN ('환수','추가계약')
   THEN RAISE EXCEPTION '자동 입금 원본의 연결이 없어 전용 관리에서 확인이 필요합니다';END IF;
  v_payment_snapshot:=jsonb_build_object('id',v_payment.id,'customer_id',v_payment.customer_id,'row_version',v_payment.row_version,
   'paid_amount',v_payment.paid_amount,'paid_date',v_payment.paid_date,'expected_amount',v_payment.expected_amount,'due_date',v_payment.due_date,
   'status',v_payment.status,'promise_state',v_payment.promise_state,'schedule_type',coalesce(v_payment.schedule_type,'일반'),
   'source_recovery_id',v_payment.source_recovery_id,'source_additional_contract_id',v_payment.source_additional_contract_id,
   'memo',coalesce(v_payment.memo,''),'payment_method',coalesce(nullif(v_payment.payment_method,''),'계좌이체'));
 ELSIF v_statement.entry_source='recovery' AND v_statement.source_recovery_id IS NOT NULL AND v_statement.recovery_component='client_return' THEN
  v_kind:='recovery_return';
 ELSE RAISE EXCEPTION '지원하지 않는 원본 연결입니다. 전용 관리에서 확인해주세요';
 END IF;
 IF v_kind IS DISTINCT FROM v_locked_kind THEN RAISE EXCEPTION '정산 원본 연결이 변경되었습니다. 새로고침해주세요';END IF;
 IF v_kind IN ('recovery','recovery_return') THEN
  SELECT * INTO v_recovery FROM public.recoveries WHERE id=CASE WHEN v_kind='recovery' THEN v_payment.source_recovery_id ELSE v_statement.source_recovery_id END AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR v_recovery.customer_id IS DISTINCT FROM v_customer THEN RAISE EXCEPTION '환수 원본이 변경되었습니다. 새로고침해주세요';END IF;
  v_source_snapshot:=jsonb_build_object('id',v_recovery.id,'customer_id',v_recovery.customer_id,'row_version',v_recovery.row_version,
   'accounting_version',v_recovery.accounting_version,'recovery_date',v_recovery.recovery_date,'lender_name',coalesce(v_recovery.lender_name,''),
   'depositor_name',coalesce(v_recovery.depositor_name,''),'amount',v_recovery.amount,'payment_method',coalesce(nullif(v_recovery.payment_method,''),'계좌이체'),
   'memo',coalesce(v_recovery.memo,''),'installment_amount',coalesce(v_recovery.installment_amount,0),
   'client_return_amount',coalesce(v_recovery.client_return_amount,0),'success_fee_amount',coalesce(v_recovery.success_fee_amount,0));
 ELSIF v_kind='additional' THEN
  SELECT * INTO v_additional FROM public.additional_contracts WHERE id=v_payment.source_additional_contract_id AND customer_id=v_customer AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '추가 계약 원본이 변경되었습니다. 새로고침해주세요';END IF;
  v_source_snapshot:=jsonb_build_object('id',v_additional.id,'customer_id',v_additional.customer_id,'contract_date',v_additional.contract_date,
   'contract_amount',v_additional.contract_amount,'upfront_amount',coalesce(v_additional.upfront_amount,0),'installment_period',coalesce(v_additional.installment_period,0),
   'lender_unit_price',coalesce(v_additional.lender_unit_price,0),'lender_count',coalesce(v_additional.lender_count,0),
   'is_renegotiation',coalesce(v_additional.is_renegotiation,false),'memo',coalesce(v_additional.memo,''));
 END IF;
 v_actual:=jsonb_build_object('kind',v_kind,'settlement',jsonb_build_object('id',v_statement.id,'amount',v_statement.amount,
  'payment_date',v_statement.payment_date,'client_name',coalesce(v_statement.client_name,''),'payment_method',coalesce(nullif(v_statement.payment_method,''),'계좌이체'),
  'memo',coalesce(v_statement.memo,''),'entry_source',coalesce(v_statement.entry_source,'manual'),'entry_type',coalesce(v_statement.entry_type,'계약'),
  'customer_id',v_statement.customer_id,'source_payment_schedule_id',v_statement.source_payment_schedule_id,
  'source_recovery_id',v_statement.source_recovery_id,'recovery_component',v_statement.recovery_component),
  'payment',v_payment_snapshot,'source',v_source_snapshot);
 IF v_actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION '다른 화면에서 금액·날짜·원본이 변경되었습니다. 새로고침 후 다시 확인해주세요';END IF;

 -- A separate deterministic subrequest UUID avoids colliding with the outer
 -- receipt in the shared save_requests table. Outer retries ACK before reads.
 v_inner_key:=md5('dowon_cancel_settlement:v1:'||p_request_key::text)::uuid;
 CASE v_kind
 WHEN 'manual' THEN
  UPDATE public.settlement_entries SET deleted_at=now() WHERE id=p_id AND deleted_at IS NULL AND NOT user_deleted;
 WHEN 'payment' THEN
  SELECT coalesce(jsonb_object_agg(id,row_version),'{}'::jsonb) INTO v_versions FROM public.payment_schedules WHERE customer_id=v_customer AND deleted_at IS NULL;
  v_payload:=jsonb_build_array(jsonb_build_object('id',v_payment.id,'dueDate',coalesce(v_payment.due_date::text,''),'dueAmount',v_payment.expected_amount,
   'paidDate','','paidAmount',0,'status','예정','promiseState','cancelled','paymentMethod',coalesce(nullif(v_payment.payment_method,''),'계좌이체'),'memo',coalesce(v_payment.memo,'')));
  PERFORM public.dowon_save_schedule_batch_v3('payment',v_customer,v_payload,'{}'::uuid[],v_inner_key,v_versions);
 WHEN 'additional' THEN
  IF v_payment.paid_amount IS DISTINCT FROM v_additional.upfront_amount OR v_payment.paid_date IS DISTINCT FROM v_additional.contract_date
   THEN RAISE EXCEPTION '추가 계약 선납금 원본이 일치하지 않습니다. 추가 계약에서 확인해주세요';END IF;
  v_source_before:=to_jsonb(v_additional);
  v_payload:=jsonb_build_array(jsonb_build_object('id',v_additional.id,'contractDate',coalesce(v_additional.contract_date::text,''),'contractAmount',v_additional.contract_amount,
   'prepaidAmount',0,'installmentMonths',coalesce(v_additional.installment_period,0),'lenderUnitPrice',coalesce(v_additional.lender_unit_price,0),
   'lenderCount',coalesce(v_additional.lender_count,0),'isRenegotiation',coalesce(v_additional.is_renegotiation,false),'memo',coalesce(v_additional.memo,'')));
  PERFORM public.dowon_save_finance_batch('additional',v_customer,v_payload,'{}'::uuid[]);
  SELECT to_jsonb(a) INTO v_source_after FROM public.additional_contracts a WHERE id=v_additional.id;
  IF v_source_after-ARRAY['upfront_amount','updated_at'] IS DISTINCT FROM v_source_before-ARRAY['upfront_amount','updated_at']
   OR (v_source_after->>'upfront_amount')::numeric IS DISTINCT FROM 0 THEN
   RAISE EXCEPTION '추가 계약 원금·조건 보존을 확인하지 못했습니다. 추가 계약에서 직접 확인해주세요';END IF;
 WHEN 'recovery' THEN
  IF v_payment.paid_amount IS DISTINCT FROM v_recovery.amount OR v_payment.paid_date IS DISTINCT FROM v_recovery.recovery_date
   THEN RAISE EXCEPTION '환수 총입금 원본이 일치하지 않습니다. 환수 등록에서 확인해주세요';END IF;
  IF v_recovery.client_return_amount>0 OR EXISTS(SELECT 1 FROM public.recovery_refunds WHERE recovery_id=v_recovery.id AND cancelled_at IS NULL)
   THEN RAISE EXCEPTION '의뢰인 반환 내역이 있는 환수는 총입금만 취소할 수 없습니다. 환수 등록에서 반환 내역부터 확인해주세요';END IF;
  IF v_recovery.accounting_version=1 AND (EXISTS(SELECT 1 FROM public.recovery_fee_splits WHERE recovery_id=v_recovery.id)
   OR EXISTS(SELECT 1 FROM public.recovery_fee_allocations WHERE recovery_id=v_recovery.id))
   THEN RAISE EXCEPTION '기존 배분이 확정된 환수는 환수 등록에서 충당 내역을 확인한 뒤 취소해주세요';END IF;
  SELECT coalesce(jsonb_object_agg(id,row_version),'{}'::jsonb) INTO v_versions FROM public.recoveries WHERE customer_id=v_customer AND deleted_at IS NULL;
  PERFORM public.dowon_save_recovery_batch_v2(v_customer,'[]'::jsonb,ARRAY[v_recovery.id],v_inner_key,v_versions);
 WHEN 'recovery_return' THEN
  SELECT coalesce(sum(amount),0) INTO v_returns FROM public.recovery_refunds WHERE recovery_id=v_recovery.id AND cancelled_at IS NULL;
  IF v_recovery.accounting_version<>2 OR v_statement.amount>=0 OR v_recovery.client_return_amount-v_returns IS DISTINCT FROM -v_statement.amount
   OR v_statement.payment_date IS DISTINCT FROM v_recovery.recovery_date THEN
   RAISE EXCEPTION '환수 반환 원본이 일치하지 않습니다. 환수 등록에서 확인해주세요';END IF;
  SELECT coalesce(jsonb_object_agg(id,row_version),'{}'::jsonb) INTO v_versions FROM public.recoveries WHERE customer_id=v_customer AND deleted_at IS NULL;
  v_payload:=jsonb_build_array(jsonb_build_object('id',v_recovery.id,'recoveryDate',coalesce(v_recovery.recovery_date::text,''),
   'lenderName',coalesce(v_recovery.lender_name,''),'depositorName',coalesce(v_recovery.depositor_name,''),'amount',v_recovery.amount,
   'paymentMethod',coalesce(nullif(v_recovery.payment_method,''),'계좌이체'),'memo',coalesce(v_recovery.memo,''),
   'installmentAmount',v_recovery.installment_amount,'clientReturnAmount',v_returns));
  PERFORM public.dowon_save_recovery_batch_v2(v_customer,v_payload,'{}'::uuid[],v_inner_key,v_versions);
 ELSE RAISE EXCEPTION '이 거래 유형은 전용 원본 관리에서 확인해주세요';
 END CASE;
 IF EXISTS(SELECT 1 FROM public.settlement_entries WHERE id=p_id AND (deleted_at IS NULL OR user_deleted))
  THEN RAISE EXCEPTION '원본 거래 취소가 정산표에 반영되지 않아 전체 변경을 취소했습니다';END IF;
 INSERT INTO dowon_private.save_requests(actor_id,request_key,payload,result) VALUES(v_actor,p_request_key,v_input,1);
 RETURN jsonb_build_object('id',p_id,'kind',v_kind,'cancelled',true);
END;$$;
REVOKE ALL ON FUNCTION public.dowon_cancel_settlement(uuid,jsonb,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_cancel_settlement(uuid,jsonb,uuid) TO authenticated;

-- Old tabs displayed a source-preserving confirmation. They must refresh,
-- rather than silently acquiring a different, destructive meaning.
CREATE OR REPLACE FUNCTION public.dowon_delete_settlement(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN RAISE EXCEPTION '정산 삭제 방식이 변경되었습니다. 새로고침 후 정산표에서 원본 거래 취소를 확인해주세요';END;$$;
REVOKE ALL ON FUNCTION public.dowon_delete_settlement(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_delete_settlement(uuid) TO authenticated;
COMMIT;
