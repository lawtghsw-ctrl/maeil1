-- Payment promises and cash are independent. No historical financial row is
-- rewritten by this migration. Legacy parent/leaf state is derived on read.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.payment_schedules ADD COLUMN IF NOT EXISTS promise_state text
 CHECK (promise_state IN ('active','rescheduled','cancelled'));
ALTER TABLE public.repayment_schedules ADD COLUMN IF NOT EXISTS promise_state text
 CHECK (promise_state IN ('active','rescheduled','cancelled'));
ALTER TABLE public.payment_schedules ADD COLUMN IF NOT EXISTS obligation_amount numeric
 CHECK (obligation_amount>=0 AND obligation_amount::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE public.repayment_schedules ADD COLUMN IF NOT EXISTS obligation_amount numeric
 CHECK (obligation_amount>=0 AND obligation_amount::text NOT IN ('NaN','Infinity','-Infinity'));
ALTER TABLE public.payment_schedules ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1;
ALTER TABLE public.repayment_schedules ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1;

-- Only the ancestor's obligation is exposed alongside live repayment rows;
-- historical deleted cash is neither restored nor included in receipt totals.
CREATE VIEW public.dowon_repayment_promises WITH(security_invoker=true) AS
 SELECT p.*,coalesce(root.obligation_amount,root.repayment_amount) root_obligation_amount
 FROM public.repayment_schedules p LEFT JOIN public.repayment_schedules root
  ON root.id=coalesce(p.root_schedule_id,p.rescheduled_from_id,p.id) AND root.customer_id=p.customer_id
 WHERE p.deleted_at IS NULL;
REVOKE ALL ON public.dowon_repayment_promises FROM PUBLIC,anon;
GRANT SELECT ON public.dowon_repayment_promises TO authenticated;

CREATE OR REPLACE FUNCTION public.dowon_schedule_version()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE old_amount numeric;
BEGIN
 IF TG_OP='UPDATE' THEN
  new.row_version:=old.row_version+1;
  old_amount:=CASE WHEN TG_TABLE_NAME='payment_schedules' THEN (to_jsonb(old)->>'expected_amount')::numeric
                   ELSE (to_jsonb(old)->>'repayment_amount')::numeric END;
  IF old.rescheduled_from_id IS NULL AND old.obligation_amount IS NULL AND new.obligation_amount IS NULL THEN
   new.obligation_amount:=old_amount;
  END IF;
 ELSE
  new.row_version:=1;
  new.promise_state:=coalesce(new.promise_state,'active');
  IF new.rescheduled_from_id IS NULL AND new.obligation_amount IS NULL THEN
   new.obligation_amount:=CASE WHEN TG_TABLE_NAME='payment_schedules' THEN (to_jsonb(new)->>'expected_amount')::numeric
                              ELSE (to_jsonb(new)->>'repayment_amount')::numeric END;
  END IF;
 END IF;
 RETURN new;
END;$$;
CREATE TRIGGER trg_dowon_promise_version BEFORE INSERT OR UPDATE ON public.payment_schedules
 FOR EACH ROW EXECUTE FUNCTION public.dowon_schedule_version();
CREATE TRIGGER trg_dowon_promise_version BEFORE INSERT OR UPDATE ON public.repayment_schedules
 FOR EACH ROW EXECUTE FUNCTION public.dowon_schedule_version();

-- One canonical projection. Payment debt comes from the actual customer
-- contract, never a sum of old promises. Repayment debt belongs to each root.
CREATE OR REPLACE FUNCTION public.dowon_schedule_projection(p_kind text,p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE source_sql text; budget numeric; result jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다'; END IF;
 IF p_kind='payment' THEN
  SELECT CASE WHEN c.is_accident THEN coalesce(c.accident_contract_amount,0)
   ELSE coalesce(c.contract_amount,0)+coalesce((SELECT sum(a.contract_amount) FROM additional_contracts a
     WHERE a.customer_id=c.id AND a.deleted_at IS NULL),0) END INTO budget
   FROM customers c WHERE c.id=p_customer_id AND c.deleted_at IS NULL;
  source_sql:='SELECT p.id,p.customer_id,p.root_schedule_id,p.rescheduled_from_id,p.expected_amount::numeric amount,
   p.obligation_amount,p.due_date,p.paid_amount::numeric paid,p.status,p.promise_state,p.deleted_at,
   coalesce((SELECT sum(a.amount) FROM recovery_fee_allocations a WHERE a.payment_schedule_id=p.id),0)::numeric allocated,
   (p.status=''환불'' OR p.schedule_type=''환수'') excluded FROM payment_schedules p WHERE p.customer_id=$1';
 ELSIF p_kind='repayment' THEN
  source_sql:='SELECT p.id,p.customer_id,p.root_schedule_id,p.rescheduled_from_id,p.repayment_amount::numeric amount,
   p.obligation_amount,p.repayment_date due_date,p.paid_amount::numeric paid,p.status,p.promise_state,p.deleted_at,
   0::numeric allocated,false excluded FROM repayment_schedules p WHERE p.customer_id=$1';
 ELSE RAISE EXCEPTION '일정 종류를 확인해주세요'; END IF;
 EXECUTE format($q$
 WITH raw AS (%s), linked AS (
  SELECT r.*,coalesce(r.root_schedule_id,parent.root_schedule_id,r.rescheduled_from_id,r.id) root_id
  FROM raw r LEFT JOIN raw parent ON parent.id=r.rescheduled_from_id
 ), live AS (
  SELECT r.*,CASE WHEN r.excluded THEN 'cancelled' ELSE coalesce(r.promise_state,CASE WHEN EXISTS(SELECT 1 FROM raw c WHERE c.rescheduled_from_id=r.id AND c.deleted_at IS NULL)
    THEN 'rescheduled' ELSE 'active' END) END effective_state
  FROM linked r WHERE r.deleted_at IS NULL
 ), groups AS (
  SELECT l.root_id,CASE WHEN $2='payment' THEN coalesce(max(root.obligation_amount),greatest(coalesce(max(root.amount),0),
    sum(CASE WHEN NOT l.excluded THEN l.paid+l.allocated ELSE 0 END)+
    sum(CASE WHEN l.effective_state='active' AND NOT l.excluded THEN greatest(0,l.amount-l.paid-l.allocated) ELSE 0 END)))
   ELSE coalesce(max(root.obligation_amount),max(root.amount),max(l.obligation_amount),max(l.amount),0) END obligation,
   sum(CASE WHEN NOT l.excluded THEN l.paid ELSE 0 END) paid,
   sum(CASE WHEN NOT l.excluded THEN l.allocated ELSE 0 END) allocated
  FROM live l LEFT JOIN raw root ON root.id=l.root_id GROUP BY l.root_id
 ), pool AS (
  SELECT CASE WHEN $2='payment' THEN $1 ELSE root_id END pool_id,
   CASE WHEN $2='payment' THEN coalesce($3,0) ELSE obligation END obligation,
   sum(paid) paid,sum(allocated) allocated
  FROM groups GROUP BY CASE WHEN $2='payment' THEN $1 ELSE root_id END,
   CASE WHEN $2='payment' THEN coalesce($3,0) ELSE obligation END
 ), nominal AS (
  SELECT l.*,CASE WHEN $2='payment' THEN $1 ELSE root_id END pool_id,
   CASE WHEN l.effective_state='active' AND NOT excluded THEN greatest(0,amount-paid-allocated) ELSE 0 END nominal_remaining
  FROM live l
 ), family_effective AS (
  SELECT n.*,least(n.nominal_remaining,greatest(0,g.obligation-g.paid-g.allocated-
    coalesce(sum(n.nominal_remaining) OVER (PARTITION BY n.root_id ORDER BY due_date ASC NULLS LAST,id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) family_remaining
  FROM nominal n JOIN groups g USING(root_id)
 ), effective AS (
  SELECT n.*,greatest(0,p.obligation-p.paid-p.allocated) debt,
   least(n.family_remaining,greatest(0,p.obligation-p.paid-p.allocated-
     coalesce(sum(n.family_remaining) OVER (PARTITION BY n.pool_id ORDER BY due_date ASC NULLS LAST,id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0))) remaining
  FROM family_effective n JOIN pool p USING(pool_id)
 ), root_coverage AS (
  SELECT g.root_id,g.obligation,g.paid,g.allocated,greatest(0,g.obligation-g.paid-g.allocated) remaining,
   greatest(0,g.obligation-g.paid-g.allocated-coalesce(sum(e.family_remaining),0)) unassigned
  FROM groups g LEFT JOIN effective e USING(root_id) GROUP BY g.root_id,g.obligation,g.paid,g.allocated
 ), coverage AS (
  SELECT p.pool_id,p.obligation,p.paid,p.allocated,greatest(0,p.obligation-p.paid-p.allocated) remaining,
   coalesce(sum(e.remaining),0) planned,coalesce(sum(e.remaining) FILTER(WHERE e.due_date IS NOT NULL),0) dated,
   greatest(0,coalesce(sum(e.nominal_remaining),0)-coalesce(sum(e.remaining),0)) overplanned
  FROM pool p LEFT JOIN effective e USING(pool_id) GROUP BY p.pool_id,p.obligation,p.paid,p.allocated
 )
 SELECT jsonb_build_object(
  'rows',coalesce((SELECT jsonb_object_agg(id,jsonb_build_object('rootId',root_id,'poolId',pool_id,'state',effective_state,
    'remaining',remaining,'nominalRemaining',nominal_remaining)) FROM effective),'{}'::jsonb),
  'roots',coalesce((SELECT jsonb_object_agg(root_id,jsonb_build_object('obligation',obligation,'paid',paid,'allocated',allocated,
    'remaining',remaining,'unassigned',unassigned)) FROM root_coverage),'{}'::jsonb),
  'pools',coalesce((SELECT jsonb_object_agg(pool_id,jsonb_build_object('obligation',obligation,'paid',paid,'allocated',allocated,
    'remaining',remaining,'planned',dated,'assigned',planned,'unassigned',remaining-planned,'undated',remaining-dated,'overplanned',overplanned,
    'excess',greatest(0,paid+allocated-obligation))) FROM coverage),'{}'::jsonb),
  'summary',jsonb_build_object('obligation',coalesce((SELECT sum(obligation) FROM coverage),coalesce($3,0)),
    'paid',coalesce((SELECT sum(paid) FROM coverage),0),'allocated',coalesce((SELECT sum(allocated) FROM coverage),0),
    'remaining',coalesce((SELECT sum(remaining) FROM coverage),coalesce($3,0)),
    'planned',coalesce((SELECT sum(dated) FROM coverage),0),'assigned',coalesce((SELECT sum(planned) FROM coverage),0),
    'unassigned',coalesce((SELECT sum(remaining-planned) FROM coverage),coalesce($3,0)),
    'undated',coalesce((SELECT sum(remaining-dated) FROM coverage),coalesce($3,0)),
    'overplanned',coalesce((SELECT sum(overplanned) FROM coverage),0)))
 $q$,source_sql) INTO result USING p_customer_id,p_kind,budget;
 RETURN result;
END;$$;
REVOKE ALL ON FUNCTION public.dowon_schedule_projection(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_schedule_projection(text,uuid) TO authenticated;

-- The primary settlement trigger is driven by actual cash, not a promise's
-- status. A cancelled/rescheduled promise therefore cannot remove its receipt.
CREATE OR REPLACE FUNCTION public.sync_payment_schedule_to_settlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_name text;
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE settlement_entries SET deleted_at=coalesce(deleted_at,now()) WHERE source_payment_schedule_id=old.id;
  RETURN old;
 END IF;
 IF TG_OP='UPDATE' AND new.paid_amount IS NOT DISTINCT FROM old.paid_amount
    AND new.paid_date IS NOT DISTINCT FROM old.paid_date
    AND (new.status='환불') IS NOT DISTINCT FROM (old.status='환불')
    AND new.deleted_at IS NOT DISTINCT FROM old.deleted_at THEN
  -- Editing a promise (including first-use budget freezing) must not rewrite
  -- an older settlement whose cash/date disagrees with the imported schedule.
  -- Those discrepancies require an explicit receipt correction, not a side
  -- effect of moving a due date, cancelling a promise, or changing its status.
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
 -- Do not manufacture a date for imported receipts whose date is unknown.
 IF new.paid_date IS NULL AND NOT EXISTS(SELECT 1 FROM settlement_entries WHERE source_payment_schedule_id=new.id) THEN RETURN new; END IF;
 SELECT name INTO v_name FROM customers WHERE id=new.customer_id;
 INSERT INTO settlement_entries(payment_date,client_name,amount,payment_method,memo,customer_id,
  source_payment_schedule_id,entry_source,entry_type,deleted_at)
 VALUES(new.paid_date,coalesce(v_name,''),new.paid_amount,coalesce(nullif(new.payment_method,''),'계좌이체'),
  '[입금/분납 자동연동] 실제 입금 · '||coalesce(new.memo,''),new.customer_id,new.id,'payment',
  CASE WHEN new.schedule_type='환수' THEN '환수' ELSE '계약' END,NULL)
 ON CONFLICT(source_payment_schedule_id) WHERE source_payment_schedule_id IS NOT NULL DO UPDATE
 SET payment_date=excluded.payment_date,client_name=excluded.client_name,amount=excluded.amount,
  payment_method=excluded.payment_method,memo=excluded.memo,customer_id=excluded.customer_id,
  entry_source=excluded.entry_source,entry_type=excluded.entry_type,deleted_at=NULL;
 RETURN new;
END;$$;
REVOKE ALL ON FUNCTION public.sync_payment_schedule_to_settlement() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_zz_dowon_partial_payment_settlement ON public.payment_schedules;

-- Preserve the well-tested field mapping and system-row restrictions, while
-- replacing its append/delete policy with explicit promise lifecycle handling.
ALTER FUNCTION public.dowon_save_schedules_flexible(text,uuid,jsonb,jsonb,uuid[]) RENAME TO dowon_write_schedule_rows_legacy;
REVOKE ALL ON FUNCTION public.dowon_write_schedule_rows_legacy(text,uuid,jsonb,jsonb,uuid[]) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.dowon_save_schedules_flexible(
 p_kind text,p_customer_id uuid,p_rows jsonb,p_carries jsonb,p_delete_ids uuid[]
) RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE item jsonb; part jsonb; parts jsonb; row_id uuid; table_name text; amount_column text;
 before_state jsonb; state jsonb; source jsonb; pool jsonb; record_before jsonb; current_row jsonb;
 total numeric; allowed numeric; before_over numeric; after_over numeric; new_obligation numeric;
 pool_id text; root_id text; source_state text; handled jsonb:='{}'; handled_family jsonb:='{}';
 versions_before jsonb; expanded_families jsonb:='{}'; allocation_extra numeric; changed integer; added integer:=0;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다'; END IF;
 IF p_kind NOT IN ('payment','repayment') OR p_customer_id IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
   OR jsonb_typeof(p_carries) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION '저장 요청 형식을 확인해주세요'; END IF;
 table_name:=CASE WHEN p_kind='payment' THEN 'payment_schedules' ELSE 'repayment_schedules' END;
 amount_column:=CASE WHEN p_kind='payment' THEN 'expected_amount' ELSE 'repayment_amount' END;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':'||p_kind,0));
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE nullif(j->>'id','') IS NOT NULL GROUP BY j->>'id' HAVING count(*)>1)
  THEN RAISE EXCEPTION '같은 일정이 저장 목록에 중복되어 있습니다'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_carries) c(key) WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE j->>'id'=c.key))
  THEN RAISE EXCEPTION '재약정 원본 행이 저장 목록에 없습니다'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) j WHERE nullif(j->>'id','')::uuid=ANY(p_delete_ids))
  THEN RAISE EXCEPTION '같은 일정을 수정과 삭제에 동시에 지정할 수 없습니다'; END IF;
 before_state:=dowon_schedule_projection(p_kind,p_customer_id);
 EXECUTE format('SELECT coalesce(jsonb_object_agg(id,row_version),''{}''::jsonb) FROM %I WHERE customer_id=$1 AND deleted_at IS NULL',table_name)
  INTO versions_before USING p_customer_id;
 -- A legacy family's budget must be captured BEFORE a new receipt changes its
 -- balance. Otherwise a late receipt can incorrectly consume another family's
 -- promise. The inferred amount preserves valid legacy expanded child plans.
 FOR root_id IN
  SELECT DISTINCT before_state->'rows'->affected.id->>'rootId' FROM (
   SELECT nullif(value->>'id','') id FROM jsonb_array_elements(p_rows)
   UNION SELECT unnest(coalesce(p_delete_ids,'{}'::uuid[]))::text
  ) affected WHERE affected.id IS NOT NULL
 LOOP
  IF root_id IS NOT NULL THEN
   EXECUTE format('UPDATE %I SET obligation_amount=$3 WHERE id=$1 AND customer_id=$2 AND obligation_amount IS NULL',table_name)
    USING root_id::uuid,p_customer_id,(before_state->'roots'->root_id->>'obligation')::numeric;
  END IF;
 END LOOP;

 -- Deletion cancels the promise only; the receipt and obligation remain.
 FOREACH row_id IN ARRAY coalesce(p_delete_ids,'{}'::uuid[]) LOOP
  EXECUTE format('SELECT to_jsonb(p) FROM %I p WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL FOR UPDATE',table_name)
    INTO record_before USING row_id,p_customer_id;
  IF record_before IS NULL THEN RAISE EXCEPTION '삭제 대상의 고객 또는 현재 상태를 확인해주세요'; END IF;
  IF p_kind='payment' AND (record_before->>'schedule_type' IN ('환수','추가계약') OR record_before->>'source_recovery_id' IS NOT NULL OR record_before->>'source_additional_contract_id' IS NOT NULL)
   THEN RAISE EXCEPTION '자동 생성 일정은 추가계약·환수 관리에서 수정해주세요'; END IF;
  EXECUTE format('UPDATE %I SET promise_state=''cancelled'' WHERE id=$1',table_name) USING row_id;
 END LOOP;

 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  row_id:=nullif(item->>'id','')::uuid;
  IF row_id IS NOT NULL THEN
   EXECUTE format('SELECT to_jsonb(p) FROM %I p WHERE id=$1 AND customer_id=$2 AND deleted_at IS NULL FOR UPDATE',table_name)
    INTO record_before USING row_id,p_customer_id;
   IF record_before IS NULL THEN RAISE EXCEPTION '현재 고객의 일정을 찾지 못했습니다'; END IF;
   IF item ? 'expectedVersion' AND (item->>'expectedVersion')::bigint IS DISTINCT FROM (versions_before->>row_id::text)::bigint
    THEN RAISE EXCEPTION '다른 화면에서 일정이 변경되었습니다. 새로 불러온 뒤 저장해주세요'; END IF;
   -- Increasing an active payment promise explicitly assigns previously
   -- unassigned contract debt to that family. Cash-only changes never do this.
   IF p_kind='payment' AND before_state->'rows'->row_id::text->>'state'='active' AND
      coalesce((item->>'dueAmount')::numeric,0)>(record_before->>'expected_amount')::numeric THEN
    root_id:=before_state->'rows'->row_id::text->>'rootId';
    expanded_families:=jsonb_set(expanded_families,ARRAY[root_id],'true'::jsonb);
   END IF;
  ELSE record_before:=NULL; END IF;
  -- Core mapping never sees carries or deletes; it cannot erase a cash row.
  PERFORM dowon_private.dowon_write_schedule_rows_legacy(p_kind,p_customer_id,jsonb_build_array(item),'{}','{}');
  IF item->>'promiseState'='cancelled' THEN
   IF row_id IS NULL THEN RAISE EXCEPTION '새 일정은 등록 후 취소해주세요'; END IF;
   IF record_before->>'promise_state' IS DISTINCT FROM 'cancelled' AND p_carries ? row_id::text
     AND p_carries->row_id::text IS DISTINCT FROM '[]'::jsonb
    THEN RAISE EXCEPTION '일정 취소와 재약정을 동시에 지정할 수 없습니다'; END IF;
   EXECUTE format('UPDATE %I SET promise_state=''cancelled'' WHERE id=$1 AND promise_state IS DISTINCT FROM ''cancelled''',table_name) USING row_id;
  END IF;
  IF row_id IS NOT NULL AND item ? 'obligationAmount' AND
     (item->>'obligationAmount')::numeric IS DISTINCT FROM (record_before->>'obligation_amount')::numeric THEN
   IF p_kind='payment' THEN RAISE EXCEPTION '고객 계약금액은 계약 관리에서 변경해주세요'; END IF;
   IF record_before->>'rescheduled_from_id' IS NOT NULL THEN RAISE EXCEPTION '원본 상환 일정에서 채무금액을 변경해주세요'; END IF;
   new_obligation:=(item->>'obligationAmount')::numeric;
   IF new_obligation IS NULL OR new_obligation<0 OR new_obligation::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION '채무금액을 확인해주세요'; END IF;
   EXECUTE format('UPDATE %I SET obligation_amount=$2 WHERE id=$1',table_name) USING row_id,new_obligation;
  END IF;
 END LOOP;

 state:=dowon_schedule_projection(p_kind,p_customer_id);
 IF p_kind='payment' THEN
  FOR root_id IN SELECT key FROM jsonb_object_keys(expanded_families) k(key) ORDER BY key LOOP
   SELECT greatest(0,coalesce(sum((value->>'nominalRemaining')::numeric),0)+
     coalesce((state->'roots'->root_id->>'paid')::numeric,0)+coalesce((state->'roots'->root_id->>'allocated')::numeric,0)-
     coalesce((state->'roots'->root_id->>'obligation')::numeric,0)) INTO allocation_extra
    FROM jsonb_each(state->'rows') WHERE value->>'rootId'=root_id;
   -- Cash already received above this family's old budget is not new promised
   -- debt. Account for it without consuming the unassigned future balance twice.
   allocation_extra:=least(allocation_extra,coalesce((state->'summary'->>'unassigned')::numeric,0)+greatest(0,
    coalesce((state->'roots'->root_id->>'paid')::numeric,0)+coalesce((state->'roots'->root_id->>'allocated')::numeric,0)-
    coalesce((state->'roots'->root_id->>'obligation')::numeric,0)));
   IF allocation_extra>0 THEN
    UPDATE payment_schedules SET obligation_amount=obligation_amount+allocation_extra
     WHERE id=root_id::uuid AND customer_id=p_customer_id AND obligation_amount IS NOT NULL;
    state:=dowon_schedule_projection(p_kind,p_customer_id);
   END IF;
  END LOOP;
 END IF;
 -- A memo/cash correction must not be blocked by old inconsistent plans. Only
 -- newly enlarged promise coverage is rejected; receipts can always reduce debt.
 FOR pool_id,pool IN SELECT key,value FROM jsonb_each(state->'pools') LOOP
  before_over:=coalesce((before_state->'pools'->pool_id->>'overplanned')::numeric,0);
  after_over:=coalesce((pool->>'overplanned')::numeric,0);
  -- Check each repayment obligation separately. An underplanned second lender
  -- cannot make an oversized promise to the first lender valid.
  IF after_over>before_over AND
    (SELECT coalesce(sum((value->>'nominalRemaining')::numeric),0) FROM jsonb_each(state->'rows') WHERE value->>'poolId'=pool_id) >
    (SELECT coalesce(sum((value->>'nominalRemaining')::numeric),0) FROM jsonb_each(before_state->'rows') WHERE value->>'poolId'=pool_id)
   THEN RAISE EXCEPTION '예정금액이 남은 채무보다 큽니다. 금액 차이를 확인해주세요'; END IF;
 END LOOP;

 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  row_id:=nullif(item->>'id','')::uuid;
  IF row_id IS NULL OR NOT p_carries ? row_id::text THEN CONTINUE; END IF;
  parts:=p_carries->(row_id::text);
  IF jsonb_typeof(parts)='object' THEN parts:=jsonb_build_array(parts); END IF;
  IF jsonb_typeof(parts) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '새 일정 형식을 확인해주세요'; END IF;
  IF jsonb_array_length(parts)=0 THEN CONTINUE; END IF;
  source:=state->'rows'->row_id::text; root_id:=source->>'rootId';pool_id:=source->>'poolId';source_state:=source->>'state';
  IF source IS NULL THEN RAISE EXCEPTION '재약정 원본 일정을 찾지 못했습니다'; END IF;
  allowed:=coalesce((source->>'remaining')::numeric,0);
  IF source_state<>'active' THEN
   EXECUTE format('SELECT to_jsonb(p) FROM %I p WHERE id=$1',table_name) INTO current_row USING row_id;
   IF root_id<>row_id::text AND state->'rows' ? coalesce(current_row->>'rescheduled_from_id','')
    THEN RAISE EXCEPTION '이전 재약정은 이력입니다. 현재 일정이나 날짜 미정 잔액을 선택해주세요'; END IF;
   allowed:=least(greatest(0,coalesce((state->'pools'->pool_id->>'unassigned')::numeric,0)-coalesce((handled->>pool_id)::numeric,0)),
    greatest(0,coalesce((state->'roots'->root_id->>'unassigned')::numeric,0)-coalesce((handled_family->>root_id)::numeric,0)));
  END IF;
  total:=0;
  FOR part IN SELECT value FROM jsonb_array_elements(parts) LOOP
   new_obligation:=coalesce((part->>CASE WHEN p_kind='payment' THEN 'dueAmount' ELSE 'amount' END)::numeric,0);
   IF new_obligation<=0 OR new_obligation::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION '새 일정 금액은 0보다 큰 유한한 숫자로 입력해주세요'; END IF;
   total:=total+new_obligation;
  END LOOP;
  IF total>allowed THEN RAISE EXCEPTION '새 일정 합계 %원이 남은 금액 %원을 초과합니다',total,allowed; END IF;
  IF source_state<>'active' THEN
   handled:=jsonb_set(handled,ARRAY[pool_id],to_jsonb(coalesce((handled->>pool_id)::numeric,0)+total));
   handled_family:=jsonb_set(handled_family,ARRAY[root_id],to_jsonb(coalesce((handled_family->>root_id)::numeric,0)+total));
  END IF;
  -- Preserve cash exactly; insert children using the original mapper only.
  EXECUTE format('SELECT to_jsonb(p) FROM %I p WHERE id=$1',table_name) INTO current_row USING row_id;
  added:=added+dowon_private.dowon_write_schedule_rows_legacy(p_kind,p_customer_id,jsonb_build_array(item),jsonb_build_object(row_id::text,parts),'{}');
  EXECUTE format('UPDATE %I SET promise_state=''rescheduled'' WHERE id=$1',table_name) USING row_id;
 END LOOP;
 RETURN added;
