-- Bank statement rows represent external cash. Recovery success fees and
-- contract credits are allocations of that receipt, not additional deposits.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.customers,public.payment_schedules,public.repayment_schedules,
 public.recoveries,public.recovery_fee_allocations,public.recovery_fee_splits,
 public.recovery_refunds,public.additional_contracts,public.settlement_entries
 IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE dowon_bank_statement_before(table_name text PRIMARY KEY,row_hash text NOT NULL,row_count bigint NOT NULL) ON COMMIT DROP;
DO $$
DECLARE table_name text;row_hash text;row_count bigint;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['customers','payment_schedules','repayment_schedules','recoveries','recovery_fee_allocations','recovery_fee_splits','recovery_refunds','additional_contracts'] LOOP
  EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY coalesce(to_jsonb(t)->>''id'',to_jsonb(t)->>''recovery_id'')),''[]''::jsonb)::text),count(*) FROM public.%I t',table_name) INTO row_hash,row_count;
  INSERT INTO dowon_bank_statement_before VALUES(table_name,row_hash,row_count);
 END LOOP;
END;$$;
-- Keep manual corrections and explicit statement deletions byte-for-byte.
CREATE TEMP TABLE dowon_bank_statement_protected_before ON COMMIT DROP AS
 SELECT id,to_jsonb(s) AS original FROM public.settlement_entries s
 WHERE s.entry_source='manual' OR s.user_deleted;

-- Some legacy recoveries predate automatic statements and already have a
-- separate manual bank line. Remember the absence of an automatic source line
-- at this migration boundary; later memo edits or format conversion must not
-- quietly create a duplicate. This is source provenance, never fuzzy matching
-- by customer name, date or amount. New recoveries follow the normal writer.
CREATE TABLE IF NOT EXISTS dowon_private.recovery_bank_statement_exclusions(
 recovery_id uuid PRIMARY KEY REFERENCES public.recoveries(id),
 reason text NOT NULL
);
ALTER TABLE dowon_private.recovery_bank_statement_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dowon_private.recovery_bank_statement_exclusions FROM PUBLIC,anon,authenticated;
INSERT INTO dowon_private.recovery_bank_statement_exclusions(recovery_id,reason)
 SELECT DISTINCT r.id,'Legacy recovery had no automatic bank statement at migration boundary'
 FROM public.recoveries r JOIN public.payment_schedules p ON p.source_recovery_id=r.id
 WHERE r.accounting_version=1 AND r.deleted_at IS NULL AND p.deleted_at IS NULL
  AND p.paid_amount>0 AND p.paid_date IS NOT NULL AND p.status<>'환불'
  AND NOT EXISTS(
   SELECT 1 FROM public.settlement_entries s JOIN public.payment_schedules source ON source.id=s.source_payment_schedule_id
   WHERE source.source_recovery_id=r.id
  )
