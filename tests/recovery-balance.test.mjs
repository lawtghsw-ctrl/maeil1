import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

// Isolated Postgres engine with fabricated rows. Never connects to Supabase.
const db=new PGlite();
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select nullif(coalesce(current_setting('test.uid',true),'00000000-0000-4000-8000-000000000001'),'')::uuid $$;
create table customers(id uuid primary key default gen_random_uuid(),name text default '테스트 고객');
create table payment_schedules(id uuid primary key default gen_random_uuid(),customer_id uuid references customers,deleted_at timestamptz,schedule_type text default '일반',source_recovery_id uuid,source_additional_contract_id uuid,expected_amount numeric,paid_amount numeric default 0,due_date date,paid_date date,status text,payment_method text,memo text,root_schedule_id uuid,rescheduled_from_id uuid references payment_schedules,reschedule_sequence int);
create table recoveries(id uuid primary key default gen_random_uuid(),customer_id uuid references customers,amount numeric,deleted_at timestamptz);
create table recovery_fee_allocations(id uuid primary key default gen_random_uuid(),recovery_id uuid references recoveries,customer_id uuid references customers,payment_schedule_id uuid references payment_schedules,amount numeric check(amount>0),unique(recovery_id,payment_schedule_id));
create table recovery_fee_splits(recovery_id uuid primary key references recoveries,customer_id uuid references customers,success_fee numeric,applied_fee numeric,refund_due numeric);
create table settlement_entries(id uuid primary key default gen_random_uuid(),payment_date date,client_name text,amount numeric,payment_method text,memo text,customer_id uuid,source_payment_schedule_id uuid,entry_source text,entry_type text,deleted_at timestamptz);
create unique index settlement_test_source on settlement_entries(source_payment_schedule_id) where source_payment_schedule_id is not null;
create function write_change_history(text,text,text,text,jsonb,jsonb) returns void language sql as $$ select $$;
`);
await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/V37_11_13_PARTIAL_SETTLEMENT_SYNC.sql','utf8'));
const migration=fs.readdirSync('tests/fixtures/dowon-reference/supabase/migrations').find(x=>x.endsWith('_recovery_balance_consistency.sql'));
await db.exec(fs.readFileSync(`tests/fixtures/dowon-reference/supabase/migrations/${migration}`,'utf8'));
// Existing deployment installs this trigger; CREATE OR REPLACE updates its function.
await db.exec(`create trigger trg_dowon_guard_allocated_payment before update or delete on payment_schedules for each row execute function dowon_guard_allocated_payment();`);
const recoverySql=fs.readFileSync('tests/fixtures/dowon-reference/V37_11_22_SCHEDULE_REPLAN_ATOMIC.sql','utf8');
await db.exec(recoverySql.slice(recoverySql.indexOf('create or replace function public.dowon_apply_recovery_split')));
const settlementSql=fs.readFileSync('tests/fixtures/dowon-reference/supabase/payment-settlement-delete-sync.sql','utf8');
await db.exec(settlementSql.slice(settlementSql.indexOf('create or replace function public.sync_payment_schedule_to_settlement'),settlementSql.indexOf('-- 3)')));
await db.exec(`create table additional_contracts(id uuid primary key default gen_random_uuid(),customer_id uuid not null references customers,contract_date date,contract_amount numeric not null,upfront_amount numeric,installment_period int,lender_unit_price numeric,lender_count int,is_renegotiation boolean,memo text,deleted_at timestamptz);
alter table recoveries add column recovery_date date,add column lender_name text,add column payment_method text,add column recovery_type text,add column memo text,add column depositor_name text;`);
await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/supabase/migrations/20261017065236_schedule_request_dedup.sql','utf8'));
after(()=>db.close());
async function seed(amount,paid=0,parent=null,customer=null){
 customer??=(await db.query('insert into customers default values returning id')).rows[0].id;
 const id=(await db.query(`insert into payment_schedules(customer_id,expected_amount,paid_amount,due_date,paid_date,status,rescheduled_from_id,schedule_type) values($1,$2,$3::numeric,'2026-10-15',case when $3::numeric>0 then date '2026-10-16' else null end,'연체',$4,case when $4::uuid is null then '일반' else '재약정' end) returning id`,[customer,amount,paid,parent])).rows[0].id;
 return {id,customer,amount,paid};
}
async function allocate(p,amount){
 const r=(await db.query('insert into recoveries(customer_id,amount) values($1,$2) returning id',[p.customer,amount*2])).rows[0].id;
 await db.query('select dowon_apply_recovery_split($1,$2,$3::jsonb)',[r,amount,JSON.stringify([{paymentId:p.id,amount}])]);
 return r;
}
function row(p,patch={}){return {id:p.id,dueAmount:p.amount,paidAmount:p.paid,dueDate:'2026-10-15',paidDate:p.paid?'2026-10-16':'',status:'연체',...patch};}
async function save(p,carries=[],patch={}){return db.query('select dowon_save_payment_batch($1,$2::jsonb,$3::jsonb)',[p.customer,JSON.stringify([row(p,patch)]),JSON.stringify(carries.length?{[p.id]:carries}:{})]);}
const plan=amount=>({dueDate:'2026-10-23',dueAmount:amount});
async function children(p){return (await db.query('select expected_amount::int amount from payment_schedules where rescheduled_from_id=$1 and deleted_at is null order by expected_amount',[p.id])).rows.map(x=>x.amount);}

test('partial cash 350000 preserves 375000 plan and carries 25000',async()=>{const p=await seed(375000,350000);await save(p,[plan(25000)]);assert.deepEqual(await children(p),[25000]);assert.equal((await db.query('select paid_amount::int paid from payment_schedules where id=$1',[p.id])).rows[0].paid,350000);});
test('existing 510000/300000 missing balance is repaired exactly once',async()=>{const p=await seed(510000);await seed(300000,0,p.id,p.customer);await save(p);await save(p);assert.deepEqual(await children(p),[210000,300000]);});
test('200000 allocation leaves only 300000 for rescheduling',async()=>{const p=await seed(500000);await allocate(p,200000);await save(p,[plan(300000)]);assert.deepEqual(await children(p),[300000]);await save(p);assert.deepEqual(await children(p),[300000]);});
test('partially rescheduling allocated debt preserves only unassigned net balance',async()=>{const p=await seed(500000);await allocate(p,200000);await save(p,[plan(100000)]);assert.deepEqual(await children(p),[100000,200000]);});
test('cash receipt after allocation succeeds and can complete net obligation',async()=>{const p=await seed(500000);await allocate(p,200000);await save(p,[],{paidAmount:300000,paidDate:'2026-10-17',status:'완료'});assert.equal((await db.query('select paid_amount::int paid from payment_schedules where id=$1',[p.id])).rows[0].paid,300000);});
test('cash settlement records actual payment only, never allocation or carried plan',async()=>{const p=await seed(500000);await allocate(p,200000);assert.equal((await db.query('select count(*)::int n from settlement_entries where customer_id=$1',[p.customer])).rows[0].n,0);await save(p,[plan(200000)],{paidAmount:100000,paidDate:'2026-10-17'});const entries=(await db.query('select amount::int amount,payment_date::text as receipt_date from settlement_entries where customer_id=$1 and deleted_at is null',[p.customer])).rows;assert.deepEqual(entries,[{amount:100000,receipt_date:'2026-10-17'}]);});
test('cash received while schedule remains upcoming reaches settlement once',async()=>{const p=await seed(500000);await save(p,[],{paidAmount:100000,paidDate:'2026-10-17',status:'예정'});await save(p,[],{paidAmount:100000,paidDate:'2026-10-17',status:'예정'});const r=(await db.query('select count(*)::int n,sum(amount)::int amount from settlement_entries where customer_id=$1 and deleted_at is null',[p.customer])).rows[0];assert.equal(r.n,1);assert.equal(r.amount,100000);});
test('cash plus allocation cannot exceed plan',async()=>{const p=await seed(500000);await allocate(p,200000);await assert.rejects(save(p,[],{paidAmount:300001,paidDate:'2026-10-17'}),/초과/);});
test('over-budget carry rolls back parent cash update and all children',async()=>{const p=await seed(500000);await allocate(p,200000);await assert.rejects(save(p,[plan(250001)],{paidAmount:50000,paidDate:'2026-10-17'}),/초과/);assert.deepEqual(await children(p),[]);assert.equal((await db.query('select paid_amount::int paid from payment_schedules where id=$1',[p.id])).rows[0].paid,0);});
test('allocated history cannot be deleted or reassigned',async()=>{const p=await seed(500000);await allocate(p,200000);await assert.rejects(db.query('delete from payment_schedules where id=$1',[p.id]),/삭제/);await assert.rejects(db.query('update payment_schedules set expected_amount=600000 where id=$1',[p.id]),/변경/);});
test('direct child over-allocation is rejected (old client path)',async()=>{const p=await seed(500000);await allocate(p,200000);await assert.rejects(seed(500000,0,p.id,p.customer),/초과/);assert.deepEqual(await children(p),[]);});
test('individual edit cannot inflate child above parent balance',async()=>{const p=await seed(110000);const child=await seed(110000,0,p.id,p.customer);await assert.rejects(db.query('update payment_schedules set expected_amount=330000 where id=$1',[child.id]),/초과/);});
test('cannot allocate to parent after rescheduling; sibling split stays conserved',async()=>{const p=await seed(500000);await allocate(p,200000);await save(p,[plan(300000)]);await assert.rejects(allocate(p,1),/후속/);const child=(await db.query('select id from payment_schedules where rescheduled_from_id=$1',[p.id])).rows[0];await db.query("select dowon_split_rescheduled_payment($1,'2026-11-01',100000)",[child.id]);assert.deepEqual(await children(p),[100000,200000]);});
test('full allocation cannot generate zero/extra carry',async()=>{const p=await seed(200000);await allocate(p,200000);await assert.rejects(save(p,[plan(1)]),/상태/);});
test('cash receipt without actual date is rejected',async()=>{const p=await seed(100000);await assert.rejects(save(p,[],{paidAmount:30000,paidDate:''}),/입금일/);});
test('existing parent link cannot be cleared or moved to another customer',async()=>{const p=await seed(100000);const c=await seed(100000,0,p.id,p.customer);await assert.rejects(db.query('update payment_schedules set rescheduled_from_id=null where id=$1',[c.id]),/연결/);const other=await seed(100000);await assert.rejects(db.query('update payment_schedules set customer_id=$1 where id=$2',[other.customer,c.id]),/동일 고객/);});
test('anonymous batch call and audit writer permission rejected',async()=>{await db.exec("set test.uid=''");const p=await seed(100);await assert.rejects(save(p),/로그인/);await db.exec("set test.uid='00000000-0000-4000-8000-000000000001'");const r=await db.query("select has_function_privilege('anon','write_change_history(text,text,text,text,jsonb,jsonb)','execute') as allowed");assert.equal(r.rows[0].allowed,false);});

async function once(kind,customer,rows,key,carries={},deleted=[]){return db.query('select dowon_save_schedule_batch_once($1,$2,$3::jsonb,$4::jsonb,$5::uuid[],$6)',[kind,customer,JSON.stringify(rows),JSON.stringify(carries),deleted,key]);}
test('retry of committed new payment creates exactly one schedule',async()=>{const p=await seed(100);const key=crypto.randomUUID();const rows=[{dueAmount:700,dueDate:'2026-11-01',paidAmount:0,status:'예정'}];await once('payment',p.customer,rows,key);await once('payment',p.customer,rows,key);assert.equal((await db.query('select count(*)::int n from payment_schedules where customer_id=$1',[p.customer])).rows[0].n,2);await assert.rejects(once('payment',p.customer,[{...rows[0],dueAmount:900}],key),/내용이 변경/);});
test('additional contract inserts complete payload and rolls back whole failed batch',async()=>{const p=await seed(100);const good={contractDate:'2026-10-17',contractAmount:900,prepaidAmount:100};await once('additional',p.customer,[good],crypto.randomUUID());const original=(await db.query('select id from additional_contracts where customer_id=$1',[p.customer])).rows[0].id;const key=crypto.randomUUID();await assert.rejects(once('additional',p.customer,[good,{...good,contractAmount:-1}],key,{},[original]),/음수/);const rows=(await db.query('select deleted_at from additional_contracts where customer_id=$1',[p.customer])).rows;assert.equal(rows.length,1);assert.equal(rows[0].deleted_at,null);assert.equal((await db.query('select count(*)::int n from dowon_private.save_requests where request_key=$1',[key])).rows[0].n,0);});
test('recovery retries do not duplicate and foreign customer edit rolls back',async()=>{const p=await seed(100);const q=await seed(100);const key=crypto.randomUUID();const r={amount:500,recoveryDate:'2026-10-17',depositorName:'테스트'};await once('recovery',p.customer,[r],key);await once('recovery',p.customer,[r],key);const rows=(await db.query('select id,amount::int amount from recoveries where customer_id=$1',[p.customer])).rows;assert.equal(rows.length,1);await assert.rejects(once('recovery',q.customer,[{...r,id:rows[0].id}],crypto.randomUUID()),/다른 고객/);assert.equal((await db.query('select amount::int amount from recoveries where id=$1',[rows[0].id])).rows[0].amount,500);});
test('request receipts deny anonymous access and other user receipts',async()=>{await db.exec('grant usage on schema auth to authenticated');await db.exec('set role authenticated');try{await db.exec("set test.uid='00000000-0000-4000-8000-000000000099'");assert.equal((await db.query('select count(*)::int n from dowon_private.save_requests')).rows[0].n,0);await assert.rejects(db.query("insert into dowon_private.save_requests(actor_id,request_key,payload,result) values('00000000-0000-4000-8000-000000000001',gen_random_uuid(),'{}',1)"),/row-level security/);}finally{await db.exec('reset role;reset test.uid');}assert.equal((await db.query("select has_schema_privilege('anon','dowon_private','usage') allowed")).rows[0].allowed,false);});
