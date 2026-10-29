import fs from 'node:fs';
import {db} from './schedule-promise-db.mjs';

// All rows in this fixture are fabricated in PGlite; no network is used.
await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/supabase/migrations/20261017134055_schedule_promises.sql','utf8'));
await db.exec(`
alter table recoveries add column admin_created_at timestamptz not null default now(),
 add column updated_at timestamptz not null default now();
alter table settlement_entries add constraint settlement_entries_entry_source_check
 check(entry_source in ('manual','payment'));
alter table settlement_entries add constraint settlement_entries_entry_type_check
 check(entry_type in ('계약','환수'));
`);
await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/V37_11_21_RECOVERY_REFUNDS.sql','utf8'));
const legacyRecovery=fs.readFileSync('tests/fixtures/dowon-reference/supabase/additional-contract-recovery-repayment-closed.sql','utf8');
await db.exec(legacyRecovery.slice(legacyRecovery.indexOf('create or replace function public.sync_recovery_payment'),legacyRecovery.indexOf('-- 7)')));
await db.exec(`
create function dowon_guard_recovery_split() returns trigger language plpgsql as $$ begin
 if exists(select 1 from recovery_fee_splits where recovery_id=old.id) then
  if tg_op='DELETE' or new.deleted_at is distinct from old.deleted_at or new.amount is distinct from old.amount
   or new.customer_id is distinct from old.customer_id or new.lender_name is distinct from old.lender_name
   or new.recovery_date is distinct from old.recovery_date then raise exception '충당 완료된 환수는 수정·삭제할 수 없습니다'; end if;
 end if;
 return case when tg_op='DELETE' then old else new end;
end; $$;
create trigger trg_dowon_guard_recovery_split before update or delete on recoveries
 for each row execute function dowon_guard_recovery_split();
`);

export {db};
