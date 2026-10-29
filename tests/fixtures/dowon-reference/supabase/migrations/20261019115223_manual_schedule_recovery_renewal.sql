-- Manual schedule editing replaces the old carry/replan writer. Existing cash,
-- links and recovery allocations are retained; no business rows are backfilled.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
-- Capture and verify the same committed financial rows while writes are paused.
-- DDL defaults may add fields, but this release must never rewrite old facts.
LOCK TABLE public.payment_schedules,public.repayment_schedules,public.recoveries,
 public.settlement_entries,public.recovery_fee_allocations,public.recovery_fee_splits,
 public.recovery_refunds IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE dowon_renewal_financial_before(table_name text PRIMARY KEY,row_hash text NOT NULL,row_count bigint NOT NULL) ON COMMIT DROP;
DO $$
DECLARE table_name text;row_hash text;row_count bigint;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['payment_schedules','repayment_schedules','recoveries','settlement_entries','recovery_fee_allocations','recovery_fee_splits','recovery_refunds'] LOOP
  EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY coalesce(to_jsonb(t)->>''id'',to_jsonb(t)->>''recovery_id'')),''[]''::jsonb)::text),count(*) FROM public.%I t',table_name) INTO row_hash,row_count;
  INSERT INTO dowon_renewal_financial_before VALUES(table_name,row_hash,row_count);
 END LOOP;
END;$$;

