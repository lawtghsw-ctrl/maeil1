-- 로파워 사채 ADMIN web feature patch (source: tg_m 9177f4b).
-- Metadata and executable functions only. NO source-company rows, seeds,
-- reset, historical repairs, finance backfills, native apps, phone/SMS dispatch.
-- Existing numeric amounts, employee defaults, auth users and RBAC are retained.
-- dowon_* names are legacy SQL identifiers inside THIS database only.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SET LOCAL check_function_bodies=off;
LOCK TABLE "public"."additional_contracts","public"."board_attachments","public"."board_posts","public"."change_history","public"."customer_calculation_snapshots","public"."customer_calculator_items","public"."customers","public"."lender_contacts","public"."lender_customers","public"."lenders","public"."meta_leads","public"."negotiation_guidelines","public"."payment_schedules","public"."profiles","public"."recoveries","public"."repayment_schedules","public"."settlement_entries" IN SHARE ROW EXCLUSIVE MODE;

-- Refuse the entire transaction if any original column value or row changes.
CREATE TEMP TABLE ropower_patch_before(table_name text PRIMARY KEY,projection text NOT NULL,row_count bigint NOT NULL,row_hash text NOT NULL) ON COMMIT DROP;
DO $guard$
DECLARE spec record;row_count bigint;row_hash text;
BEGIN
 FOR spec IN SELECT * FROM (VALUES
  ('public.additional_contracts','"id","customer_id","contract_date","contract_amount","upfront_amount","installment_period","lender_unit_price","lender_count","memo","admin_created_at","updated_at","deleted_at","is_renegotiation"'),
  ('public.board_attachments','"id","post_id","file_name","storage_path","file_size","mime_type","created_at"'),
  ('public.board_posts','"id","title","body","author","post_date","is_notice","notice_order","admin_created_at","deleted_at"'),
  ('public.change_history','"id","occurred_at","category","action","table_name","record_id","actor_id","actor_name","source","old_data","new_data","dedupe_key","created_at"'),
  ('public.customer_calculation_snapshots','"id","customer_id","scenario","total_contract_fee","current_repayment_amount","expected_negotiated_amount","reduction_benefit","extension_savings","total_economic_benefit","net_economic_benefit","benefit_multiple","snapshot_data","created_at"'),
  ('public.customer_calculator_items','"id","customer_id","repayment_schedule_id","cumulative_principal","last_principal","repaid_amount","selected_period","extension_fee","extension_cycle_days","expected_extension_count","target_amount","target_days","memo","created_at","updated_at"'),
  ('public.customers','"id","registered_at","admin_created_at","name","phone","address","birth_number","manager","sales_manager","coordination_manager","memo","contract_date","contract_amount","upfront_amount","installment_period","lender_unit_price","lender_count","is_accident","accident_contract_amount","accident_marked_at","eformsign_document_id","eformsign_status","eformsign_updated_at","deleted_at","legacy_imported"'),
  ('public.lender_contacts','"id","lender_id","contact_type","contact_value","sort_order","created_at"'),
  ('public.lender_customers','"id","lender_id","customer_id","created_at"'),
  ('public.lenders','"id","created_at","admin_created_at","name","account_info","memo","deleted_at"'),
  ('public.meta_leads','"id","meta_lead_id","meta_native_lead_id","created_at","customer_name","phone_number","manager","sales_manager","coordination_manager","lender_count","memo","lead_result","meta_event_name","meta_event_sent_at","meta_event_error","status","customer_id","converted_at","collection_intensity","principal_amount","repayment_total","evidence","third_party_damage","source_row_number","new_db_alert_enabled"'),
  ('public.negotiation_guidelines','"id","contact_type","default_period","fixed_extra_amount","principal_add_rate","min_days","standard_days","max_days","min_reduction_rate","standard_reduction_rate","max_reduction_rate","memo","created_at","updated_at","guide_1w_amount","guide_2w_amount","guide_3w_amount","guide_4w_amount","guide_2m_amount"'),
  ('public.payment_schedules','"id","customer_id","due_date","expected_amount","paid_date","paid_amount","status","payment_method","memo","schedule_type","root_schedule_id","rescheduled_from_id","reschedule_sequence","source_additional_contract_id","source_recovery_id","admin_created_at","deleted_at","legacy_imported","legacy_source_row","legacy_source_kind","legacy_reconcile_note"'),
  ('public.profiles','"id","name","role","created_at","updated_at"'),
  ('public.recoveries','"id","customer_id","recovery_date","lender_name","recovery_type","amount","payment_method","memo","admin_created_at","updated_at","deleted_at","legacy_imported"'),
  ('public.repayment_schedules','"id","customer_id","lender_name","lender_contact_type","lender_contact_value","repayment_date","repayment_amount","account_info","status","memo","admin_created_at","deleted_at"'),
  ('public.settlement_entries','"id","payment_date","client_name","amount","payment_method","memo","customer_id","source_payment_schedule_id","entry_source","entry_type","admin_created_at","deleted_at","legacy_imported","legacy_source_row","legacy_source_kind"')
 ) AS tables(table_name,projection) LOOP
  EXECUTE format('SELECT count(*),md5(coalesce(jsonb_agg(to_jsonb(q) ORDER BY to_jsonb(q)::text),''[]''::jsonb)::text) FROM (SELECT %s FROM %s) q',spec.projection,spec.table_name) INTO row_count,row_hash;
  INSERT INTO ropower_patch_before VALUES(spec.table_name,spec.projection,row_count,row_hash);
 END LOOP;
END;$guard$;

CREATE SCHEMA IF NOT EXISTS dowon_private;
REVOKE ALL ON SCHEMA dowon_private FROM PUBLIC,anon;
GRANT USAGE ON SCHEMA dowon_private TO authenticated,service_role;

CREATE TABLE "dowon_private"."recovery_bank_statement_exclusions" (
 "recovery_id" uuid NOT NULL,
 "reason" text NOT NULL
);
ALTER TABLE "dowon_private"."recovery_bank_statement_exclusions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "dowon_private"."recovery_bank_statement_exclusions" FROM PUBLIC,anon,authenticated;

CREATE TABLE "dowon_private"."save_requests" (
 "actor_id" uuid NOT NULL,
 "request_key" uuid NOT NULL,
 "payload" jsonb NOT NULL,
 "result" integer NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "dowon_private"."save_requests" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "dowon_private"."save_requests" FROM PUBLIC,anon,authenticated;

CREATE TABLE "public"."lead_call_logs" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "lead_source" text NOT NULL,
 "lead_id" uuid NOT NULL,
 "call_result" text NOT NULL,
 "note" text DEFAULT ''::text NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "created_by" uuid DEFAULT auth.uid()
);
ALTER TABLE "public"."lead_call_logs" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."lead_call_logs" FROM PUBLIC,anon,authenticated;

CREATE TABLE "public"."recovery_fee_allocations" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "recovery_id" uuid NOT NULL,
 "customer_id" uuid NOT NULL,
 "payment_schedule_id" uuid NOT NULL,
 "amount" numeric(14,0) NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "public"."recovery_fee_allocations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."recovery_fee_allocations" FROM PUBLIC,anon,authenticated;

CREATE TABLE "public"."recovery_fee_splits" (
 "recovery_id" uuid NOT NULL,
 "customer_id" uuid NOT NULL,
 "success_fee" numeric(14,0) NOT NULL,
 "applied_fee" numeric(14,0) NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "refund_due" numeric(14,0) DEFAULT 0 NOT NULL
);
ALTER TABLE "public"."recovery_fee_splits" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."recovery_fee_splits" FROM PUBLIC,anon,authenticated;

CREATE TABLE "public"."recovery_refunds" (
 "id" uuid DEFAULT gen_random_uuid() NOT NULL,
 "recovery_id" uuid NOT NULL,
 "customer_id" uuid NOT NULL,
 "refund_date" date NOT NULL,
 "amount" numeric(14,0) NOT NULL,
 "recipient_name" text NOT NULL,
 "payment_method" text DEFAULT '계좌이체'::text NOT NULL,
 "memo" text DEFAULT ''::text NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL,
 "request_key" uuid NOT NULL,
 "settlement_hidden" boolean DEFAULT false NOT NULL,
 "cancelled_at" timestamp with time zone
);
ALTER TABLE "public"."recovery_refunds" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "public"."recovery_refunds" FROM PUBLIC,anon,authenticated;