END;$$;
REVOKE ALL ON FUNCTION public.dowon_save_schedules_flexible(text,uuid,jsonb,jsonb,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_save_schedules_flexible(text,uuid,jsonb,jsonb,uuid[]) TO authenticated;
-- Invoker functions need EXECUTE on the internal mapper. Hide it from PostgREST
-- by placing it in the already-private schema, retaining invoker/RLS semantics.
ALTER FUNCTION public.dowon_write_schedule_rows_legacy(text,uuid,jsonb,jsonb,uuid[]) SET SCHEMA dowon_private;
GRANT EXECUTE ON FUNCTION dowon_private.dowon_write_schedule_rows_legacy(text,uuid,jsonb,jsonb,uuid[]) TO authenticated;

-- Only the version-checked endpoint exposes writes through the Data API.
-- Existing open tabs receive an explicit refresh error instead of overwriting
-- newer cash with an unversioned full-form payload. Private engines retain RLS.
ALTER FUNCTION public.dowon_save_schedules_flexible(text,uuid,jsonb,jsonb,uuid[]) SET SCHEMA dowon_private;
ALTER FUNCTION dowon_private.dowon_save_schedules_flexible(text,uuid,jsonb,jsonb,uuid[]) RENAME TO dowon_apply_schedule_promises;
CREATE FUNCTION public.dowon_save_schedules_flexible(text,uuid,jsonb,jsonb,uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN RAISE EXCEPTION '화면이 업데이트되었습니다. 새로고침한 뒤 저장해주세요'; END;$$;
REVOKE ALL ON FUNCTION public.dowon_save_schedules_flexible(text,uuid,jsonb,jsonb,uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_save_schedules_flexible(text,uuid,jsonb,jsonb,uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.dowon_save_payment_batch(p_customer_id uuid,p_rows jsonb,p_carries jsonb DEFAULT '{}'::jsonb,p_delete_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN RAISE EXCEPTION '화면이 업데이트되었습니다. 새로고침한 뒤 저장해주세요'; END;$$;
CREATE OR REPLACE FUNCTION public.dowon_save_repayment_batch(p_customer_id uuid,p_rows jsonb,p_carries jsonb DEFAULT '{}'::jsonb,p_delete_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN RAISE EXCEPTION '화면이 업데이트되었습니다. 새로고침한 뒤 저장해주세요'; END;$$;

CREATE OR REPLACE FUNCTION public.dowon_save_schedule_batch_v2(
 p_kind text,p_customer_id uuid,p_rows jsonb,p_carries jsonb,p_delete_ids uuid[],p_request_key uuid,p_versions jsonb
) RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor uuid:=auth.uid(); input jsonb; previous dowon_private.save_requests%ROWTYPE;
 result integer; versions jsonb; table_name text;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다'; END IF;
 IF p_request_key IS NULL OR p_kind NOT IN ('payment','repayment') OR jsonb_typeof(p_versions) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION '저장 요청 버전을 확인해주세요'; END IF;
 input:=jsonb_build_object('kind',p_kind,'customer',p_customer_id,'rows',p_rows,'carries',p_carries,'deleted',p_delete_ids,'versions',p_versions);
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_key::text,0));
 SELECT * INTO previous FROM dowon_private.save_requests WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN
  IF previous.payload IS DISTINCT FROM input THEN RAISE EXCEPTION '동일 요청 키의 내용이 변경되었습니다'; END IF;
  RETURN previous.result;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':'||p_kind,0));
 table_name:=CASE WHEN p_kind='payment' THEN 'payment_schedules' ELSE 'repayment_schedules' END;
 -- Hold existing rows before comparing the snapshot, including against direct
 -- table updates that do not participate in the API's advisory lock.
 EXECUTE format('SELECT id FROM %I WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY id FOR UPDATE',table_name)
  USING p_customer_id;
 EXECUTE format('SELECT coalesce(jsonb_object_agg(id,row_version),''{}''::jsonb) FROM %I WHERE customer_id=$1 AND deleted_at IS NULL',table_name)
  INTO versions USING p_customer_id;
 IF versions IS DISTINCT FROM p_versions THEN RAISE EXCEPTION '다른 화면에서 일정이 변경되었습니다. 새로 불러온 뒤 저장해주세요'; END IF;
 result:=dowon_private.dowon_apply_schedule_promises(p_kind,p_customer_id,p_rows,p_carries,p_delete_ids);
 INSERT INTO dowon_private.save_requests(actor_id,request_key,payload,result) VALUES(actor,p_request_key,input,result);
 RETURN result;
END;$$;
REVOKE ALL ON FUNCTION public.dowon_save_schedule_batch_v2(text,uuid,jsonb,jsonb,uuid[],uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_save_schedule_batch_v2(text,uuid,jsonb,jsonb,uuid[],uuid,jsonb) TO authenticated;

-- Old split endpoints cannot write without a complete version snapshot.
CREATE OR REPLACE FUNCTION public.dowon_split_rescheduled_payment(p_source_id uuid,p_new_date date,p_amount numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN RAISE EXCEPTION '화면이 업데이트되었습니다. 새로고침한 뒤 저장해주세요'; END;$$;
REVOKE ALL ON FUNCTION public.dowon_split_rescheduled_payment(uuid,date,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dowon_split_rescheduled_payment(uuid,date,numeric) TO authenticated;

COMMIT;
