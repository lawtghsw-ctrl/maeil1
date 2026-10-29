BEGIN;
SET LOCAL lock_timeout='5s';
-- Split schedules intentionally share a parent. The batch RPC serializes
-- customer saves, checks existing children and validates the split total.
-- Replace both legacy single-child indexes; preserve other unique indexes.
DROP INDEX IF EXISTS public.payment_schedules_rescheduled_from_unique_idx;
DROP INDEX IF EXISTS public.payment_schedules_one_active_child_idx;
CREATE INDEX IF NOT EXISTS payment_schedules_active_parent_idx
 ON public.payment_schedules(rescheduled_from_id)
 WHERE rescheduled_from_id IS NOT NULL AND deleted_at IS NULL;
COMMIT;