ON CONFLICT(recovery_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.sync_payment_schedule_to_settlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_name text;v_recovery boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  UPDATE settlement_entries SET deleted_at=coalesce(deleted_at,now())
   WHERE source_payment_schedule_id=old.id AND deleted_at IS NULL AND entry_source<>'manual' AND NOT user_deleted;
  RETURN old;
 END IF;
 v_recovery:=new.source_recovery_id IS NOT NULL OR new.schedule_type='환수';
 IF v_recovery AND EXISTS(SELECT 1 FROM dowon_private.recovery_bank_statement_exclusions e WHERE e.recovery_id=new.source_recovery_id)
  THEN RETURN new;END IF;
 -- Ordinary promise-only edits retain the existing receipt. A recovery edit
 -- always checks its gross bank line, including an automatically hidden line.
 IF NOT v_recovery AND TG_OP='UPDATE' AND new.paid_amount IS NOT DISTINCT FROM old.paid_amount
    AND new.paid_date IS NOT DISTINCT FROM old.paid_date
    AND (new.status='환불') IS NOT DISTINCT FROM (old.status='환불')
    AND new.deleted_at IS NOT DISTINCT FROM old.deleted_at THEN
  IF new.payment_method IS DISTINCT FROM old.payment_method OR new.customer_id IS DISTINCT FROM old.customer_id THEN
   SELECT name INTO v_name FROM customers WHERE id=new.customer_id;
   UPDATE settlement_entries SET payment_method=coalesce(nullif(new.payment_method,''),'계좌이체'),
    customer_id=new.customer_id,client_name=coalesce(v_name,'')
    WHERE source_payment_schedule_id=new.id AND NOT user_deleted AND entry_source<>'manual';
  END IF;
  RETURN new;
 END IF;
 IF new.deleted_at IS NOT NULL OR new.status='환불' OR coalesce(new.paid_amount,0)<=0 THEN
  UPDATE settlement_entries SET deleted_at=coalesce(deleted_at,now()) WHERE source_payment_schedule_id=new.id AND deleted_at IS NULL AND entry_source<>'manual';
  RETURN new;
 END IF;
 IF new.paid_date IS NULL AND NOT EXISTS(SELECT 1 FROM settlement_entries WHERE source_payment_schedule_id=new.id) THEN RETURN new;END IF;
 SELECT name INTO v_name FROM customers WHERE id=new.customer_id;
 INSERT INTO settlement_entries(payment_date,client_name,amount,payment_method,memo,customer_id,
  source_payment_schedule_id,entry_source,entry_type,deleted_at)
 VALUES(new.paid_date,coalesce(v_name,''),new.paid_amount,coalesce(nullif(new.payment_method,''),'계좌이체'),
  '[입금/분납 자동연동] 실제 입금 · '||coalesce(new.memo,''),new.customer_id,new.id,'payment',
  CASE WHEN v_recovery THEN '환수' ELSE '계약' END,NULL)
 ON CONFLICT(source_payment_schedule_id) WHERE source_payment_schedule_id IS NOT NULL DO UPDATE
 SET payment_date=excluded.payment_date,client_name=excluded.client_name,amount=excluded.amount,
  payment_method=excluded.payment_method,memo=excluded.memo,customer_id=excluded.customer_id,
  entry_source=excluded.entry_source,entry_type=excluded.entry_type,deleted_at=NULL
 WHERE NOT settlement_entries.user_deleted AND settlement_entries.entry_source<>'manual';
 RETURN new;
END;$$;
REVOKE ALL ON FUNCTION public.sync_payment_schedule_to_settlement() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.sync_recovery_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_payment_id uuid;v_memo text;v_name text;previous_returns numeric;remaining_return numeric;
BEGIN
 SELECT id INTO v_payment_id FROM public.payment_schedules WHERE source_recovery_id=new.id ORDER BY admin_created_at DESC NULLS LAST LIMIT 1;
 IF new.deleted_at IS NOT NULL THEN
  IF v_payment_id IS NOT NULL THEN UPDATE payment_schedules SET deleted_at=coalesce(deleted_at,now()) WHERE id=v_payment_id AND deleted_at IS NULL;END IF;
  UPDATE settlement_entries SET deleted_at=coalesce(deleted_at,now()) WHERE source_recovery_id=new.id AND deleted_at IS NULL AND entry_source='recovery';
  RETURN new;
 END IF;
 v_memo:='[환수] '||coalesce(nullif(new.lender_name,''),'업체 미지정')||CASE WHEN coalesce(new.memo,'')<>'' THEN ' · '||new.memo ELSE '' END;
 IF v_payment_id IS NULL THEN
  INSERT INTO payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,schedule_type,reschedule_sequence,source_recovery_id)
  VALUES(new.customer_id,new.recovery_date,new.amount,new.recovery_date,new.amount,'완료',new.payment_method,v_memo,'환수',0,new.id);
 ELSE
  UPDATE payment_schedules SET customer_id=new.customer_id,due_date=new.recovery_date,expected_amount=new.amount,
   paid_date=new.recovery_date,paid_amount=new.amount,status='완료',payment_method=new.payment_method,memo=v_memo,schedule_type='환수',deleted_at=NULL WHERE id=v_payment_id;
 END IF;
 -- Old component rows remain in the audit history, but never add a second
 -- incoming transaction on top of the gross recovery receipt.
 UPDATE settlement_entries SET deleted_at=coalesce(deleted_at,now())
  WHERE source_recovery_id=new.id AND entry_source='recovery'
   AND recovery_component IN ('success_fee','installment') AND deleted_at IS NULL;
 IF new.accounting_version<>2 THEN RETURN new;END IF;
 SELECT name INTO v_name FROM customers WHERE id=new.customer_id;
 SELECT coalesce(sum(amount),0) INTO previous_returns FROM recovery_refunds WHERE recovery_id=new.id;
 remaining_return:=new.client_return_amount-previous_returns;
 IF remaining_return<=0 THEN
  UPDATE settlement_entries SET deleted_at=coalesce(deleted_at,now())
   WHERE source_recovery_id=new.id AND recovery_component='client_return' AND entry_source='recovery' AND deleted_at IS NULL;
 ELSE
  INSERT INTO settlement_entries(payment_date,client_name,amount,payment_method,memo,customer_id,source_recovery_id,recovery_component,entry_source,entry_type,deleted_at)
  VALUES(new.recovery_date,coalesce(v_name,''),-remaining_return,new.payment_method,
   '의뢰인 환수 반환금 [업체:'||new.lender_name||'] [예금주:'||new.depositor_name||']'||CASE WHEN coalesce(new.memo,'')<>'' THEN ' · '||new.memo ELSE '' END,
   new.customer_id,new.id,'client_return','recovery','의뢰인 환수 반환금',NULL)
  ON CONFLICT(source_recovery_id,recovery_component) WHERE source_recovery_id IS NOT NULL DO UPDATE
  SET payment_date=excluded.payment_date,client_name=excluded.client_name,amount=excluded.amount,payment_method=excluded.payment_method,
   memo=excluded.memo,customer_id=excluded.customer_id,entry_source=excluded.entry_source,entry_type=excluded.entry_type,deleted_at=NULL
  WHERE NOT settlement_entries.user_deleted;
 END IF;
 RETURN new;