ALTER TABLE public.payment_schedules ADD COLUMN date_change_count integer NOT NULL DEFAULT 0 CHECK(date_change_count>=0);
ALTER TABLE public.repayment_schedules ADD COLUMN date_change_count integer NOT NULL DEFAULT 0 CHECK(date_change_count>=0);
-- A view's original p.* expansion is fixed when it is created. Preserve every
-- existing view column (including the final root budget) and append the counter.
DO $$
DECLARE projection text;
BEGIN
 SELECT string_agg(CASE WHEN a.attname='root_obligation_amount'
  THEN 'coalesce(root.obligation_amount,root.repayment_amount) AS root_obligation_amount'
  ELSE format('p.%I',a.attname) END,',' ORDER BY a.attnum) INTO projection
 FROM pg_attribute a WHERE a.attrelid='public.dowon_repayment_promises'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 EXECUTE format('CREATE OR REPLACE VIEW public.dowon_repayment_promises WITH(security_invoker=true) AS SELECT %s,p.date_change_count
  FROM public.repayment_schedules p LEFT JOIN public.repayment_schedules root
  ON root.id=coalesce(p.root_schedule_id,p.rescheduled_from_id,p.id) AND root.customer_id=p.customer_id WHERE p.deleted_at IS NULL',projection);
END;$$;
REVOKE ALL ON public.dowon_repayment_promises FROM PUBLIC,anon;
GRANT SELECT ON public.dowon_repayment_promises TO authenticated;
CREATE FUNCTION public.dowon_count_schedule_date_changes()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE old_date date;new_date date;
BEGIN
 IF TG_OP='INSERT' THEN new.date_change_count:=0;RETURN new;END IF;
 old_date:=nullif(to_jsonb(old)->>TG_ARGV[0],'')::date;
 new_date:=nullif(to_jsonb(new)->>TG_ARGV[0],'')::date;
 new.date_change_count:=old.date_change_count;
 -- Setting an initially unknown date, clearing a date and system recovery cash
 -- synchronization do not represent an additional missed promise.
 IF old_date IS NOT NULL AND new_date IS NOT NULL AND new_date IS DISTINCT FROM old_date
  AND old.deleted_at IS NULL AND new.deleted_at IS NULL
  AND (TG_TABLE_NAME<>'payment_schedules' OR coalesce(to_jsonb(old)->>'schedule_type','') NOT IN ('환수','추가계약'))
 THEN new.date_change_count:=old.date_change_count+1;END IF;
 RETURN new;
END;$$;
CREATE TRIGGER trg_dowon_date_change_count BEFORE INSERT OR UPDATE ON public.payment_schedules
 FOR EACH ROW EXECUTE FUNCTION public.dowon_count_schedule_date_changes('due_date');
CREATE TRIGGER trg_dowon_date_change_count BEFORE INSERT OR UPDATE ON public.repayment_schedules
 FOR EACH ROW EXECUTE FUNCTION public.dowon_count_schedule_date_changes('repayment_date');
REVOKE ALL ON FUNCTION public.dowon_count_schedule_date_changes() FROM PUBLIC,anon,authenticated;

ALTER TABLE public.recoveries ADD COLUMN accounting_version integer NOT NULL DEFAULT 1 CHECK(accounting_version IN (1,2));
ALTER TABLE public.recoveries ADD COLUMN row_version bigint NOT NULL DEFAULT 1;
ALTER TABLE public.recoveries ADD COLUMN success_fee_amount bigint NOT NULL DEFAULT 0 CHECK(success_fee_amount>=0);
ALTER TABLE public.recoveries ADD COLUMN installment_amount bigint NOT NULL DEFAULT 0 CHECK(installment_amount>=0);
ALTER TABLE public.recoveries ADD COLUMN client_return_amount bigint NOT NULL DEFAULT 0 CHECK(client_return_amount>=0);
-- Existing records stay version 1. New explicitly saved records use version 2.
ALTER TABLE public.recoveries ALTER COLUMN accounting_version SET DEFAULT 2;
ALTER TABLE public.settlement_entries ADD COLUMN source_recovery_id uuid REFERENCES public.recoveries(id);
ALTER TABLE public.settlement_entries ADD COLUMN recovery_component text CHECK(recovery_component IN ('success_fee','installment','client_return'));
ALTER TABLE public.settlement_entries ADD COLUMN user_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE public.recovery_refunds ADD COLUMN settlement_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE public.settlement_entries DROP CONSTRAINT settlement_entries_entry_source_check;
ALTER TABLE public.settlement_entries ADD CONSTRAINT settlement_entries_entry_source_check CHECK(entry_source IN ('manual','payment','recovery'));
ALTER TABLE public.settlement_entries DROP CONSTRAINT settlement_entries_entry_type_check;
ALTER TABLE public.settlement_entries ADD CONSTRAINT settlement_entries_entry_type_check
 CHECK(entry_type IN ('계약','환수','환수 성공보수','환수 분납금','의뢰인 환수 반환금'));
ALTER TABLE public.settlement_entries ADD CONSTRAINT settlement_recovery_component_source_check
 CHECK((source_recovery_id IS NULL AND recovery_component IS NULL) OR
       (source_recovery_id IS NOT NULL AND recovery_component IS NOT NULL AND source_payment_schedule_id IS NULL AND entry_source='recovery'));
CREATE UNIQUE INDEX settlement_entries_recovery_component_idx
 ON public.settlement_entries(source_recovery_id,recovery_component) WHERE source_recovery_id IS NOT NULL;

CREATE VIEW public.dowon_active_recovery_allocations WITH(security_invoker=true) AS
 SELECT a.* FROM public.recovery_fee_allocations a JOIN public.recoveries r ON r.id=a.recovery_id
 WHERE r.accounting_version=1 AND r.deleted_at IS NULL;
REVOKE ALL ON public.dowon_active_recovery_allocations FROM PUBLIC,anon;
GRANT SELECT ON public.dowon_active_recovery_allocations TO authenticated;

-- A user can hide a statement line without changing its source receipt. Hiding
-- a legacy return grants UPDATE only on this display flag, never on its money.
GRANT UPDATE(settlement_hidden) ON public.recovery_refunds TO authenticated;
CREATE POLICY recovery_refunds_hide_statement ON public.recovery_refunds FOR UPDATE TO authenticated USING(true) WITH CHECK(true);
CREATE FUNCTION public.dowon_keep_settlement_hidden()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF old.user_deleted THEN new.user_deleted:=true;new.deleted_at:=coalesce(old.deleted_at,new.deleted_at,now());END IF;
 RETURN new;
END;$$;
CREATE TRIGGER trg_dowon_keep_settlement_hidden BEFORE UPDATE ON public.settlement_entries
 FOR EACH ROW EXECUTE FUNCTION public.dowon_keep_settlement_hidden();
REVOKE ALL ON FUNCTION public.dowon_keep_settlement_hidden() FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.dowon_delete_settlement(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다';END IF;
 UPDATE public.settlement_entries SET user_deleted=true,deleted_at=coalesce(deleted_at,now()) WHERE id=p_id;
 IF FOUND THEN RETURN;END IF;
 UPDATE public.recovery_refunds SET settlement_hidden=true WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION '정산 내역을 찾지 못했습니다';END IF;
END;$$;
REVOKE ALL ON FUNCTION public.dowon_delete_settlement(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_delete_settlement(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_payment_schedule_to_settlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_name text;
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE settlement_entries SET deleted_at=coalesce(deleted_at,now()) WHERE source_payment_schedule_id=old.id;
  RETURN old;
 END IF;
 -- Preserve the bank receipt in payment_schedules, while the detailed recovery
 -- replaces its former single gross statement line with three components.
 IF new.source_recovery_id IS NOT NULL AND EXISTS(SELECT 1 FROM recoveries WHERE id=new.source_recovery_id AND accounting_version=2) THEN
  UPDATE settlement_entries SET deleted_at=coalesce(deleted_at,now()) WHERE source_payment_schedule_id=new.id;
  RETURN new;
 END IF;
 IF TG_OP='UPDATE' AND new.paid_amount IS NOT DISTINCT FROM old.paid_amount
    AND new.paid_date IS NOT DISTINCT FROM old.paid_date
    AND (new.status='환불') IS NOT DISTINCT FROM (old.status='환불')
    AND new.deleted_at IS NOT DISTINCT FROM old.deleted_at THEN
  IF new.payment_method IS DISTINCT FROM old.payment_method OR new.customer_id IS DISTINCT FROM old.customer_id THEN
   SELECT name INTO v_name FROM customers WHERE id=new.customer_id;
   UPDATE settlement_entries SET payment_method=coalesce(nullif(new.payment_method,''),'계좌이체'),
    customer_id=new.customer_id,client_name=coalesce(v_name,'') WHERE source_payment_schedule_id=new.id;
  END IF;
  RETURN new;
 END IF;
 IF new.deleted_at IS NOT NULL OR new.status='환불' OR coalesce(new.paid_amount,0)<=0 THEN
  UPDATE settlement_entries SET deleted_at=coalesce(deleted_at,now()) WHERE source_payment_schedule_id=new.id;
  RETURN new;
 END IF;
 IF new.paid_date IS NULL AND NOT EXISTS(SELECT 1 FROM settlement_entries WHERE source_payment_schedule_id=new.id) THEN RETURN new;END IF;
 SELECT name INTO v_name FROM customers WHERE id=new.customer_id;
 INSERT INTO settlement_entries(payment_date,client_name,amount,payment_method,memo,customer_id,
  source_payment_schedule_id,entry_source,entry_type,deleted_at)
 VALUES(new.paid_date,coalesce(v_name,''),new.paid_amount,coalesce(nullif(new.payment_method,''),'계좌이체'),
  '[입금/분납 자동연동] 실제 입금 · '||coalesce(new.memo,''),new.customer_id,new.id,'payment',
  CASE WHEN new.schedule_type='환수' THEN '환수' ELSE '계약' END,NULL)
 ON CONFLICT(source_payment_schedule_id) WHERE source_payment_schedule_id IS NOT NULL DO UPDATE
 SET payment_date=excluded.payment_date,client_name=excluded.client_name,amount=excluded.amount,
  payment_method=excluded.payment_method,memo=excluded.memo,customer_id=excluded.customer_id,
  entry_source=excluded.entry_source,entry_type=excluded.entry_type,deleted_at=NULL
 WHERE NOT settlement_entries.user_deleted;
 RETURN new;
END;$$;
REVOKE ALL ON FUNCTION public.sync_payment_schedule_to_settlement() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.dowon_guard_recovery_split()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='UPDATE' AND new.customer_id IS DISTINCT FROM old.customer_id THEN RAISE EXCEPTION '환수 이력의 고객은 변경할 수 없습니다';END IF;
 IF EXISTS(SELECT 1 FROM public.recovery_fee_splits WHERE recovery_id=old.id) AND
    (TG_OP='DELETE' OR (new.accounting_version=1 AND (new.deleted_at IS DISTINCT FROM old.deleted_at OR new.amount IS DISTINCT FROM old.amount
     OR new.lender_name IS DISTINCT FROM old.lender_name OR new.recovery_date IS DISTINCT FROM old.recovery_date)))
 THEN RAISE EXCEPTION '기존 충당 내역은 새 환수 상세에서 확인한 뒤 저장해주세요';END IF;
 IF TG_OP='UPDATE' AND old.accounting_version=2 AND new.accounting_version<>2 THEN RAISE EXCEPTION '이전 환수 양식으로 되돌릴 수 없습니다';END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN old ELSE new END;
END;$$;
-- The old allocation/refund actions were removed from the product. Stale tabs
-- must refresh rather than append a second accounting model to a detailed row.
CREATE OR REPLACE FUNCTION public.dowon_apply_recovery_split(p_recovery_id uuid,p_success_fee numeric,p_allocations jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN RAISE EXCEPTION '환수 관리가 변경되었습니다. 새로고침한 뒤 상세에서 저장해주세요';END;$$;
CREATE OR REPLACE FUNCTION public.dowon_record_recovery_refund(p_recovery_id uuid,p_date date,p_amount numeric,p_recipient text,p_method text,p_memo text,p_request_key uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN RAISE EXCEPTION '환수 관리가 변경되었습니다. 새로고침한 뒤 상세에서 저장해주세요';END;$$;
CREATE FUNCTION public.dowon_prepare_recovery_details()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE previous_returns numeric;
BEGIN
 IF TG_OP='INSERT' THEN new.row_version:=1;ELSE new.row_version:=old.row_version+1;END IF;
 -- Archiving an imported row must not require filling fields that did not
 -- exist when its original bank receipt was recorded.
 IF TG_OP='UPDATE' AND new.deleted_at IS NOT NULL THEN RETURN new;END IF;
 IF new.accounting_version=2 THEN
  IF new.amount<0 OR new.amount<>trunc(new.amount) OR new.amount::text IN ('NaN','Infinity','-Infinity')
   OR new.installment_amount<0 OR new.client_return_amount<0 THEN RAISE EXCEPTION '환수 금액은 0 이상의 정수로 입력해주세요';END IF;
  new.success_fee_amount:=trunc(new.amount/2);
  IF new.installment_amount+new.client_return_amount>new.amount-new.success_fee_amount THEN RAISE EXCEPTION '분납금과 반환금 합계가 성공보수를 제외한 환수금을 초과합니다';END IF;
  SELECT coalesce(sum(amount),0) INTO previous_returns FROM recovery_refunds WHERE recovery_id=new.id;
  IF new.client_return_amount<previous_returns THEN RAISE EXCEPTION '이미 반환한 금액보다 작게 저장할 수 없습니다';END IF;
  IF new.amount>0 AND (new.recovery_date IS NULL OR nullif(btrim(new.lender_name),'') IS NULL OR nullif(btrim(new.depositor_name),'') IS NULL)
   THEN RAISE EXCEPTION '환수일, 업체명, 실제 입금 예금주를 입력해주세요';END IF;
 END IF;
 RETURN new;
END;$$;
CREATE TRIGGER trg_dowon_recovery_details BEFORE INSERT OR UPDATE ON public.recoveries
 FOR EACH ROW EXECUTE FUNCTION public.dowon_prepare_recovery_details();
REVOKE ALL ON FUNCTION public.dowon_prepare_recovery_details() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.sync_recovery_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_payment_id uuid;v_memo text;v_name text;component text;component_amount numeric;component_type text;previous_returns numeric;
BEGIN
 SELECT id INTO v_payment_id FROM public.payment_schedules WHERE source_recovery_id=new.id ORDER BY admin_created_at DESC NULLS LAST LIMIT 1;
 IF new.deleted_at IS NOT NULL THEN
  IF v_payment_id IS NOT NULL THEN UPDATE payment_schedules SET deleted_at=coalesce(deleted_at,now()) WHERE id=v_payment_id;END IF;
  UPDATE settlement_entries SET deleted_at=coalesce(deleted_at,now()) WHERE source_recovery_id=new.id;
  RETURN new;
 END IF;
 v_memo:='[환수] '||coalesce(nullif(new.lender_name,''),'업체 미지정')||CASE WHEN new.memo<>'' THEN ' · '||new.memo ELSE '' END;
 IF v_payment_id IS NULL THEN
  INSERT INTO payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,schedule_type,reschedule_sequence,source_recovery_id)
  VALUES(new.customer_id,new.recovery_date,new.amount,new.recovery_date,new.amount,'완료',new.payment_method,v_memo,'환수',0,new.id);
 ELSE
  UPDATE payment_schedules SET customer_id=new.customer_id,due_date=new.recovery_date,expected_amount=new.amount,
   paid_date=new.recovery_date,paid_amount=new.amount,status='완료',payment_method=new.payment_method,memo=v_memo,schedule_type='환수',deleted_at=NULL WHERE id=v_payment_id;
 END IF;
 IF new.accounting_version<>2 THEN RETURN new;END IF;
 SELECT name INTO v_name FROM customers WHERE id=new.customer_id;
 SELECT coalesce(sum(amount),0) INTO previous_returns FROM recovery_refunds WHERE recovery_id=new.id;
 FOREACH component IN ARRAY ARRAY['success_fee','installment','client_return'] LOOP
  component_amount:=CASE component WHEN 'success_fee' THEN new.success_fee_amount WHEN 'installment' THEN new.installment_amount ELSE new.client_return_amount-previous_returns END;
  component_type:=CASE component WHEN 'success_fee' THEN '환수 성공보수' WHEN 'installment' THEN '환수 분납금' ELSE '의뢰인 환수 반환금' END;
  IF component_amount<=0 THEN
   UPDATE settlement_entries SET deleted_at=coalesce(deleted_at,now()) WHERE source_recovery_id=new.id AND recovery_component=component;
   CONTINUE;
  END IF;
  INSERT INTO settlement_entries(payment_date,client_name,amount,payment_method,memo,customer_id,source_recovery_id,recovery_component,entry_source,entry_type,deleted_at)
  VALUES(new.recovery_date,coalesce(v_name,''),CASE WHEN component='client_return' THEN -component_amount ELSE component_amount END,
   new.payment_method,component_type||' [업체:'||new.lender_name||'] [예금주:'||new.depositor_name||']'||CASE WHEN new.memo<>'' THEN ' · '||new.memo ELSE '' END,
   new.customer_id,new.id,component,'recovery',component_type,NULL)
  ON CONFLICT(source_recovery_id,recovery_component) WHERE source_recovery_id IS NOT NULL DO UPDATE
  SET payment_date=excluded.payment_date,client_name=excluded.client_name,amount=excluded.amount,payment_method=excluded.payment_method,
   memo=excluded.memo,customer_id=excluded.customer_id,entry_source=excluded.entry_source,entry_type=excluded.entry_type,deleted_at=NULL
  WHERE NOT settlement_entries.user_deleted;
 END LOOP;
 RETURN new;
END;$$;
REVOKE ALL ON FUNCTION public.sync_recovery_payment() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.dowon_save_schedule_batch_v3(p_kind text,p_customer_id uuid,p_rows jsonb,p_delete_ids uuid[],p_request_key uuid,p_versions jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor uuid:=auth.uid();input jsonb;previous dowon_private.save_requests%ROWTYPE;versions jsonb;table_name text;item jsonb;row_id uuid;record_before jsonb;result integer:=0;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다';END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('payment','repayment') OR p_customer_id IS NULL OR p_request_key IS NULL
  OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_typeof(p_versions) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION '저장 요청 형식을 확인해주세요';END IF;
 input:=jsonb_build_object('version',3,'kind',p_kind,'customer',p_customer_id,'rows',p_rows,'deleted',p_delete_ids,'versions',p_versions);
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_key::text,0));
 SELECT * INTO previous FROM dowon_private.save_requests WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN IF previous.payload IS DISTINCT FROM input THEN RAISE EXCEPTION '동일 요청 키의 내용이 변경되었습니다';END IF;RETURN previous.result;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':'||p_kind,0));
 PERFORM id FROM customers WHERE id=p_customer_id AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION '고객 정보를 찾지 못했습니다';END IF;
 table_name:=CASE WHEN p_kind='payment' THEN 'payment_schedules' ELSE 'repayment_schedules' END;
 EXECUTE format('SELECT id FROM %I WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY id FOR UPDATE',table_name) USING p_customer_id;
 EXECUTE format('SELECT coalesce(jsonb_object_agg(id,row_version),''{}''::jsonb) FROM %I WHERE customer_id=$1 AND deleted_at IS NULL',table_name) INTO versions USING p_customer_id;
 IF versions IS DISTINCT FROM p_versions THEN RAISE EXCEPTION '다른 화면에서 일정이 변경되었습니다. 새로 불러온 뒤 저장해주세요';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE nullif(j->>'id','') IS NOT NULL GROUP BY j->>'id' HAVING count(*)>1)
  OR (SELECT count(*) FROM unnest(coalesce(p_delete_ids,'{}'::uuid[])) id)<>(SELECT count(DISTINCT id) FROM unnest(coalesce(p_delete_ids,'{}'::uuid[])) id)
 THEN RAISE EXCEPTION '같은 일정이 중복되어 있습니다';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE nullif(j->>'id','')::uuid=ANY(p_delete_ids)) THEN RAISE EXCEPTION '수정과 삭제를 동시에 지정할 수 없습니다';END IF;
 FOREACH row_id IN ARRAY coalesce(p_delete_ids,'{}'::uuid[]) LOOP
  EXECUTE format('SELECT to_jsonb(p) FROM %I p WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL',table_name) INTO record_before USING row_id,p_customer_id;
  IF record_before IS NULL THEN RAISE EXCEPTION '삭제 대상의 고객 또는 현재 상태를 확인해주세요';END IF;
  IF p_kind='payment' AND (record_before->>'schedule_type' IN ('환수','추가계약') OR record_before->>'source_recovery_id' IS NOT NULL OR record_before->>'source_additional_contract_id' IS NOT NULL)
   THEN RAISE EXCEPTION '자동 생성 일정은 추가계약·환수 관리에서 수정해주세요';END IF;
  -- Removing a promise cannot remove a receipt, its date, or its settlement.
  EXECUTE format('UPDATE %I SET promise_state=''cancelled'' WHERE id=$1 AND promise_state IS DISTINCT FROM ''cancelled''',table_name) USING row_id;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  row_id:=nullif(item->>'id','')::uuid;
  IF item ? 'promiseState' AND coalesce(item->>'promiseState','') NOT IN ('active','cancelled','rescheduled') THEN RAISE EXCEPTION '일정 상태를 확인해주세요';END IF;
  PERFORM dowon_private.dowon_write_schedule_rows_legacy(p_kind,p_customer_id,jsonb_build_array(item),'{}','{}');
  IF row_id IS NULL THEN result:=result+1;
  ELSIF item ? 'promiseState' THEN
   EXECUTE format('UPDATE %I SET promise_state=$2 WHERE id=$1 AND promise_state IS DISTINCT FROM $2',table_name) USING row_id,item->>'promiseState';
  END IF;
 END LOOP;
 INSERT INTO dowon_private.save_requests(actor_id,request_key,payload,result) VALUES(actor,p_request_key,input,result);
 RETURN result;
