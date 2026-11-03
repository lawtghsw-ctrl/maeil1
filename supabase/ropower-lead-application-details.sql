-- Fresh application-detail cutover. Freeze display eligibility once, using
-- the existing source classification. Original application answers are retained.
-- Existing installations of the older all-true marker must run the separate
-- ropower-lead-application-details-freeze.sql correction exactly once.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.meta_leads IN ACCESS EXCLUSIVE MODE;

DO $cutover$
DECLARE before_hash text;after_hash text;trigger_states jsonb;tr record;
BEGIN
  -- Never reclassify on a rerun: a landing lead may later gain a native ID.
  IF EXISTS(SELECT 1 FROM pg_attribute
    WHERE attrelid='public.meta_leads'::regclass
      AND attname='legacy_application_details' AND NOT attisdropped) THEN
    RETURN;
  END IF;
  ALTER TABLE public.meta_leads
    ADD COLUMN legacy_application_details boolean NOT NULL DEFAULT true;

  SELECT md5(coalesce(jsonb_agg(to_jsonb(lead)-'legacy_application_details' ORDER BY (to_jsonb(lead)-'legacy_application_details')::text),'[]'::jsonb)::text)
    INTO before_hash FROM public.meta_leads lead;
  SELECT coalesce(jsonb_agg(jsonb_build_object('name',tgname,'enabled',tgenabled)),'[]'::jsonb)
    INTO trigger_states FROM pg_trigger
    WHERE tgrelid='public.meta_leads'::regclass AND NOT tgisinternal;
  -- A flag-only update must not write audit rows or run business-field triggers.
  -- Keep the schema lock and restore the exact original trigger modes.
  FOR tr IN SELECT * FROM jsonb_to_recordset(trigger_states) AS t(name text,enabled text) LOOP
    IF tr.enabled<>'D' THEN
      EXECUTE format('ALTER TABLE public.meta_leads DISABLE TRIGGER %I',tr.name);
    END IF;
  END LOOP;

  -- Mirrors detectLeadSource() exactly. btrim uses JavaScript's full trim
  -- character set; numeric means ASCII digits, and a nonempty native ID makes
  -- a gsheet: lead instant even when that ID is not numeric.
  WITH origin AS (
    SELECT id,
      btrim(coalesce(meta_lead_id,''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') AS lead_key,
      btrim(coalesce(meta_native_lead_id,''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') AS native_id
    FROM public.meta_leads
  )
  UPDATE public.meta_leads lead SET legacy_application_details=false
    FROM origin
    WHERE lead.id=origin.id AND lead.legacy_application_details=true
      AND (
        origin.lead_key LIKE 'manual:%'
        OR origin.lead_key LIKE 'gsheet-instant:%'
        OR (origin.lead_key LIKE 'gsheet:%' AND origin.native_id<>'')
        OR origin.lead_key ~ '^[0-9]+$'
        OR origin.native_id ~ '^[0-9]+$'
      );

  FOR tr IN SELECT * FROM jsonb_to_recordset(trigger_states) AS t(name text,enabled text) LOOP
    IF tr.enabled='O' THEN
      EXECUTE format('ALTER TABLE public.meta_leads ENABLE TRIGGER %I',tr.name);
    ELSIF tr.enabled='R' THEN
      EXECUTE format('ALTER TABLE public.meta_leads ENABLE REPLICA TRIGGER %I',tr.name);
    ELSIF tr.enabled='A' THEN
      EXECUTE format('ALTER TABLE public.meta_leads ENABLE ALWAYS TRIGGER %I',tr.name);
    ELSIF tr.enabled<>'D' THEN
      RAISE EXCEPTION 'Unknown original trigger state % for %',tr.enabled,tr.name;
    END IF;
  END LOOP;
  SELECT md5(coalesce(jsonb_agg(to_jsonb(lead)-'legacy_application_details' ORDER BY (to_jsonb(lead)-'legacy_application_details')::text),'[]'::jsonb)::text)
    INTO after_hash FROM public.meta_leads lead;
  IF after_hash IS DISTINCT FROM before_hash THEN
    RAISE EXCEPTION 'Original lead fields changed; application display cutover rolled back';
  END IF;
  COMMENT ON COLUMN public.meta_leads.legacy_application_details IS
    'ropower_legacy_application_details_frozen_v2; Frozen eligibility for pre-cutover landing leads only. Later inserts default false. Later origin enrichment does not change eligibility. Original application fields are retained.';

END;$cutover$;

-- The table/schema lock holds through COMMIT; writers cannot insert between
-- the temporary true default and this permanent false default.
ALTER TABLE public.meta_leads
  ALTER COLUMN legacy_application_details SET DEFAULT false;
NOTIFY pgrst,'reload schema';
COMMIT;