-- Add fields without changing any existing field or numeric type.
ALTER TABLE "public"."board_posts" ADD COLUMN "created_by" uuid;
ALTER TABLE "public"."board_posts" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "public"."board_posts" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "public"."customers" ADD COLUMN "created_by" uuid;
ALTER TABLE "public"."customers" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "public"."customers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "public"."customers" ADD COLUMN "is_accident_risk" boolean DEFAULT false NOT NULL;
ALTER TABLE "public"."customers" ADD COLUMN "accident_risk_marked_at" timestamp with time zone;
ALTER TABLE "public"."customers" ADD COLUMN "monthly_net_salary" numeric;
ALTER TABLE "public"."customers" ADD COLUMN "salary_day" integer;
ALTER TABLE "public"."customers" ADD COLUMN "hide_missing_repayment" boolean DEFAULT false NOT NULL;
ALTER TABLE "public"."lenders" ADD COLUMN "created_by" uuid;
ALTER TABLE "public"."lenders" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "public"."meta_leads" ADD COLUMN "page_id" text;
ALTER TABLE "public"."meta_leads" ADD COLUMN "form_id" text;
ALTER TABLE "public"."meta_leads" ADD COLUMN "ad_id" text;
ALTER TABLE "public"."meta_leads" ADD COLUMN "adset_id" text;
ALTER TABLE "public"."meta_leads" ADD COLUMN "campaign_id" text;
ALTER TABLE "public"."meta_leads" ADD COLUMN "raw_meta" jsonb;
ALTER TABLE "public"."meta_leads" ADD COLUMN "status_changed_at" timestamp with time zone;
ALTER TABLE "public"."meta_leads" ADD COLUMN "meta_capi_last_event" text;
ALTER TABLE "public"."meta_leads" ADD COLUMN "meta_capi_last_event_id" text;
ALTER TABLE "public"."meta_leads" ADD COLUMN "meta_capi_last_sent_at" timestamp with time zone;
ALTER TABLE "public"."meta_leads" ADD COLUMN "meta_capi_last_error" text;
ALTER TABLE "public"."meta_leads" ADD COLUMN "lead_stage" text DEFAULT '신규'::text NOT NULL;
ALTER TABLE "public"."payment_schedules" ADD COLUMN "created_by" uuid;
ALTER TABLE "public"."payment_schedules" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "public"."payment_schedules" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "public"."payment_schedules" ADD COLUMN "promise_state" text;
ALTER TABLE "public"."payment_schedules" ADD COLUMN "obligation_amount" numeric;
ALTER TABLE "public"."payment_schedules" ADD COLUMN "row_version" bigint DEFAULT 1 NOT NULL;
ALTER TABLE "public"."payment_schedules" ADD COLUMN "date_change_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "public"."profiles" ADD COLUMN "email" text;
ALTER TABLE "public"."profiles" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;
ALTER TABLE "public"."recoveries" ADD COLUMN "depositor_name" text DEFAULT ''::text NOT NULL;
ALTER TABLE "public"."recoveries" ADD COLUMN "accounting_version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "public"."recoveries" ADD COLUMN "row_version" bigint DEFAULT 1 NOT NULL;
ALTER TABLE "public"."recoveries" ADD COLUMN "success_fee_amount" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "public"."recoveries" ADD COLUMN "installment_amount" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "public"."recoveries" ADD COLUMN "client_return_amount" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "public"."repayment_schedules" ADD COLUMN "created_by" uuid;
ALTER TABLE "public"."repayment_schedules" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "public"."repayment_schedules" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "public"."repayment_schedules" ADD COLUMN "paid_amount" numeric DEFAULT 0 NOT NULL;
ALTER TABLE "public"."repayment_schedules" ADD COLUMN "paid_date" date;
ALTER TABLE "public"."repayment_schedules" ADD COLUMN "rescheduled_from_id" uuid;
ALTER TABLE "public"."repayment_schedules" ADD COLUMN "root_schedule_id" uuid;
ALTER TABLE "public"."repayment_schedules" ADD COLUMN "reschedule_sequence" integer DEFAULT 0 NOT NULL;
ALTER TABLE "public"."repayment_schedules" ADD COLUMN "promise_state" text;
ALTER TABLE "public"."repayment_schedules" ADD COLUMN "obligation_amount" numeric;
ALTER TABLE "public"."repayment_schedules" ADD COLUMN "row_version" bigint DEFAULT 1 NOT NULL;
ALTER TABLE "public"."repayment_schedules" ADD COLUMN "date_change_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "public"."settlement_entries" ADD COLUMN "created_by" uuid;
ALTER TABLE "public"."settlement_entries" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "public"."settlement_entries" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "public"."settlement_entries" ADD COLUMN "source_recovery_id" uuid;
ALTER TABLE "public"."settlement_entries" ADD COLUMN "recovery_component" text;
ALTER TABLE "public"."settlement_entries" ADD COLUMN "user_deleted" boolean DEFAULT false NOT NULL;
ALTER TABLE public.recoveries ALTER COLUMN accounting_version SET DEFAULT 2;