END;$$;
REVOKE ALL ON FUNCTION public.sync_recovery_payment() FROM PUBLIC,anon,authenticated;

-- Repair only the detailed-v2 model introduced by the component writer.
-- Legacy missing statement lines can have unlinked manual replacements and
-- are deliberately outside this backfill. Explicit gross deletions stay hidden.
UPDATE public.settlement_entries SET deleted_at=coalesce(deleted_at,now())
 WHERE entry_source='recovery' AND recovery_component IN ('success_fee','installment') AND deleted_at IS NULL;
INSERT INTO public.settlement_entries(payment_date,client_name,amount,payment_method,memo,customer_id,
 source_payment_schedule_id,entry_source,entry_type,deleted_at)
SELECT p.paid_date,coalesce(c.name,''),p.paid_amount,coalesce(nullif(p.payment_method,''),'계좌이체'),
 '[입금/분납 자동연동] 실제 입금 · '||coalesce(p.memo,''),p.customer_id,p.id,'payment','환수',NULL
 FROM public.payment_schedules p JOIN public.recoveries r ON r.id=p.source_recovery_id
 JOIN public.customers c ON c.id=p.customer_id
 WHERE r.accounting_version=2 AND r.deleted_at IS NULL AND p.deleted_at IS NULL
  AND p.paid_amount>0 AND p.paid_date IS NOT NULL AND p.status<>'환불'
  AND NOT EXISTS(SELECT 1 FROM dowon_private.recovery_bank_statement_exclusions e WHERE e.recovery_id=r.id)
ON CONFLICT(source_payment_schedule_id) WHERE source_payment_schedule_id IS NOT NULL DO UPDATE
 SET payment_date=excluded.payment_date,client_name=excluded.client_name,amount=excluded.amount,
  payment_method=excluded.payment_method,memo=excluded.memo,customer_id=excluded.customer_id,
  entry_source=excluded.entry_source,entry_type=excluded.entry_type,deleted_at=NULL
 WHERE NOT settlement_entries.user_deleted AND settlement_entries.entry_source<>'manual';

DO $$
DECLARE snapshot record;row_hash text;row_count bigint;
BEGIN
 FOR snapshot IN SELECT * FROM dowon_bank_statement_before LOOP
  EXECUTE format('SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY coalesce(to_jsonb(t)->>''id'',to_jsonb(t)->>''recovery_id'')),''[]''::jsonb)::text),count(*) FROM public.%I t',snapshot.table_name) INTO row_hash,row_count;
  IF row_hash IS DISTINCT FROM snapshot.row_hash OR row_count IS DISTINCT FROM snapshot.row_count
   THEN RAISE EXCEPTION 'Bank statement migration changed source facts in %; all changes rolled back',snapshot.table_name;END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM dowon_bank_statement_protected_before p LEFT JOIN public.settlement_entries s USING(id) WHERE to_jsonb(s) IS DISTINCT FROM p.original)
  THEN RAISE EXCEPTION 'Bank statement migration changed a manual or explicitly deleted statement; all changes rolled back';END IF;
END;$$;
COMMIT;
