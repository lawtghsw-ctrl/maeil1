
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

// Fabricated records in an isolated Postgres engine. No network or Supabase use.
const db=new PGlite();
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select nullif(coalesce(current_setting('test.uid',true),'00000000-0000-4000-8000-000000000001'),'')::uuid $$;
create table customers(id uuid primary key default gen_random_uuid(),name text default '테스트 고객',
 contract_amount numeric not null default 500000,is_accident boolean not null default false,
 accident_contract_amount numeric,deleted_at timestamptz);
-- Schedule column types, defaults, nullability and CHECKs match the verified
-- live schema. In particular, dates are nullable and repayment cash is numeric.
create table payment_schedules(
 id uuid primary key default gen_random_uuid(),customer_id uuid not null references customers on delete cascade,
 due_date date,expected_amount bigint not null default 0,paid_date date,paid_amount bigint not null default 0,
 status text not null default '예정',payment_method text,memo text,created_by uuid,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),deleted_at timestamptz,admin_created_at timestamptz not null default now(),
 schedule_type text not null default '일반',root_schedule_id uuid,rescheduled_from_id uuid,reschedule_sequence int not null default 0,
 source_additional_contract_id uuid,source_recovery_id uuid,
 constraint payment_schedules_status_check check(status in ('예정','완료','연체','미납','환불')),
 constraint payment_schedules_schedule_type_check check(schedule_type in ('일반','재약정','추가계약','환수'))
);
create table repayment_schedules(
 id uuid primary key default gen_random_uuid(),customer_id uuid not null references customers on delete cascade,
 lender_name text,lender_contact_type text,lender_contact_value text,repayment_date date,repayment_amount bigint not null default 0,
 account_info text,status text not null default '예정',memo text,created_by uuid,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),deleted_at timestamptz,admin_created_at timestamptz not null default now(),
 paid_amount numeric not null default 0,paid_date date,rescheduled_from_id uuid,root_schedule_id uuid,reschedule_sequence int not null default 0,
 constraint repayment_schedules_status_check check(status in ('예정','완료','상환완료','연체','보류','추심','종결'))
);
create table recoveries(id uuid primary key default gen_random_uuid(),customer_id uuid references customers,amount numeric,deleted_at timestamptz,recovery_date date,lender_name text,payment_method text,recovery_type text,memo text,depositor_name text);
create table recovery_fee_allocations(id uuid primary key default gen_random_uuid(),recovery_id uuid references recoveries,customer_id uuid references customers,payment_schedule_id uuid references payment_schedules,amount numeric check(amount>0),unique(recovery_id,payment_schedule_id));
create table recovery_fee_splits(recovery_id uuid primary key references recoveries,customer_id uuid references customers,success_fee numeric,applied_fee numeric,refund_due numeric);
create table settlement_entries(id uuid primary key default gen_random_uuid(),payment_date date,client_name text,amount numeric,payment_method text,memo text,customer_id uuid,source_payment_schedule_id uuid,entry_source text,entry_type text,deleted_at timestamptz);
create unique index settlement_test_source on settlement_entries(source_payment_schedule_id) where source_payment_schedule_id is not null;
create table additional_contracts(id uuid primary key default gen_random_uuid(),customer_id uuid not null references customers,contract_date date,contract_amount numeric not null,upfront_amount numeric,installment_period int,lender_unit_price numeric,lender_count int,is_renegotiation boolean,memo text,deleted_at timestamptz);
create function write_change_history(text,text,text,text,jsonb,jsonb) returns void language sql as $$ select $$;
`);
const rootSql=fs.readFileSync('tests/fixtures/dowon-reference/supabase/payment-reschedule-analytics.sql','utf8');
await db.exec(rootSql.slice(rootSql.indexOf('create or replace function public.set_payment_schedule_root'),rootSql.indexOf('-- 동일한 납부건')));
await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/V37_11_13_PARTIAL_SETTLEMENT_SYNC.sql','utf8'));
await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/supabase/migrations/20261017061417_recovery_balance_consistency.sql','utf8'));
await db.exec('create trigger trg_dowon_guard_allocated_payment before update or delete on payment_schedules for each row execute function dowon_guard_allocated_payment();');
const recoverySql=fs.readFileSync('tests/fixtures/dowon-reference/V37_11_22_SCHEDULE_REPLAN_ATOMIC.sql','utf8');
await db.exec(recoverySql.slice(recoverySql.indexOf('create or replace function public.dowon_apply_recovery_split')));
const settlementSql=fs.readFileSync('tests/fixtures/dowon-reference/supabase/payment-settlement-delete-sync.sql','utf8');
await db.exec(settlementSql.slice(settlementSql.indexOf('create or replace function public.sync_payment_schedule_to_settlement'),settlementSql.indexOf('-- 3)')));
await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/supabase/migrations/20261017065236_schedule_request_dedup.sql','utf8'));
await db.exec(`
create unique index payment_schedules_rescheduled_from_unique_idx on payment_schedules(rescheduled_from_id) where rescheduled_from_id is not null and deleted_at is null;
create unique index payment_schedules_one_active_child_idx on payment_schedules(rescheduled_from_id) where rescheduled_from_id is not null and deleted_at is null;
create unique index repayment_schedules_one_active_child_idx on repayment_schedules(rescheduled_from_id) where rescheduled_from_id is not null and deleted_at is null;
create function force_closed_repayment_zero() returns trigger language plpgsql as $$ begin if new.status='종결' then new.repayment_amount:=0; end if; return new; end; $$;
create trigger trg_force_closed_repayment_zero before insert or update on repayment_schedules for each row execute function force_closed_repayment_zero();
`);
const flexibleSql=fs.readFileSync('tests/fixtures/dowon-reference/supabase/migrations/20261017114224_flexible_schedules.sql','utf8');
assert.match(flexibleSql,/dowon_save_schedules_flexible/,'flexible migration must be complete before running its acceptance tests');
await db.exec(flexibleSql);

export {db};