-- The old zero-on-close trigger conflicts with retaining original obligations.
DROP TRIGGER IF EXISTS trg_force_closed_repayment_zero ON public.repayment_schedules;
-- A parent can have several manually saved follow-up promises. Dropping this
-- obsolete uniqueness index changes no historical schedule or link.
DROP INDEX IF EXISTS public.payment_schedules_rescheduled_from_unique_idx;
ALTER TABLE "dowon_private"."recovery_bank_statement_exclusions" ADD CONSTRAINT "recovery_bank_statement_exclusions_pkey" PRIMARY KEY (recovery_id);
ALTER TABLE "dowon_private"."save_requests" ADD CONSTRAINT "save_requests_pkey" PRIMARY KEY (actor_id, request_key);
ALTER TABLE "public"."lead_call_logs" ADD CONSTRAINT "lead_call_logs_call_result_check" CHECK ((call_result = ANY (ARRAY['부재'::text, '연결'::text])));
ALTER TABLE "public"."lead_call_logs" ADD CONSTRAINT "lead_call_logs_lead_source_check" CHECK ((lead_source = ANY (ARRAY['meta'::text, 'external'::text])));
ALTER TABLE "public"."lead_call_logs" ADD CONSTRAINT "lead_call_logs_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."recovery_fee_allocations" ADD CONSTRAINT "recovery_fee_allocations_amount_check" CHECK ((amount > (0)::numeric));
ALTER TABLE "public"."recovery_fee_allocations" ADD CONSTRAINT "recovery_fee_allocations_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."recovery_fee_allocations" ADD CONSTRAINT "recovery_fee_allocations_recovery_id_payment_schedule_id_key" UNIQUE (recovery_id, payment_schedule_id);
ALTER TABLE "public"."recovery_fee_splits" ADD CONSTRAINT "recovery_fee_splits_applied_fee_check" CHECK ((applied_fee >= (0)::numeric));
ALTER TABLE "public"."recovery_fee_splits" ADD CONSTRAINT "recovery_fee_splits_check" CHECK (((success_fee + applied_fee) >= (0)::numeric));
ALTER TABLE "public"."recovery_fee_splits" ADD CONSTRAINT "recovery_fee_splits_pkey" PRIMARY KEY (recovery_id);
ALTER TABLE "public"."recovery_fee_splits" ADD CONSTRAINT "recovery_fee_splits_refund_due_check" CHECK ((refund_due >= (0)::numeric));
ALTER TABLE "public"."recovery_fee_splits" ADD CONSTRAINT "recovery_fee_splits_success_fee_check" CHECK ((success_fee >= (0)::numeric));
ALTER TABLE "public"."recovery_refunds" ADD CONSTRAINT "recovery_refunds_amount_check" CHECK (((amount > (0)::numeric) AND (amount = trunc(amount))));
ALTER TABLE "public"."recovery_refunds" ADD CONSTRAINT "recovery_refunds_pkey" PRIMARY KEY (id);
ALTER TABLE "public"."recovery_refunds" ADD CONSTRAINT "recovery_refunds_recipient_name_check" CHECK ((length(btrim(recipient_name)) > 0));
ALTER TABLE "public"."recovery_refunds" ADD CONSTRAINT "recovery_refunds_request_key_key" UNIQUE (request_key);
ALTER TABLE "dowon_private"."recovery_bank_statement_exclusions" ADD CONSTRAINT "recovery_bank_statement_exclusions_recovery_id_fkey" FOREIGN KEY (recovery_id) REFERENCES recoveries(id);
ALTER TABLE "public"."recovery_fee_allocations" ADD CONSTRAINT "recovery_fee_allocations_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE "public"."recovery_fee_allocations" ADD CONSTRAINT "recovery_fee_allocations_payment_schedule_id_fkey" FOREIGN KEY (payment_schedule_id) REFERENCES payment_schedules(id);
ALTER TABLE "public"."recovery_fee_allocations" ADD CONSTRAINT "recovery_fee_allocations_recovery_id_fkey" FOREIGN KEY (recovery_id) REFERENCES recoveries(id);
ALTER TABLE "public"."recovery_fee_splits" ADD CONSTRAINT "recovery_fee_splits_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE "public"."recovery_fee_splits" ADD CONSTRAINT "recovery_fee_splits_recovery_id_fkey" FOREIGN KEY (recovery_id) REFERENCES recoveries(id);
ALTER TABLE "public"."recovery_refunds" ADD CONSTRAINT "recovery_refunds_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE "public"."recovery_refunds" ADD CONSTRAINT "recovery_refunds_recovery_id_fkey" FOREIGN KEY (recovery_id) REFERENCES recoveries(id);
ALTER TABLE "public"."board_posts" ADD CONSTRAINT "board_posts_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id) NOT VALID;
ALTER TABLE "public"."customers" ADD CONSTRAINT "customers_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id) NOT VALID;
ALTER TABLE "public"."customers" ADD CONSTRAINT "customers_salary_day_check" CHECK (((salary_day IS NULL) OR ((salary_day >= 1) AND (salary_day <= 31)))) NOT VALID;
ALTER TABLE "public"."lenders" ADD CONSTRAINT "lenders_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id) NOT VALID;
ALTER TABLE "public"."meta_leads" ADD CONSTRAINT "meta_leads_lead_stage_check" CHECK ((lead_stage = ANY (ARRAY['신규'::text, '부재'::text, '설득필요'::text, '상담중'::text, '장기부재'::text, '불가'::text, '허수'::text]))) NOT VALID;
ALTER TABLE "public"."payment_schedules" ADD CONSTRAINT "payment_schedules_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id) NOT VALID;
ALTER TABLE "public"."payment_schedules" ADD CONSTRAINT "payment_schedules_date_change_count_check" CHECK ((date_change_count >= 0)) NOT VALID;
ALTER TABLE "public"."payment_schedules" ADD CONSTRAINT "payment_schedules_obligation_amount_check" CHECK (((obligation_amount >= (0)::numeric) AND ((obligation_amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])))) NOT VALID;
ALTER TABLE "public"."payment_schedules" ADD CONSTRAINT "payment_schedules_promise_state_check" CHECK ((promise_state = ANY (ARRAY['active'::text, 'rescheduled'::text, 'cancelled'::text]))) NOT VALID;
ALTER TABLE "public"."recoveries" ADD CONSTRAINT "recoveries_accounting_version_check" CHECK ((accounting_version = ANY (ARRAY[1, 2]))) NOT VALID;
ALTER TABLE "public"."recoveries" ADD CONSTRAINT "recoveries_client_return_amount_check" CHECK ((client_return_amount >= 0)) NOT VALID;
ALTER TABLE "public"."recoveries" ADD CONSTRAINT "recoveries_installment_amount_check" CHECK ((installment_amount >= 0)) NOT VALID;
ALTER TABLE "public"."recoveries" ADD CONSTRAINT "recoveries_success_fee_amount_check" CHECK ((success_fee_amount >= 0)) NOT VALID;
ALTER TABLE "public"."repayment_schedules" ADD CONSTRAINT "repayment_schedules_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id) NOT VALID;
ALTER TABLE "public"."repayment_schedules" ADD CONSTRAINT "repayment_schedules_date_change_count_check" CHECK ((date_change_count >= 0)) NOT VALID;
ALTER TABLE "public"."repayment_schedules" ADD CONSTRAINT "repayment_schedules_obligation_amount_check" CHECK (((obligation_amount >= (0)::numeric) AND ((obligation_amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])))) NOT VALID;
ALTER TABLE "public"."repayment_schedules" ADD CONSTRAINT "repayment_schedules_promise_state_check" CHECK ((promise_state = ANY (ARRAY['active'::text, 'rescheduled'::text, 'cancelled'::text]))) NOT VALID;
ALTER TABLE "public"."settlement_entries" ADD CONSTRAINT "settlement_entries_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id) NOT VALID;
ALTER TABLE "public"."settlement_entries" DROP CONSTRAINT "settlement_entries_entry_source_check";
ALTER TABLE "public"."settlement_entries" ADD CONSTRAINT "settlement_entries_entry_source_check" CHECK ((entry_source = ANY (ARRAY['manual'::text, 'payment'::text, 'recovery'::text]))) NOT VALID;
ALTER TABLE "public"."settlement_entries" DROP CONSTRAINT "settlement_entries_entry_type_check";
-- Keep the target's existing 기타 category editable alongside the new types.
ALTER TABLE "public"."settlement_entries" ADD CONSTRAINT "settlement_entries_entry_type_check" CHECK ((entry_type = ANY (ARRAY['계약'::text, '환수'::text, '기타'::text, '환수 성공보수'::text, '환수 분납금'::text, '의뢰인 환수 반환금'::text]))) NOT VALID;
ALTER TABLE "public"."settlement_entries" ADD CONSTRAINT "settlement_entries_recovery_component_check" CHECK ((recovery_component = ANY (ARRAY['success_fee'::text, 'installment'::text, 'client_return'::text]))) NOT VALID;
ALTER TABLE "public"."settlement_entries" ADD CONSTRAINT "settlement_entries_source_recovery_id_fkey" FOREIGN KEY (source_recovery_id) REFERENCES recoveries(id) NOT VALID;
ALTER TABLE "public"."settlement_entries" ADD CONSTRAINT "settlement_recovery_component_source_check" CHECK ((((source_recovery_id IS NULL) AND (recovery_component IS NULL)) OR ((source_recovery_id IS NOT NULL) AND (recovery_component IS NOT NULL) AND (source_payment_schedule_id IS NULL) AND (entry_source = 'recovery'::text)))) NOT VALID;
CREATE INDEX IF NOT EXISTS idx_board_notice ON public.board_posts USING btree (is_notice, notice_order);
CREATE INDEX IF NOT EXISTS customers_is_accident_risk_idx ON public.customers USING btree (is_accident_risk);
CREATE INDEX IF NOT EXISTS idx_customers_name ON public.customers USING btree (name);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON public.customers USING btree (phone);
CREATE INDEX IF NOT EXISTS idx_customers_registered_at ON public.customers USING btree (registered_at);
CREATE INDEX IF NOT EXISTS lead_call_logs_created_at_idx ON public.lead_call_logs USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS lead_call_logs_source_lead_idx ON public.lead_call_logs USING btree (lead_source, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lender_contacts_lender ON public.lender_contacts USING btree (lender_id);
CREATE INDEX IF NOT EXISTS meta_leads_ad_id_idx ON public.meta_leads USING btree (ad_id);
CREATE INDEX IF NOT EXISTS meta_leads_form_id_idx ON public.meta_leads USING btree (form_id);
CREATE INDEX IF NOT EXISTS meta_leads_lead_stage_idx ON public.meta_leads USING btree (lead_stage);
CREATE INDEX IF NOT EXISTS meta_leads_status_changed_at_idx ON public.meta_leads USING btree (status_changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_customer ON public.payment_schedules USING btree (customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_due_date ON public.payment_schedules USING btree (due_date);
CREATE INDEX IF NOT EXISTS idx_payment_paid_date ON public.payment_schedules USING btree (paid_date);
CREATE INDEX IF NOT EXISTS payment_schedules_active_parent_idx ON public.payment_schedules USING btree (rescheduled_from_id) WHERE ((rescheduled_from_id IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX IF NOT EXISTS recovery_fee_allocations_customer_idx ON public.recovery_fee_allocations USING btree (customer_id);
CREATE INDEX IF NOT EXISTS recovery_fee_allocations_payment_idx ON public.recovery_fee_allocations USING btree (payment_schedule_id);
CREATE INDEX IF NOT EXISTS recovery_refunds_date_idx ON public.recovery_refunds USING btree (refund_date);
CREATE INDEX IF NOT EXISTS recovery_refunds_recovery_idx ON public.recovery_refunds USING btree (recovery_id);
CREATE INDEX IF NOT EXISTS idx_repayment_customer ON public.repayment_schedules USING btree (customer_id);
CREATE INDEX IF NOT EXISTS idx_repayment_date ON public.repayment_schedules USING btree (repayment_date);
CREATE INDEX IF NOT EXISTS repayment_schedules_active_parent_idx ON public.repayment_schedules USING btree (rescheduled_from_id) WHERE ((rescheduled_from_id IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX IF NOT EXISTS idx_settlement_payment_date ON public.settlement_entries USING btree (payment_date);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_entries_recovery_component_idx ON public.settlement_entries USING btree (source_recovery_id, recovery_component) WHERE (source_recovery_id IS NOT NULL);

-- Final finance definitions, with no top-level DML or history replay.

CREATE OR REPLACE FUNCTION dowon_private.confirmed_recovery_bank_correction(p_kind text, p_old jsonb, p_new jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
 raw_manifest text;m jsonb;target jsonb;state jsonb;meta jsonb;refund_input jsonb;
 proof public.change_history%ROWTYPE;recovery_proof public.change_history%ROWTYPE;refund_proof public.change_history%ROWTYPE;
 current_recovery jsonb;current_payment jsonb;current_bank jsonb;current_split jsonb;current_allocation jsonb;
 current_gross_payment jsonb;current_gross_bank jsonb;
 run_id uuid;prior_run_id uuid;target_count integer;gross numeric;credit numeric;fee numeric;refund_amount numeric;
 expected_obligation jsonb;
BEGIN
 -- Both identities matter: a public SECURITY DEFINER call may acquire its
 -- owner's current_user, but cannot acquire the operator's session_user.
 IF current_user<>'postgres' OR session_user<>'postgres' OR auth.uid() IS NOT NULL
  OR coalesce(current_setting('role',true),'none') NOT IN ('none','postgres') THEN RETURN NULL;END IF;
 raw_manifest:=nullif(current_setting('dowon.first_half_recovery_manifest',true),'');
 IF raw_manifest IS NULL THEN RETURN NULL;END IF;
 m:=raw_manifest::jsonb;
 IF p_kind IS NULL OR p_kind NOT IN ('recovery','refund_cancel','refund_insert') OR jsonb_typeof(p_new) IS DISTINCT FROM 'object'
  OR jsonb_typeof(m) IS DISTINCT FROM 'object'
  OR m->>'confirmation' IS DISTINCT FROM 'confirmed_first_half_recovery_bank_correction'
  OR nullif(m->>'run_id','') IS NULL OR jsonb_typeof(m->'targets') IS DISTINCT FROM 'array'
  OR jsonb_array_length(m->'targets') NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'An explicit confirmed recovery correction manifest is required';
 END IF;
 run_id:=(m->>'run_id')::uuid;
 SELECT count(*) INTO target_count FROM jsonb_array_elements(m->'targets') j
  WHERE j->'expected_previous_state'->'recovery'->>'id'=
   CASE WHEN p_kind='recovery' THEN p_old->>'id' WHEN p_kind='refund_cancel' THEN p_old->>'recovery_id' ELSE p_new->>'recovery_id' END;
 IF target_count<>1 THEN RAISE EXCEPTION 'The operator transition must match exactly one explicit recovery target';END IF;
 SELECT j INTO target FROM jsonb_array_elements(m->'targets') j
  WHERE j->'expected_previous_state'->'recovery'->>'id'=
   CASE WHEN p_kind='recovery' THEN p_old->>'id' WHEN p_kind='refund_cancel' THEN p_old->>'recovery_id' ELSE p_new->>'recovery_id' END;
 state:=target->'expected_previous_state';
 IF jsonb_typeof(state) IS DISTINCT FROM 'object' OR nullif(target->>'prior_payment_proof_id','') IS NULL
  OR jsonb_typeof(target->'corrected_gross') IS DISTINCT FROM 'number'
  OR jsonb_typeof(target->'corrected_credit') IS DISTINCT FROM 'number'
  OR NOT(target ? 'expected_gross_obligation_after')
  OR jsonb_typeof(target->'expected_gross_obligation_after') NOT IN ('number','null') THEN
  RAISE EXCEPTION 'The operator target needs its exact previous proof and confirmed amounts';
 END IF;
 SELECT * INTO proof FROM public.change_history WHERE id=(target->>'prior_payment_proof_id')::uuid;
 meta:=proof.old_data->'_legacy_credit_repair';
 IF proof.id IS NULL OR proof.source IS DISTINCT FROM 'confirmed_legacy_recovery_reclassification'
  OR proof.table_name IS DISTINCT FROM 'payment_schedules' OR proof.action IS DISTINCT FROM '수정'
  OR proof.record_id IS DISTINCT FROM state->'payment'->>'id'
  OR proof.new_data IS DISTINCT FROM state->'payment'
  OR meta->>'reason' IS DISTINCT FROM 'human_confirmed_legacy_credit_not_client_cash'
  OR meta->'post_state' IS DISTINCT FROM state OR nullif(meta->>'run_id','') IS NULL THEN
  RAISE EXCEPTION 'The original legacy repair proof does not match the full previous state';
 END IF;
 prior_run_id:=(meta->>'run_id')::uuid;
 IF proof.dedupe_key IS DISTINCT FROM 'legacy_credit_reclassification:'||prior_run_id::text||':payment:'||(state->'payment'->>'id') THEN
  RAISE EXCEPTION 'The original payment proof has inconsistent provenance';
 END IF;
 SELECT * INTO recovery_proof FROM public.change_history
  WHERE dedupe_key='legacy_credit_reclassification:'||prior_run_id::text||':recovery:'||(state->'recovery'->>'id');
 IF recovery_proof.id IS NULL OR recovery_proof.source IS DISTINCT FROM proof.source
  OR recovery_proof.table_name IS DISTINCT FROM 'recoveries' OR recovery_proof.action IS DISTINCT FROM '수정'
  OR recovery_proof.record_id IS DISTINCT FROM state->'recovery'->>'id'
  OR recovery_proof.old_data->'_legacy_credit_repair' IS DISTINCT FROM meta
  OR recovery_proof.old_data-'_legacy_credit_repair' IS DISTINCT FROM state->'recovery'
  OR recovery_proof.new_data IS DISTINCT FROM state->'recovery' THEN
  RAISE EXCEPTION 'The matching original recovery proof is missing or inconsistent';
 END IF;
 -- The original source cash remains cancelled. These links are never inferred
 -- from a customer's name, a similar amount or a nearby date.
 IF state->'recovery'->>'accounting_version' IS DISTINCT FROM '1' OR state->'recovery'->>'deleted_at' IS NOT NULL
  OR state->'payment'->>'deleted_at' IS NOT NULL OR (state->'payment'->>'paid_amount')::numeric IS DISTINCT FROM 0
  OR state->'payment'->>'paid_date' IS NOT NULL OR state->'payment'->>'source_recovery_id' IS NOT NULL
  OR state->'payment'->>'source_additional_contract_id' IS NOT NULL
  OR state->'payment'->>'customer_id' IS DISTINCT FROM state->'recovery'->>'customer_id'
  OR state->'split'->>'recovery_id' IS DISTINCT FROM state->'recovery'->>'id'
  OR state->'split'->>'customer_id' IS DISTINCT FROM state->'recovery'->>'customer_id'
  OR state->'allocation'->>'recovery_id' IS DISTINCT FROM state->'recovery'->>'id'
  OR state->'allocation'->>'customer_id' IS DISTINCT FROM state->'recovery'->>'customer_id'
  OR state->'allocation'->>'payment_schedule_id' IS DISTINCT FROM state->'payment'->>'id'
  OR state->'gross_payment'->>'source_recovery_id' IS DISTINCT FROM state->'recovery'->>'id'
  OR state->'gross_payment'->>'schedule_type' IS DISTINCT FROM '환수'
  OR state->'gross_payment'->>'customer_id' IS DISTINCT FROM state->'recovery'->>'customer_id'
  OR state->'gross_bank'->>'source_payment_schedule_id' IS DISTINCT FROM state->'gross_payment'->>'id'
  OR state->'gross_bank'->>'entry_source' IS DISTINCT FROM 'payment'
  OR state->'gross_bank'->>'entry_type' IS DISTINCT FROM '환수'
  OR state->'gross_bank'->>'deleted_at' IS NOT NULL OR state->'gross_bank'->>'user_deleted' IS DISTINCT FROM 'false'
  OR state->'bank'->>'source_payment_schedule_id' IS DISTINCT FROM state->'payment'->>'id'
  OR state->'bank'->>'deleted_at' IS NULL THEN
  RAISE EXCEPTION 'The previous repair does not describe the exact protected legacy sources';
 END IF;
 gross:=(target->>'corrected_gross')::numeric;credit:=(target->>'corrected_credit')::numeric;fee:=trunc(gross/2);
 IF gross<=0 OR credit<=0 OR gross<>trunc(gross) OR credit<>trunc(credit)
  OR gross::text IN ('NaN','Infinity','-Infinity') OR credit::text IN ('NaN','Infinity','-Infinity')
  OR gross<=(state->'recovery'->>'amount')::numeric OR fee+credit>gross THEN
  RAISE EXCEPTION 'The correction must increase the recorded gross and preserve an explicit valid credit';
 END IF;
 expected_obligation:=CASE WHEN state->'gross_payment'->>'obligation_amount' IS NOT NULL THEN state->'gross_payment'->'obligation_amount'
  WHEN state->'gross_payment'->>'rescheduled_from_id' IS NULL THEN state->'gross_payment'->'expected_amount' ELSE 'null'::jsonb END;
 IF target->'expected_gross_obligation_after' IS DISTINCT FROM expected_obligation THEN
  RAISE EXCEPTION 'The gross shadow obligation must match the existing version trigger';
 END IF;
 SELECT to_jsonb(t) INTO current_payment FROM public.payment_schedules t WHERE id=(state->'payment'->>'id')::uuid;
 SELECT to_jsonb(t) INTO current_bank FROM public.settlement_entries t WHERE id=(state->'bank'->>'id')::uuid;
 SELECT to_jsonb(t) INTO current_recovery FROM public.recoveries t WHERE id=(state->'recovery'->>'id')::uuid;
 SELECT to_jsonb(t) INTO current_split FROM public.recovery_fee_splits t WHERE recovery_id=(state->'recovery'->>'id')::uuid;
 SELECT to_jsonb(t) INTO current_allocation FROM public.recovery_fee_allocations t WHERE id=(state->'allocation'->>'id')::uuid;
 SELECT to_jsonb(t) INTO current_gross_payment FROM public.payment_schedules t WHERE id=(state->'gross_payment'->>'id')::uuid;
 SELECT to_jsonb(t) INTO current_gross_bank FROM public.settlement_entries t WHERE id=(state->'gross_bank'->>'id')::uuid;
 IF current_payment IS DISTINCT FROM state->'payment' OR current_bank IS DISTINCT FROM state->'bank'
  OR (SELECT count(*) FROM public.recovery_fee_allocations WHERE recovery_id=(state->'recovery'->>'id')::uuid)<>1 THEN
  RAISE EXCEPTION 'The protected ordinary payment, statement or allocation links changed';
 END IF;
 IF p_kind='recovery' THEN
  IF p_old IS DISTINCT FROM state->'recovery' OR current_recovery IS DISTINCT FROM p_old
   OR p_new IS DISTINCT FROM p_old||jsonb_build_object('amount',gross)
   OR current_split IS DISTINCT FROM state->'split' OR current_allocation IS DISTINCT FROM state->'allocation'
   OR current_gross_payment IS DISTINCT FROM state->'gross_payment' OR current_gross_bank IS DISTINCT FROM state->'gross_bank' THEN
   RAISE EXCEPTION 'Only the exact legacy recovery gross may change in this operator transition';
  END IF;
 ELSE
  refund_input:=target->'refund_correction';
  IF jsonb_typeof(refund_input) IS DISTINCT FROM 'object'
   OR refund_input->>'confirmation' IS DISTINCT FROM 'actual_return_corrected'
   OR jsonb_typeof(state->'refund') IS DISTINCT FROM 'object'
   OR refund_input->'expected_refund' IS DISTINCT FROM state->'refund'
   OR state->'refund'->>'recovery_id' IS DISTINCT FROM state->'recovery'->>'id'
   OR state->'refund'->>'customer_id' IS DISTINCT FROM state->'recovery'->>'customer_id'
   OR state->'refund'->>'cancelled_at' IS NOT NULL
   OR jsonb_typeof(refund_input->'amount') IS DISTINCT FROM 'number'
   OR nullif(refund_input->>'refund_date','') IS NULL
   OR (refund_input->>'refund_date')::date::text IS DISTINCT FROM refund_input->>'refund_date'
   OR nullif(btrim(refund_input->>'recipient_name'),'') IS NULL
   OR nullif(btrim(refund_input->>'payment_method'),'') IS NULL OR nullif(refund_input->>'request_key','') IS NULL THEN
   RAISE EXCEPTION 'An exact previous refund and independently confirmed replacement are required';
  END IF;
  SELECT * INTO refund_proof FROM public.change_history
   WHERE dedupe_key='legacy_credit_reclassification:'||prior_run_id::text||':refund:'||(state->'refund'->>'request_key');
  IF refund_proof.id IS NULL OR refund_proof.source IS DISTINCT FROM proof.source
   OR refund_proof.table_name IS DISTINCT FROM 'recovery_refunds' OR refund_proof.action IS DISTINCT FROM '등록'
   OR refund_proof.record_id IS DISTINCT FROM state->'refund'->>'id'
   OR refund_proof.old_data IS DISTINCT FROM jsonb_build_object('_legacy_credit_repair',meta)
   OR refund_proof.new_data IS DISTINCT FROM state->'refund' THEN
   RAISE EXCEPTION 'The exact original refund registration proof is required';
  END IF;
  PERFORM (refund_input->>'request_key')::uuid;
  refund_amount:=(refund_input->>'amount')::numeric;
  IF refund_amount<=0 OR refund_amount<>trunc(refund_amount) OR refund_amount::text IN ('NaN','Infinity','-Infinity')
   OR refund_amount>gross-fee-credit OR refund_input->>'request_key'=state->'refund'->>'request_key' THEN
   RAISE EXCEPTION 'The replacement refund exceeds the confirmed balance or reuses its old request';
  END IF;
  IF p_kind='refund_cancel' THEN
   IF p_old IS DISTINCT FROM state->'refund' OR p_new->>'cancelled_at' IS NULL
    OR p_new-'cancelled_at' IS DISTINCT FROM p_old-'cancelled_at'
    OR current_recovery IS DISTINCT FROM state->'recovery'
    OR current_split IS DISTINCT FROM state->'split' OR current_allocation IS DISTINCT FROM state->'allocation'
    OR current_gross_payment IS DISTINCT FROM state->'gross_payment' OR current_gross_bank IS DISTINCT FROM state->'gross_bank' THEN
    RAISE EXCEPTION 'Only the exact original active refund may be cancelled';
   END IF;
  ELSE
   IF current_recovery IS NULL OR (current_recovery->>'amount')::numeric IS DISTINCT FROM gross
    OR (current_recovery->>'row_version')::bigint IS DISTINCT FROM (state->'recovery'->>'row_version')::bigint+1
    OR current_recovery-ARRAY['amount','row_version','updated_at'] IS DISTINCT FROM (state->'recovery')-ARRAY['amount','row_version','updated_at']
    OR current_split IS DISTINCT FROM (state->'split')||jsonb_build_object('success_fee',fee,'applied_fee',credit,'refund_due',gross-fee-credit)
    OR current_allocation IS DISTINCT FROM (state->'allocation')||jsonb_build_object('amount',credit)
    OR NOT EXISTS(SELECT 1 FROM public.recovery_refunds t WHERE id=(state->'refund'->>'id')::uuid AND cancelled_at IS NOT NULL
      AND to_jsonb(t)-'cancelled_at'=(state->'refund')-'cancelled_at')
    OR p_new->>'id'=state->'refund'->>'id'
    OR p_new->>'customer_id' IS DISTINCT FROM state->'recovery'->>'customer_id'
    OR p_new->>'refund_date' IS DISTINCT FROM refund_input->>'refund_date'
    OR (p_new->>'amount')::numeric IS DISTINCT FROM refund_amount
    OR p_new->>'recipient_name' IS DISTINCT FROM refund_input->>'recipient_name'
    OR p_new->>'payment_method' IS DISTINCT FROM refund_input->>'payment_method'
    OR p_new->>'memo' IS DISTINCT FROM coalesce(refund_input->>'memo','확인된 실제 반환 정정')
    OR p_new->>'request_key' IS DISTINCT FROM refund_input->>'request_key'
    OR p_new->>'settlement_hidden' IS DISTINCT FROM 'false' OR p_new->>'cancelled_at' IS NOT NULL THEN
    RAISE EXCEPTION 'The replacement refund must follow the exact confirmed source correction';
   END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('run_id',run_id,'manifest_hash',md5(m::text),'prior_payment_proof_id',proof.id,
  'recovery_id',state->'recovery'->>'id','reason','confirmed_first_half_recovery_bank_correction');
END;$function$;

CREATE OR REPLACE FUNCTION dowon_private.dowon_apply_schedule_promises(p_kind text, p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
END;$function$;

CREATE OR REPLACE FUNCTION dowon_private.dowon_save_finance_batch_legacy(p_kind text, p_customer_id uuid, p_rows jsonb, p_delete_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
END;$function$;

CREATE OR REPLACE FUNCTION dowon_private.dowon_write_schedule_rows_legacy(p_kind text, p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_apply_recovery_split(p_recovery_id uuid, p_success_fee numeric, p_allocations jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION '환수 관리가 변경되었습니다. 새로고침한 뒤 상세에서 저장해주세요';END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_audit_refund_cash_cancellation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE actor uuid:=auth.uid();request_id uuid;proof_key text;correction jsonb;
BEGIN
 IF TG_OP<>'UPDATE' OR old.cancelled_at IS NOT NULL OR new.cancelled_at IS NULL
  THEN RAISE EXCEPTION '유효한 반환 취소 전이와 로그인 정보가 필요합니다';END IF;
 IF actor IS NULL THEN
  IF current_user='postgres' AND session_user='postgres'
   AND nullif(current_setting('dowon.first_half_recovery_manifest',true),'') IS NOT NULL THEN
   correction:=dowon_private.confirmed_recovery_bank_correction('refund_cancel',to_jsonb(old),to_jsonb(new));
  END IF;
  IF correction IS NULL THEN RAISE EXCEPTION '유효한 반환 취소 전이와 로그인 정보가 필요합니다';END IF;
  proof_key:='confirmed_recovery_correction:'||(correction->>'run_id')||':refund_cancel:'||new.id::text;
  INSERT INTO public.change_history(category,action,table_name,record_id,actor_id,actor_name,source,old_data,new_data,dedupe_key)
   VALUES('환수 등록','수정','recovery_refunds',new.id::text,NULL,'DB 운영 정정','confirmed_recovery_correction',
    to_jsonb(old)||jsonb_build_object('_confirmed_recovery_correction',correction),to_jsonb(new),proof_key);
  RETURN new;
 END IF;
 request_id:=coalesce(nullif(current_setting('dowon.settlement_cancel_request',true),'')::uuid,gen_random_uuid());
 proof_key:='settlement_source_cancellation:'||actor::text||':refund:'||new.id::text||':'||request_id::text;
 INSERT INTO public.change_history(category,action,table_name,record_id,actor_id,actor_name,source,old_data,new_data,dedupe_key)
  VALUES('환수 등록','수정','recovery_refunds',new.id::text,actor,'사용자','settlement_source_cancellation',to_jsonb(old),to_jsonb(new),proof_key);
 RETURN new;
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_cancel_settlement(p_id uuid, p_expected jsonb, p_request_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
 v_actor uuid:=auth.uid();v_input jsonb;v_previous dowon_private.save_requests%ROWTYPE;v_inner_key uuid;
 v_statement public.settlement_entries%ROWTYPE;v_payment public.payment_schedules%ROWTYPE;
 v_recovery public.recoveries%ROWTYPE;v_additional public.additional_contracts%ROWTYPE;
 v_refund public.recovery_refunds%ROWTYPE;v_refund_before jsonb;v_refund_after jsonb;v_parent_snapshot jsonb;v_client_name text;v_prior_request text;
 v_customer uuid;v_kind text;v_locked_kind text;v_actual jsonb;v_payment_snapshot jsonb:='null';v_source_snapshot jsonb:='null';
 v_versions jsonb;v_payload jsonb;v_returns numeric;v_source_before jsonb;v_source_after jsonb;
BEGIN
 IF v_actor IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다';END IF;
 -- Preserve the target firm's existing admin-only settlement permissions.
 IF NOT public.is_app_admin() THEN RAISE EXCEPTION '정산 취소는 최종관리자만 가능합니다.' USING ERRCODE='42501';END IF;
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
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_check_payment_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_count_schedule_date_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_delete_settlement(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION '정산 삭제 방식이 변경되었습니다. 새로고침 후 정산표에서 원본 거래 취소를 확인해주세요';END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_guard_allocated_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM public.recovery_fee_allocations WHERE payment_schedule_id=old.id) THEN
  IF tg_op='DELETE' THEN RAISE EXCEPTION '환수 충당 이력이 있는 일정은 삭제할 수 없습니다'; END IF;
  IF new.deleted_at IS DISTINCT FROM old.deleted_at OR new.customer_id IS DISTINCT FROM old.customer_id
     OR new.rescheduled_from_id IS DISTINCT FROM old.rescheduled_from_id OR new.status='환불'
  THEN RAISE EXCEPTION '환수 충당 이력의 고객·연결·삭제는 환수 관리에서 변경해주세요'; END IF;
 END IF;
 RETURN CASE WHEN tg_op='DELETE' THEN old ELSE new END;
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_guard_recovery_split()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE correction jsonb;
BEGIN
 IF TG_OP='UPDATE' AND new.customer_id IS DISTINCT FROM old.customer_id THEN RAISE EXCEPTION '환수 이력의 고객은 변경할 수 없습니다';END IF;
 IF EXISTS(SELECT 1 FROM public.recovery_fee_splits WHERE recovery_id=old.id) AND
    (TG_OP='DELETE' OR (new.accounting_version=1 AND (new.deleted_at IS DISTINCT FROM old.deleted_at OR new.amount IS DISTINCT FROM old.amount
     OR new.lender_name IS DISTINCT FROM old.lender_name OR new.recovery_date IS DISTINCT FROM old.recovery_date))) THEN
  IF TG_OP='UPDATE' AND current_user='postgres' AND session_user='postgres' AND auth.uid() IS NULL
   AND nullif(current_setting('dowon.first_half_recovery_manifest',true),'') IS NOT NULL THEN
   correction:=dowon_private.confirmed_recovery_bank_correction('recovery',to_jsonb(old),to_jsonb(new));
  END IF;
  IF correction IS NULL THEN RAISE EXCEPTION '기존 충당 내역은 새 환수 상세에서 확인한 뒤 저장해주세요';END IF;
 END IF;
 IF TG_OP='UPDATE' AND old.accounting_version=2 AND new.accounting_version<>2 THEN RAISE EXCEPTION '이전 환수 양식으로 되돌릴 수 없습니다';END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN old ELSE new END;
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_guard_refund_cash_cancellation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE parent public.recoveries%ROWTYPE;correction jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION '반환 원본은 삭제할 수 없습니다. 취소 이력으로 보존해주세요';END IF;
 IF TG_OP='INSERT' THEN
  IF new.cancelled_at IS NOT NULL THEN RAISE EXCEPTION '취소된 반환 원본을 새로 등록할 수 없습니다';END IF;
  IF current_user='postgres' AND session_user='postgres' AND auth.uid() IS NULL
   AND nullif(current_setting('dowon.first_half_recovery_manifest',true),'') IS NOT NULL THEN
   correction:=dowon_private.confirmed_recovery_bank_correction('refund_insert',NULL,to_jsonb(new));
   IF correction IS NULL THEN RAISE EXCEPTION '유효한 운영 반환 정정 정보가 필요합니다';END IF;
  END IF;
  RETURN new;
 END IF;
 IF to_jsonb(new)-ARRAY['settlement_hidden','cancelled_at'] IS DISTINCT FROM to_jsonb(old)-ARRAY['settlement_hidden','cancelled_at']
  THEN RAISE EXCEPTION '반환 금액·날짜·수취인·원본 연결은 변경할 수 없습니다';END IF;
 IF new.cancelled_at IS DISTINCT FROM old.cancelled_at THEN
  IF auth.uid() IS NOT NULL AND NOT public.is_app_admin() THEN RAISE EXCEPTION '정산 취소는 최종관리자만 가능합니다.' USING ERRCODE='42501';END IF;
  IF old.cancelled_at IS NOT NULL OR new.cancelled_at IS NULL THEN RAISE EXCEPTION '취소된 반환 기록은 복구할 수 없습니다. 새 반환 거래로 등록해주세요';END IF;
  IF auth.uid() IS NULL THEN
   IF current_user='postgres' AND session_user='postgres'
    AND nullif(current_setting('dowon.first_half_recovery_manifest',true),'') IS NOT NULL THEN
    correction:=dowon_private.confirmed_recovery_bank_correction('refund_cancel',to_jsonb(old),to_jsonb(new));
   END IF;
   IF correction IS NULL THEN RAISE EXCEPTION '로그인이 필요합니다';END IF;
  END IF;
  -- Keep the established NOWAIT parent lock for direct child updates.
  SELECT * INTO parent FROM public.recoveries WHERE id=old.recovery_id AND deleted_at IS NULL FOR UPDATE NOWAIT;
  IF NOT FOUND OR parent.accounting_version<>1 OR parent.customer_id IS DISTINCT FROM old.customer_id
   THEN RAISE EXCEPTION '신형 환수의 별도 반환은 환수 등록에서 확인해주세요';END IF;
  new.cancelled_at:=clock_timestamp();
 END IF;
 RETURN new;
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_keep_settlement_hidden()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF old.user_deleted THEN new.user_deleted:=true;new.deleted_at:=coalesce(old.deleted_at,new.deleted_at,now());END IF;
 RETURN new;
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_lock_payment_parent()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_prepare_recovery_details()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  SELECT coalesce(sum(amount),0) INTO previous_returns FROM recovery_refunds WHERE recovery_id=new.id AND cancelled_at IS NULL;
  IF new.client_return_amount<previous_returns THEN RAISE EXCEPTION '이미 반환한 금액보다 작게 저장할 수 없습니다';END IF;
  IF new.amount>0 AND (new.recovery_date IS NULL OR nullif(btrim(new.lender_name),'') IS NULL OR nullif(btrim(new.depositor_name),'') IS NULL)
   THEN RAISE EXCEPTION '환수일, 업체명, 실제 입금 예금주를 입력해주세요';END IF;
 END IF;
 RETURN new;
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_record_recovery_refund(p_recovery_id uuid, p_date date, p_amount numeric, p_recipient text, p_method text, p_memo text, p_request_key uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION '환수 관리가 변경되었습니다. 새로고침한 뒤 상세에서 저장해주세요';END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_recovery_payer_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_lender text;v_customer text;
begin
 if new.entry_type='환수' and new.source_payment_schedule_id is not null then
  select r.lender_name,c.name into v_lender,v_customer from public.payment_schedules p join public.recoveries r on r.id=p.source_recovery_id join public.customers c on c.id=r.customer_id where p.id=new.source_payment_schedule_id;
  if v_lender is not null and trim(v_lender)<>'' then
   new.client_name:=v_lender;
   if true then new.memo:='환수 입금 ['||v_lender||'] [예금주:'||coalesce(nullif((select depositor_name from public.recoveries where id=(select source_recovery_id from public.payment_schedules where id=new.source_payment_schedule_id)),''),v_lender)||']';end if;
  end if;
 end if;
 return new;
end;$function$;

CREATE OR REPLACE FUNCTION public.dowon_save_finance_batch(p_kind text, p_customer_id uuid, p_rows jsonb, p_delete_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF p_kind IS DISTINCT FROM 'additional' THEN RAISE EXCEPTION '환수 관리가 변경되었습니다. 새로고침한 뒤 저장해주세요';END IF;
 RETURN dowon_private.dowon_save_finance_batch_legacy(p_kind,p_customer_id,p_rows,p_delete_ids);
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_save_payment_batch(p_customer_id uuid, p_rows jsonb, p_carries jsonb DEFAULT '{}'::jsonb, p_delete_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION '화면이 업데이트되었습니다. 새로고침한 뒤 저장해주세요'; END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_save_payment_with_carry(p_id uuid, p_due_date date, p_expected_amount numeric, p_paid_date date, p_paid_amount numeric, p_status text, p_method text, p_memo text, p_carry_date date, p_carry_memo text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_save_recovery_batch_v2(p_customer_id uuid, p_rows jsonb, p_delete_ids uuid[], p_request_key uuid, p_versions jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  IF EXISTS(SELECT 1 FROM recovery_refunds WHERE recovery_id=row_id AND cancelled_at IS NULL) THEN RAISE EXCEPTION '실제 반환 이력이 있는 환수는 삭제 대신 상세를 수정해주세요';END IF;
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
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_save_repayment_batch(p_customer_id uuid, p_rows jsonb, p_carries jsonb DEFAULT '{}'::jsonb, p_delete_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION '화면이 업데이트되었습니다. 새로고침한 뒤 저장해주세요'; END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_save_schedule_batch_once(p_kind text, p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[], p_request_key uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_save_schedule_batch_v2(p_kind text, p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[], p_request_key uuid, p_versions jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION '일정 관리가 변경되었습니다. 새로고침한 뒤 저장해주세요';END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_save_schedule_batch_v3(p_kind text, p_customer_id uuid, p_rows jsonb, p_delete_ids uuid[], p_request_key uuid, p_versions jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_save_schedules_flexible(text, uuid, jsonb, jsonb, uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION '화면이 업데이트되었습니다. 새로고침한 뒤 저장해주세요'; END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_schedule_projection(p_kind text, p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
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
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_schedule_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_split_rescheduled_payment(p_source_id uuid, p_new_date date, p_amount numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION '화면이 업데이트되었습니다. 새로고침한 뒤 저장해주세요'; END;$function$;

CREATE OR REPLACE FUNCTION public.dowon_sync_partial_payment_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end;$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.sync_payment_schedule_to_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
END;$function$;

CREATE OR REPLACE FUNCTION public.sync_recovery_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
 SELECT coalesce(sum(amount),0) INTO previous_returns FROM recovery_refunds WHERE recovery_id=new.id AND cancelled_at IS NULL;
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
END;$function$;

CREATE VIEW "public"."dowon_active_recovery_allocations" WITH (security_invoker=true) AS
SELECT a.id,
    a.recovery_id,
    a.customer_id,
    a.payment_schedule_id,
    a.amount,
    a.created_at
   FROM (recovery_fee_allocations a
     JOIN recoveries r ON ((r.id = a.recovery_id)))
  WHERE ((r.accounting_version = 1) AND (r.deleted_at IS NULL));
REVOKE ALL ON "public"."dowon_active_recovery_allocations" FROM PUBLIC,anon;
GRANT SELECT ON "public"."dowon_active_recovery_allocations" TO authenticated;

CREATE VIEW "public"."dowon_repayment_promises" WITH (security_invoker=true) AS
SELECT p.id,
    p.customer_id,
    p.lender_name,
    p.repayment_date,
    p.repayment_amount,
    p.account_info,
    p.status,
    p.memo,
    p.created_by,
    p.created_at,
    p.updated_at,
    p.deleted_at,
    p.lender_contact_type,
    p.lender_contact_value,
    p.admin_created_at,
    p.paid_amount,
    p.paid_date,
    p.rescheduled_from_id,
    p.root_schedule_id,
    p.reschedule_sequence,
    p.promise_state,
    p.obligation_amount,
    p.row_version,
    COALESCE(root.obligation_amount, (root.repayment_amount)::numeric) AS root_obligation_amount,
    p.date_change_count
   FROM (repayment_schedules p
     LEFT JOIN repayment_schedules root ON (((root.id = COALESCE(p.root_schedule_id, p.rescheduled_from_id, p.id)) AND (root.customer_id = p.customer_id))))
  WHERE (p.deleted_at IS NULL);
REVOKE ALL ON "public"."dowon_repayment_promises" FROM PUBLIC,anon;
GRANT SELECT ON "public"."dowon_repayment_promises" TO authenticated;

DROP TRIGGER IF EXISTS "trg_board_posts_updated_at" ON "public"."board_posts";
CREATE TRIGGER trg_board_posts_updated_at BEFORE UPDATE ON public.board_posts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS "trg_customers_updated_at" ON "public"."customers";
CREATE TRIGGER trg_customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS "trg_lenders_updated_at" ON "public"."lenders";
CREATE TRIGGER trg_lenders_updated_at BEFORE UPDATE ON public.lenders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS "trg_dowon_date_change_count" ON "public"."payment_schedules";
CREATE TRIGGER trg_dowon_date_change_count BEFORE INSERT OR UPDATE ON public.payment_schedules FOR EACH ROW EXECUTE FUNCTION dowon_count_schedule_date_changes('due_date');

DROP TRIGGER IF EXISTS "trg_dowon_guard_allocated_payment" ON "public"."payment_schedules";
CREATE TRIGGER trg_dowon_guard_allocated_payment BEFORE DELETE OR UPDATE ON public.payment_schedules FOR EACH ROW EXECUTE FUNCTION dowon_guard_allocated_payment();

DROP TRIGGER IF EXISTS "trg_dowon_lock_payment_parent" ON "public"."payment_schedules";
CREATE TRIGGER trg_dowon_lock_payment_parent BEFORE INSERT OR UPDATE OF rescheduled_from_id, customer_id ON public.payment_schedules FOR EACH ROW EXECUTE FUNCTION dowon_lock_payment_parent();

DROP TRIGGER IF EXISTS "trg_dowon_promise_version" ON "public"."payment_schedules";
CREATE TRIGGER trg_dowon_promise_version BEFORE INSERT OR UPDATE ON public.payment_schedules FOR EACH ROW EXECUTE FUNCTION dowon_schedule_version();

DROP TRIGGER IF EXISTS "trg_payment_schedules_updated_at" ON "public"."payment_schedules";
CREATE TRIGGER trg_payment_schedules_updated_at BEFORE UPDATE ON public.payment_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS "trg_profiles_updated_at" ON "public"."profiles";
CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS "trg_dowon_guard_recovery_split" ON "public"."recoveries";
CREATE TRIGGER trg_dowon_guard_recovery_split BEFORE DELETE OR UPDATE ON public.recoveries FOR EACH ROW EXECUTE FUNCTION dowon_guard_recovery_split();

DROP TRIGGER IF EXISTS "trg_dowon_recovery_details" ON "public"."recoveries";
CREATE TRIGGER trg_dowon_recovery_details BEFORE INSERT OR UPDATE ON public.recoveries FOR EACH ROW EXECUTE FUNCTION dowon_prepare_recovery_details();

DROP TRIGGER IF EXISTS "trg_dowon_refund_cash_cancellation" ON "public"."recovery_refunds";
CREATE TRIGGER trg_dowon_refund_cash_cancellation BEFORE INSERT OR DELETE OR UPDATE ON public.recovery_refunds FOR EACH ROW EXECUTE FUNCTION dowon_guard_refund_cash_cancellation();

DROP TRIGGER IF EXISTS "trg_dowon_refund_cash_cancellation_audit" ON "public"."recovery_refunds";
CREATE TRIGGER trg_dowon_refund_cash_cancellation_audit AFTER UPDATE ON public.recovery_refunds FOR EACH ROW WHEN (((old.cancelled_at IS NULL) AND (new.cancelled_at IS NOT NULL))) EXECUTE FUNCTION dowon_audit_refund_cash_cancellation();

DROP TRIGGER IF EXISTS "trg_dowon_date_change_count" ON "public"."repayment_schedules";
CREATE TRIGGER trg_dowon_date_change_count BEFORE INSERT OR UPDATE ON public.repayment_schedules FOR EACH ROW EXECUTE FUNCTION dowon_count_schedule_date_changes('repayment_date');

DROP TRIGGER IF EXISTS "trg_dowon_promise_version" ON "public"."repayment_schedules";
CREATE TRIGGER trg_dowon_promise_version BEFORE INSERT OR UPDATE ON public.repayment_schedules FOR EACH ROW EXECUTE FUNCTION dowon_schedule_version();

DROP TRIGGER IF EXISTS "trg_repayment_schedules_updated_at" ON "public"."repayment_schedules";
CREATE TRIGGER trg_repayment_schedules_updated_at BEFORE UPDATE ON public.repayment_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS "trg_dowon_keep_settlement_hidden" ON "public"."settlement_entries";
CREATE TRIGGER trg_dowon_keep_settlement_hidden BEFORE UPDATE ON public.settlement_entries FOR EACH ROW EXECUTE FUNCTION dowon_keep_settlement_hidden();

DROP TRIGGER IF EXISTS "trg_dowon_recovery_payer_settlement" ON "public"."settlement_entries";
CREATE TRIGGER trg_dowon_recovery_payer_settlement BEFORE INSERT OR UPDATE ON public.settlement_entries FOR EACH ROW EXECUTE FUNCTION dowon_recovery_payer_settlement();

DROP TRIGGER IF EXISTS "trg_settlement_entries_updated_at" ON "public"."settlement_entries";
CREATE TRIGGER trg_settlement_entries_updated_at BEFORE UPDATE ON public.settlement_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Keep every existing target policy. New tables receive minimal privileges.
CREATE POLICY "own_requests_insert" ON "dowon_private"."save_requests" FOR INSERT TO "authenticated" WITH CHECK ((actor_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "own_requests_read" ON "dowon_private"."save_requests" FOR SELECT TO "authenticated" USING ((actor_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "lead call logs authenticated delete" ON "public"."lead_call_logs" FOR DELETE TO "authenticated" USING (public.is_app_admin());
CREATE POLICY "lead call logs authenticated insert" ON "public"."lead_call_logs" FOR INSERT TO "authenticated" WITH CHECK (true);
CREATE POLICY "lead call logs authenticated select" ON "public"."lead_call_logs" FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "lead call logs authenticated update" ON "public"."lead_call_logs" FOR UPDATE TO "authenticated" USING (true) WITH CHECK (true);
CREATE POLICY "recovery_alloc_read" ON "public"."recovery_fee_allocations" FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "recovery_split_read" ON "public"."recovery_fee_splits" FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "recovery_refunds_hide_statement" ON "public"."recovery_refunds" FOR UPDATE TO "authenticated" USING (public.is_app_admin()) WITH CHECK (public.is_app_admin());
CREATE POLICY "recovery_refunds_read" ON "public"."recovery_refunds" FOR SELECT TO "authenticated" USING (true);
GRANT SELECT,INSERT ON dowon_private.save_requests TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.lead_call_logs TO authenticated;
GRANT SELECT ON public.recovery_fee_allocations,public.recovery_fee_splits,public.recovery_refunds TO authenticated;
GRANT UPDATE(settlement_hidden,cancelled_at) ON public.recovery_refunds TO authenticated;
GRANT ALL ON "dowon_private"."recovery_bank_statement_exclusions" TO service_role;
GRANT ALL ON "dowon_private"."save_requests" TO service_role;
GRANT ALL ON "public"."lead_call_logs" TO service_role;
GRANT ALL ON "public"."recovery_fee_allocations" TO service_role;
GRANT ALL ON "public"."recovery_fee_splits" TO service_role;
GRANT ALL ON "public"."recovery_refunds" TO service_role;
REVOKE ALL ON FUNCTION "dowon_private"."confirmed_recovery_bank_correction"(p_kind text, p_old jsonb, p_new jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION "dowon_private"."dowon_apply_schedule_promises"(p_kind text, p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "dowon_private"."dowon_apply_schedule_promises"(p_kind text, p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[]) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "dowon_private"."dowon_save_finance_batch_legacy"(p_kind text, p_customer_id uuid, p_rows jsonb, p_delete_ids uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "dowon_private"."dowon_save_finance_batch_legacy"(p_kind text, p_customer_id uuid, p_rows jsonb, p_delete_ids uuid[]) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "dowon_private"."dowon_write_schedule_rows_legacy"(p_kind text, p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "dowon_private"."dowon_write_schedule_rows_legacy"(p_kind text, p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[]) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_apply_recovery_split"(p_recovery_id uuid, p_success_fee numeric, p_allocations jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_apply_recovery_split"(p_recovery_id uuid, p_success_fee numeric, p_allocations jsonb) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_audit_refund_cash_cancellation"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_audit_refund_cash_cancellation"() TO service_role;
REVOKE ALL ON FUNCTION "public"."dowon_cancel_settlement"(p_id uuid, p_expected jsonb, p_request_key uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_cancel_settlement"(p_id uuid, p_expected jsonb, p_request_key uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_check_payment_balance"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_check_payment_balance"() TO service_role;
REVOKE ALL ON FUNCTION "public"."dowon_count_schedule_date_changes"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_count_schedule_date_changes"() TO service_role;
REVOKE ALL ON FUNCTION "public"."dowon_delete_settlement"(p_id uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_delete_settlement"(p_id uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_guard_allocated_payment"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_guard_allocated_payment"() TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_guard_recovery_split"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_guard_recovery_split"() TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_guard_refund_cash_cancellation"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_guard_refund_cash_cancellation"() TO service_role;
REVOKE ALL ON FUNCTION "public"."dowon_keep_settlement_hidden"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_keep_settlement_hidden"() TO service_role;
REVOKE ALL ON FUNCTION "public"."dowon_lock_payment_parent"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_lock_payment_parent"() TO service_role;
REVOKE ALL ON FUNCTION "public"."dowon_prepare_recovery_details"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_prepare_recovery_details"() TO service_role;
REVOKE ALL ON FUNCTION "public"."dowon_record_recovery_refund"(p_recovery_id uuid, p_date date, p_amount numeric, p_recipient text, p_method text, p_memo text, p_request_key uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_record_recovery_refund"(p_recovery_id uuid, p_date date, p_amount numeric, p_recipient text, p_method text, p_memo text, p_request_key uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_recovery_payer_settlement"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_recovery_payer_settlement"() TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_save_finance_batch"(p_kind text, p_customer_id uuid, p_rows jsonb, p_delete_ids uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_save_finance_batch"(p_kind text, p_customer_id uuid, p_rows jsonb, p_delete_ids uuid[]) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_save_payment_batch"(p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_save_payment_batch"(p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[]) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_save_payment_with_carry"(p_id uuid, p_due_date date, p_expected_amount numeric, p_paid_date date, p_paid_amount numeric, p_status text, p_method text, p_memo text, p_carry_date date, p_carry_memo text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_save_payment_with_carry"(p_id uuid, p_due_date date, p_expected_amount numeric, p_paid_date date, p_paid_amount numeric, p_status text, p_method text, p_memo text, p_carry_date date, p_carry_memo text) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_save_recovery_batch_v2"(p_customer_id uuid, p_rows jsonb, p_delete_ids uuid[], p_request_key uuid, p_versions jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_save_recovery_batch_v2"(p_customer_id uuid, p_rows jsonb, p_delete_ids uuid[], p_request_key uuid, p_versions jsonb) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_save_repayment_batch"(p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_save_repayment_batch"(p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[]) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_save_schedule_batch_once"(p_kind text, p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[], p_request_key uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_save_schedule_batch_once"(p_kind text, p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[], p_request_key uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_save_schedule_batch_v2"(p_kind text, p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[], p_request_key uuid, p_versions jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_save_schedule_batch_v2"(p_kind text, p_customer_id uuid, p_rows jsonb, p_carries jsonb, p_delete_ids uuid[], p_request_key uuid, p_versions jsonb) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_save_schedule_batch_v3"(p_kind text, p_customer_id uuid, p_rows jsonb, p_delete_ids uuid[], p_request_key uuid, p_versions jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_save_schedule_batch_v3"(p_kind text, p_customer_id uuid, p_rows jsonb, p_delete_ids uuid[], p_request_key uuid, p_versions jsonb) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_save_schedules_flexible"(text, uuid, jsonb, jsonb, uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_save_schedules_flexible"(text, uuid, jsonb, jsonb, uuid[]) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_schedule_projection"(p_kind text, p_customer_id uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_schedule_projection"(p_kind text, p_customer_id uuid) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_schedule_version"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_schedule_version"() TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_split_rescheduled_payment"(p_source_id uuid, p_new_date date, p_amount numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_split_rescheduled_payment"(p_source_id uuid, p_new_date date, p_amount numeric) TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."dowon_sync_partial_payment_settlement"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."dowon_sync_partial_payment_settlement"() TO authenticated,service_role;
REVOKE ALL ON FUNCTION "public"."set_updated_at"() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION "public"."set_updated_at"() TO authenticated,service_role;

DO $guard$
DECLARE spec record;row_count bigint;row_hash text;
BEGIN
 FOR spec IN SELECT * FROM ropower_patch_before LOOP
  EXECUTE format('SELECT count(*),md5(coalesce(jsonb_agg(to_jsonb(q) ORDER BY to_jsonb(q)::text),''[]''::jsonb)::text) FROM (SELECT %s FROM %s) q',spec.projection,spec.table_name) INTO row_count,row_hash;
  IF row_count IS DISTINCT FROM spec.row_count OR row_hash IS DISTINCT FROM spec.row_hash THEN
   RAISE EXCEPTION 'Existing data changed in %; entire patch rolled back',spec.table_name;
  END IF;
 END LOOP;
END;$guard$;
SET LOCAL check_function_bodies=on;
NOTIFY pgrst,'reload schema';
COMMIT;

