-- Apply after recovery_balance_consistency. No existing business rows rewritten.
BEGIN;
CREATE SCHEMA IF NOT EXISTS dowon_private;
REVOKE ALL ON SCHEMA dowon_private FROM PUBLIC,anon;
GRANT USAGE ON SCHEMA dowon_private TO authenticated;
CREATE TABLE dowon_private.save_requests (
 actor_id uuid NOT NULL,
 request_key uuid NOT NULL,
 payload jsonb NOT NULL,
 result integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,request_key)
);
ALTER TABLE dowon_private.save_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_requests_read ON dowon_private.save_requests FOR SELECT TO authenticated USING(actor_id=(select auth.uid()));
CREATE POLICY own_requests_insert ON dowon_private.save_requests FOR INSERT TO authenticated WITH CHECK(actor_id=(select auth.uid()));
REVOKE ALL ON dowon_private.save_requests FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON dowon_private.save_requests TO authenticated;

CREATE OR REPLACE FUNCTION public.dowon_save_finance_batch(p_kind text,p_customer_id uuid,p_rows jsonb,p_delete_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE item jsonb; row_id uuid; changed integer; result integer:=0;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다'; END IF;
 IF p_kind NOT IN ('additional','recovery') OR p_kind IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION '입력 형식 오류'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':'||p_kind,0));
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE nullif(j->>'id','')::uuid=ANY(p_delete_ids))
 THEN RAISE EXCEPTION '수정과 삭제를 동시에 지정할 수 없습니다'; END IF;
 IF p_kind='additional' THEN
  UPDATE public.additional_contracts SET deleted_at=now() WHERE customer_id=p_customer_id AND id=ANY(p_delete_ids) AND deleted_at IS NULL;
 ELSE
  UPDATE public.recoveries SET deleted_at=now() WHERE customer_id=p_customer_id AND id=ANY(p_delete_ids) AND deleted_at IS NULL;
 END IF;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>coalesce(cardinality(p_delete_ids),0) THEN RAISE EXCEPTION '삭제 대상이 유효하지 않습니다'; END IF;
 result:=changed;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  row_id:=nullif(item->>'id','')::uuid;
  IF p_kind='additional' THEN
   IF coalesce((item->>'contractAmount')::numeric,0)<0 OR coalesce((item->>'prepaidAmount')::numeric,0)<0
   THEN RAISE EXCEPTION '계약금액과 선납금은 음수일 수 없습니다'; END IF;
   IF row_id IS NULL THEN
    INSERT INTO public.additional_contracts(customer_id,contract_date,contract_amount,upfront_amount,installment_period,lender_unit_price,lender_count,is_renegotiation,memo)
    VALUES(p_customer_id,nullif(item->>'contractDate','')::date,coalesce((item->>'contractAmount')::numeric,0),coalesce((item->>'prepaidAmount')::numeric,0),CASE WHEN coalesce((item->>'isRenegotiation')::boolean,false) THEN 0 ELSE coalesce((item->>'installmentMonths')::int,0) END,coalesce((item->>'lenderUnitPrice')::numeric,0),coalesce((item->>'lenderCount')::int,0),coalesce((item->>'isRenegotiation')::boolean,false),coalesce(item->>'memo','')) RETURNING id INTO row_id;
   ELSE
   UPDATE public.additional_contracts SET contract_date=nullif(item->>'contractDate','')::date,
    contract_amount=coalesce((item->>'contractAmount')::numeric,0),upfront_amount=coalesce((item->>'prepaidAmount')::numeric,0),
    installment_period=CASE WHEN coalesce((item->>'isRenegotiation')::boolean,false) THEN 0 ELSE coalesce((item->>'installmentMonths')::int,0) END,
    lender_unit_price=coalesce((item->>'lenderUnitPrice')::numeric,0),lender_count=coalesce((item->>'lenderCount')::int,0),
    is_renegotiation=coalesce((item->>'isRenegotiation')::boolean,false),memo=coalesce(item->>'memo','')
   WHERE id=row_id AND customer_id=p_customer_id AND deleted_at IS NULL;
   END IF;
  ELSE
   IF coalesce((item->>'amount')::numeric,0)<0 THEN RAISE EXCEPTION '환수금액은 음수일 수 없습니다'; END IF;
   IF row_id IS NULL THEN
    INSERT INTO public.recoveries(customer_id,recovery_date,lender_name,amount,payment_method,recovery_type,memo,depositor_name)
    VALUES(p_customer_id,nullif(item->>'recoveryDate','')::date,coalesce(item->>'lenderName',''),coalesce((item->>'amount')::numeric,0),coalesce(item->>'paymentMethod','계좌이체'),coalesce(item->>'recoveryType',''),coalesce(item->>'memo',''),coalesce(item->>'depositorName','')) RETURNING id INTO row_id;
   ELSE
    UPDATE public.recoveries SET recovery_date=nullif(item->>'recoveryDate','')::date,lender_name=coalesce(item->>'lenderName',''),
     recovery_type=coalesce(item->>'recoveryType',''),amount=coalesce((item->>'amount')::numeric,0),payment_method=coalesce(item->>'paymentMethod','계좌이체'),memo=coalesce(item->>'memo',''),depositor_name=coalesce(item->>'depositorName','')
    WHERE id=row_id AND customer_id=p_customer_id AND deleted_at IS NULL;
   END IF;
  END IF;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION '다른 고객이거나 삭제된 기록입니다'; END IF;
  result:=result+1;
 END LOOP;
 RETURN result;
END;$$;
REVOKE ALL ON FUNCTION public.dowon_save_finance_batch(text,uuid,jsonb,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_save_finance_batch(text,uuid,jsonb,uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.dowon_save_schedule_batch_once(p_kind text,p_customer_id uuid,p_rows jsonb,p_carries jsonb,p_delete_ids uuid[],p_request_key uuid)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor uuid:=auth.uid(); input jsonb; previous dowon_private.save_requests%ROWTYPE; result integer;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다'; END IF;
 IF p_request_key IS NULL OR p_kind IS NULL OR p_kind NOT IN ('payment','repayment','additional','recovery') THEN RAISE EXCEPTION '저장 요청 오류'; END IF;
 input:=jsonb_build_object('kind',p_kind,'customer',p_customer_id,'rows',p_rows,'carries',p_carries,'deleted',p_delete_ids);
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_key::text,0));
 SELECT * INTO previous FROM dowon_private.save_requests WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN
  IF previous.payload IS DISTINCT FROM input THEN RAISE EXCEPTION '동일 요청 키의 내용이 변경되었습니다'; END IF;
  RETURN previous.result;
 END IF;
 CASE p_kind
  WHEN 'payment' THEN result:=public.dowon_save_payment_batch(p_customer_id,p_rows,p_carries,p_delete_ids);
  WHEN 'repayment' THEN result:=public.dowon_save_repayment_batch(p_customer_id,p_rows,p_carries,p_delete_ids);
  ELSE result:=public.dowon_save_finance_batch(p_kind,p_customer_id,p_rows,p_delete_ids);
 END CASE;
 INSERT INTO dowon_private.save_requests(actor_id,request_key,payload,result) VALUES(actor,p_request_key,input,result);
 RETURN result;
END;$$;
REVOKE ALL ON FUNCTION public.dowon_save_schedule_batch_once(text,uuid,jsonb,jsonb,uuid[],uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_save_schedule_batch_once(text,uuid,jsonb,jsonb,uuid[],uuid) TO authenticated;
COMMIT;