END;$$;
REVOKE ALL ON FUNCTION public.dowon_save_schedule_batch_v3(text,uuid,jsonb,uuid[],uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_save_schedule_batch_v3(text,uuid,jsonb,uuid[],uuid,jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.dowon_save_schedule_batch_v2(p_kind text,p_customer_id uuid,p_rows jsonb,p_carries jsonb,p_delete_ids uuid[],p_request_key uuid,p_versions jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN RAISE EXCEPTION '일정 관리가 변경되었습니다. 새로고침한 뒤 저장해주세요';END;$$;

-- Keep additional-contract compatibility, but old open tabs cannot create a
-- recovery with the obsolete gross-only form after this migration.
ALTER FUNCTION public.dowon_save_finance_batch(text,uuid,jsonb,uuid[]) RENAME TO dowon_save_finance_batch_legacy;
ALTER FUNCTION public.dowon_save_finance_batch_legacy(text,uuid,jsonb,uuid[]) SET SCHEMA dowon_private;
REVOKE ALL ON FUNCTION dowon_private.dowon_save_finance_batch_legacy(text,uuid,jsonb,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION dowon_private.dowon_save_finance_batch_legacy(text,uuid,jsonb,uuid[]) TO authenticated;
CREATE FUNCTION public.dowon_save_finance_batch(p_kind text,p_customer_id uuid,p_rows jsonb,p_delete_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
 IF p_kind IS DISTINCT FROM 'additional' THEN RAISE EXCEPTION '환수 관리가 변경되었습니다. 새로고침한 뒤 저장해주세요';END IF;
 RETURN dowon_private.dowon_save_finance_batch_legacy(p_kind,p_customer_id,p_rows,p_delete_ids);
END;$$;
REVOKE ALL ON FUNCTION public.dowon_save_finance_batch(text,uuid,jsonb,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_save_finance_batch(text,uuid,jsonb,uuid[]) TO authenticated;

CREATE FUNCTION public.dowon_save_recovery_batch_v2(p_customer_id uuid,p_rows jsonb,p_delete_ids uuid[],p_request_key uuid,p_versions jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor uuid:=auth.uid();input jsonb;previous dowon_private.save_requests%ROWTYPE;versions jsonb;item jsonb;row_id uuid;changed integer;result integer:=0;
 before_credit numeric;after_credit numeric;cash numeric;contract numeric;allocated numeric;money_value numeric;money_key text;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다';END IF;
 IF p_customer_id IS NULL OR p_request_key IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_typeof(p_versions) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION '저장 요청 형식을 확인해주세요';END IF;
 input:=jsonb_build_object('version',2,'kind','recovery','customer',p_customer_id,'rows',p_rows,'deleted',p_delete_ids,'versions',p_versions);
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_key::text,0));
 SELECT * INTO previous FROM dowon_private.save_requests WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN IF previous.payload IS DISTINCT FROM input THEN RAISE EXCEPTION '동일 요청 키의 내용이 변경되었습니다';END IF;RETURN previous.result;END IF;
 -- Schedule receipts and recovery credits share the same customer lock.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':payment',0));
 PERFORM id FROM customers WHERE id=p_customer_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION '고객 정보를 찾지 못했습니다';END IF;
 PERFORM id FROM payment_schedules WHERE customer_id=p_customer_id AND deleted_at IS NULL ORDER BY id FOR UPDATE;
 PERFORM id FROM recoveries WHERE customer_id=p_customer_id AND deleted_at IS NULL ORDER BY id FOR UPDATE;
 SELECT coalesce(jsonb_object_agg(id,row_version),'{}'::jsonb) INTO versions FROM recoveries WHERE customer_id=p_customer_id AND deleted_at IS NULL;
 IF versions IS DISTINCT FROM p_versions THEN RAISE EXCEPTION '다른 화면에서 환수가 변경되었습니다. 새로 불러온 뒤 저장해주세요';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE nullif(j->>'id','') IS NOT NULL GROUP BY j->>'id' HAVING count(*)>1)
  OR (SELECT count(*) FROM unnest(coalesce(p_delete_ids,'{}'::uuid[])) id)<>(SELECT count(DISTINCT id) FROM unnest(coalesce(p_delete_ids,'{}'::uuid[])) id)
 THEN RAISE EXCEPTION '같은 환수가 중복되어 있습니다';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE nullif(j->>'id','')::uuid=ANY(p_delete_ids)) THEN RAISE EXCEPTION '수정과 삭제를 동시에 지정할 수 없습니다';END IF;
 SELECT coalesce(sum(amount),0) INTO allocated FROM dowon_active_recovery_allocations WHERE customer_id=p_customer_id;
 SELECT allocated+coalesce(sum(installment_amount),0) INTO before_credit FROM recoveries WHERE customer_id=p_customer_id AND deleted_at IS NULL AND accounting_version=2;
 -- Legacy confirmed splits remain unchanged until this particular row is
 -- explicitly converted. Their immutable allocation/refund rows are retained.
 FOREACH row_id IN ARRAY coalesce(p_delete_ids,'{}'::uuid[]) LOOP
  IF EXISTS(SELECT 1 FROM recovery_refunds WHERE recovery_id=row_id) THEN RAISE EXCEPTION '실제 반환 이력이 있는 환수는 삭제 대신 상세를 수정해주세요';END IF;
  UPDATE recoveries SET accounting_version=2,deleted_at=now() WHERE id=row_id AND customer_id=p_customer_id AND deleted_at IS NULL;
  GET DIAGNOSTICS changed=ROW_COUNT;IF changed<>1 THEN RAISE EXCEPTION '삭제 대상의 고객 또는 현재 상태를 확인해주세요';END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  row_id:=nullif(item->>'id','')::uuid;
  FOREACH money_key IN ARRAY ARRAY['amount','installmentAmount','clientReturnAmount'] LOOP
   money_value:=coalesce((item->>money_key)::numeric,0);
   IF money_value<0 OR money_value<>trunc(money_value) OR money_value::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION '환수 금액은 0 이상의 정수로 입력해주세요';END IF;
  END LOOP;
  IF row_id IS NULL THEN
   INSERT INTO recoveries(customer_id,recovery_date,lender_name,depositor_name,amount,payment_method,memo,accounting_version,installment_amount,client_return_amount)
   VALUES(p_customer_id,nullif(item->>'recoveryDate','')::date,coalesce(item->>'lenderName',''),coalesce(item->>'depositorName',''),coalesce((item->>'amount')::numeric,0),
    coalesce(nullif(item->>'paymentMethod',''),'계좌이체'),coalesce(item->>'memo',''),2,coalesce((item->>'installmentAmount')::bigint,0),coalesce((item->>'clientReturnAmount')::bigint,0));
  ELSE
   UPDATE recoveries SET recovery_date=nullif(item->>'recoveryDate','')::date,lender_name=coalesce(item->>'lenderName',''),depositor_name=coalesce(item->>'depositorName',''),
    amount=coalesce((item->>'amount')::numeric,0),payment_method=coalesce(nullif(item->>'paymentMethod',''),'계좌이체'),memo=coalesce(item->>'memo',''),accounting_version=2,
    installment_amount=coalesce((item->>'installmentAmount')::bigint,0),client_return_amount=coalesce((item->>'clientReturnAmount')::bigint,0)
    WHERE id=row_id AND customer_id=p_customer_id AND deleted_at IS NULL;
  END IF;
  GET DIAGNOSTICS changed=ROW_COUNT;IF changed<>1 THEN RAISE EXCEPTION '다른 고객이거나 삭제된 환수 기록입니다';END IF;
  result:=result+1;
 END LOOP;
 SELECT CASE WHEN c.is_accident THEN coalesce(c.accident_contract_amount,0) ELSE coalesce(c.contract_amount,0)+coalesce((SELECT sum(a.contract_amount) FROM additional_contracts a WHERE a.customer_id=c.id AND a.deleted_at IS NULL),0) END
  INTO contract FROM customers c WHERE c.id=p_customer_id;
 SELECT coalesce(sum(paid_amount),0) INTO cash FROM payment_schedules WHERE customer_id=p_customer_id AND deleted_at IS NULL AND status<>'환불' AND schedule_type<>'환수';
 SELECT coalesce(sum(amount),0) INTO allocated FROM dowon_active_recovery_allocations WHERE customer_id=p_customer_id;
 SELECT allocated+coalesce(sum(installment_amount),0) INTO after_credit FROM recoveries WHERE customer_id=p_customer_id AND deleted_at IS NULL AND accounting_version=2;
 IF after_credit>before_credit AND after_credit>greatest(0,contract-cash) THEN RAISE EXCEPTION '환수 분납금이 실제 남은 계약금을 초과합니다';END IF;
 INSERT INTO dowon_private.save_requests(actor_id,request_key,payload,result) VALUES(actor,p_request_key,input,result);
 RETURN result;
END;$$;
REVOKE ALL ON FUNCTION public.dowon_save_recovery_batch_v2(uuid,jsonb,uuid[],uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_save_recovery_batch_v2(uuid,jsonb,uuid[],uuid,jsonb) TO authenticated;

-- Plans display their registered amounts directly. Actual debt is calculated
-- separately, so an imported oversized plan remains editable and visible.
CREATE OR REPLACE FUNCTION public.dowon_schedule_projection(p_kind text,p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE source_sql text;budget numeric;extra_credit numeric:=0;result jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다';END IF;
 IF p_kind='payment' THEN
  SELECT CASE WHEN c.is_accident THEN coalesce(c.accident_contract_amount,0)
   ELSE coalesce(c.contract_amount,0)+coalesce((SELECT sum(a.contract_amount) FROM additional_contracts a WHERE a.customer_id=c.id AND a.deleted_at IS NULL),0) END
   INTO budget FROM customers c WHERE c.id=p_customer_id AND c.deleted_at IS NULL;
  SELECT coalesce(sum(installment_amount),0) INTO extra_credit FROM recoveries WHERE customer_id=p_customer_id AND deleted_at IS NULL AND accounting_version=2;
  source_sql:='SELECT p.id,p.customer_id,p.root_schedule_id,p.rescheduled_from_id,p.expected_amount::numeric amount,
   p.obligation_amount,p.due_date,p.paid_amount::numeric paid,p.promise_state,p.deleted_at,
   coalesce((SELECT sum(a.amount) FROM dowon_active_recovery_allocations a WHERE a.payment_schedule_id=p.id),0)::numeric allocated,
   (p.status=''환불'' OR p.schedule_type=''환수'') excluded FROM payment_schedules p WHERE p.customer_id=$1';
 ELSIF p_kind='repayment' THEN
  source_sql:='SELECT p.id,p.customer_id,p.root_schedule_id,p.rescheduled_from_id,p.repayment_amount::numeric amount,
   p.obligation_amount,p.repayment_date due_date,p.paid_amount::numeric paid,p.promise_state,p.deleted_at,
   0::numeric allocated,false excluded FROM repayment_schedules p WHERE p.customer_id=$1';
 ELSE RAISE EXCEPTION '일정 종류를 확인해주세요';END IF;
 EXECUTE format($q$
 WITH raw AS (%s),linked AS (
  SELECT r.*,coalesce(r.root_schedule_id,parent.root_schedule_id,r.rescheduled_from_id,r.id) root_id
  FROM raw r LEFT JOIN raw parent ON parent.id=r.rescheduled_from_id
 ),live AS (
  SELECT r.*,CASE WHEN excluded THEN 'cancelled' ELSE coalesce(promise_state,CASE WHEN EXISTS(SELECT 1 FROM raw c WHERE c.rescheduled_from_id=r.id AND c.deleted_at IS NULL)
   THEN 'rescheduled' ELSE 'active' END) END effective_state FROM linked r WHERE deleted_at IS NULL
 ),groups AS (
  SELECT l.root_id,coalesce(max(root.obligation_amount),max(root.amount),sum(CASE WHEN l.effective_state='active' AND NOT l.excluded THEN l.amount ELSE 0 END),0) obligation,
   sum(CASE WHEN NOT l.excluded THEN l.paid ELSE 0 END) paid,sum(CASE WHEN NOT l.excluded THEN l.allocated ELSE 0 END) allocated
  FROM live l LEFT JOIN raw root ON root.id=l.root_id GROUP BY l.root_id
 ),pool AS (
  SELECT CASE WHEN $2='payment' THEN $1 ELSE root_id END pool_id,
   CASE WHEN $2='payment' THEN coalesce($3,0) ELSE obligation END obligation,
   sum(paid) paid,sum(allocated)+CASE WHEN $2='payment' THEN $4 ELSE 0 END allocated
  FROM groups GROUP BY CASE WHEN $2='payment' THEN $1 ELSE root_id END,CASE WHEN $2='payment' THEN coalesce($3,0) ELSE obligation END
 ),effective AS (
  SELECT l.*,CASE WHEN $2='payment' THEN $1 ELSE root_id END pool_id,
   CASE WHEN effective_state='active' AND NOT excluded THEN greatest(0,amount-paid-allocated) ELSE 0 END remaining
  FROM live l
 ),root_coverage AS (
  SELECT g.root_id,g.obligation,g.paid,g.allocated,greatest(0,g.obligation-g.paid-g.allocated) remaining,
   greatest(0,g.obligation-g.paid-g.allocated-coalesce(sum(e.remaining),0)) unassigned
  FROM groups g LEFT JOIN effective e USING(root_id) GROUP BY g.root_id,g.obligation,g.paid,g.allocated
 ),coverage AS (
  SELECT p.pool_id,p.obligation,p.paid,p.allocated,greatest(0,p.obligation-p.paid-p.allocated) remaining,
   coalesce(sum(e.remaining),0) assigned,coalesce(sum(e.remaining) FILTER(WHERE e.due_date IS NOT NULL),0) planned
  FROM pool p LEFT JOIN effective e USING(pool_id) GROUP BY p.pool_id,p.obligation,p.paid,p.allocated
 )
 SELECT jsonb_build_object(
  'rows',coalesce((SELECT jsonb_object_agg(id,jsonb_build_object('rootId',root_id,'poolId',pool_id,'state',effective_state,'remaining',remaining,'nominalRemaining',remaining)) FROM effective),'{}'::jsonb),
  'roots',coalesce((SELECT jsonb_object_agg(root_id,jsonb_build_object('obligation',obligation,'paid',paid,'allocated',allocated,'remaining',remaining,'unassigned',unassigned)) FROM root_coverage),'{}'::jsonb),
  'pools',coalesce((SELECT jsonb_object_agg(pool_id,jsonb_build_object('obligation',obligation,'paid',paid,'allocated',allocated,'remaining',remaining,'planned',planned,'assigned',assigned,
   'unassigned',greatest(0,remaining-assigned),'undated',greatest(0,remaining-planned),'overplanned',greatest(0,assigned-remaining),'excess',greatest(0,paid+allocated-obligation))) FROM coverage),'{}'::jsonb),
  'summary',jsonb_build_object('obligation',coalesce((SELECT sum(obligation) FROM coverage),coalesce($3,0)),
   'paid',coalesce((SELECT sum(paid) FROM coverage),0),'allocated',coalesce((SELECT sum(allocated) FROM coverage),$4),
   'remaining',coalesce((SELECT sum(remaining) FROM coverage),greatest(0,coalesce($3,0)-$4)),
   'planned',coalesce((SELECT sum(planned) FROM coverage),0),'assigned',coalesce((SELECT sum(assigned) FROM coverage),0),
   'unassigned',coalesce((SELECT sum(greatest(0,remaining-assigned)) FROM coverage),greatest(0,coalesce($3,0)-$4)),
   'undated',coalesce((SELECT sum(greatest(0,remaining-planned)) FROM coverage),greatest(0,coalesce($3,0)-$4)),
   'overplanned',coalesce((SELECT sum(greatest(0,assigned-remaining)) FROM coverage),0)))
 $q$,source_sql) INTO result USING p_customer_id,p_kind,budget,extra_credit;
 RETURN result;
END;$$;
REVOKE ALL ON FUNCTION public.dowon_schedule_projection(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_schedule_projection(text,uuid) TO authenticated;

DO $$
DECLARE snapshot record;new_columns text[];row_hash text;row_count bigint;
BEGIN
 FOR snapshot IN SELECT * FROM dowon_renewal_financial_before LOOP
  new_columns:=CASE snapshot.table_name
   WHEN 'payment_schedules' THEN ARRAY['date_change_count']
   WHEN 'repayment_schedules' THEN ARRAY['date_change_count']
   WHEN 'recoveries' THEN ARRAY['accounting_version','row_version','success_fee_amount','installment_amount','client_return_amount']
   WHEN 'settlement_entries' THEN ARRAY['source_recovery_id','recovery_component','user_deleted']
   WHEN 'recovery_refunds' THEN ARRAY['settlement_hidden'] ELSE '{}'::text[] END;
  EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(t)-$1 ORDER BY coalesce(to_jsonb(t)->>''id'',to_jsonb(t)->>''recovery_id'')),''[]''::jsonb)::text),count(*) FROM public.%I t',snapshot.table_name)
   INTO row_hash,row_count USING new_columns;
  IF row_hash IS DISTINCT FROM snapshot.row_hash OR row_count IS DISTINCT FROM snapshot.row_count
   THEN RAISE EXCEPTION 'Migration changed existing financial rows in %; all changes rolled back',snapshot.table_name;END IF;
 END LOOP;
END;$$;

COMMIT;
