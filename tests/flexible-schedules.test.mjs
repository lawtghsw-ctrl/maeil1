import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

// Fabricated records in an isolated Postgres engine. No network or Supabase use.
const db=new PGlite();
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select nullif(coalesce(current_setting('test.uid',true),'00000000-0000-4000-8000-000000000001'),'')::uuid $$;
create table customers(id uuid primary key default gen_random_uuid(),name text default '테스트 고객');
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
after(()=>db.close());

async function customer(){return (await db.query('insert into customers default values returning id')).rows[0].id;}
async function payment(amount=500000,paid=0,customerId=null,parent=null){
 customerId??=await customer();
 const row=(await db.query(`insert into payment_schedules(customer_id,expected_amount,paid_amount,due_date,paid_date,status,rescheduled_from_id,schedule_type) values($1,$2,$3::bigint,'2026-10-15',case when $3::bigint>0 then date '2026-10-16' else null end,'연체',$4,case when $4::uuid is null then '일반' else '재약정' end) returning id`,[customerId,amount,paid,parent])).rows[0];
 return {id:row.id,customer:customerId,amount,paid};
}
async function repayment(amount=500000,paid=0,customerId=null,parent=null){
 customerId??=await customer();
 const row=(await db.query(`insert into repayment_schedules(customer_id,lender_name,repayment_amount,paid_amount,repayment_date,paid_date,status,rescheduled_from_id) values($1,'테스트 업체',$2,$3::numeric,'2026-10-15',case when $3::numeric>0 then date '2026-10-16' else null end,'연체',$4) returning id`,[customerId,amount,paid,parent])).rows[0];
 return {id:row.id,customer:customerId,amount,paid};
}
function payRow(p,patch={}){return {id:p.id,dueAmount:p.amount,paidAmount:p.paid,dueDate:'2026-10-15',paidDate:p.paid?'2026-10-16':'',status:'연체',paymentMethod:'계좌이체',memo:'사용자 입력',...patch};}
function repayRow(p,patch={}){return {id:p.id,amount:p.amount,paidAmount:p.paid,dueDate:'2026-10-15',paidDate:p.paid?'2026-10-16':'',status:'연체',lenderName:'테스트 업체',contactType:'',contactValue:'',account:'',memo:'사용자 입력',...patch};}
function batch(kind,customerId,rows,carries={},deleted=[]){return db.query(`select dowon_save_${kind}_batch($1,$2::jsonb,$3::jsonb,$4::uuid[])`,[customerId,JSON.stringify(rows),JSON.stringify(carries),deleted]);}
function once(kind,customerId,rows,carries,key,deleted=[]){return db.query('select dowon_save_schedule_batch_once($1,$2,$3::jsonb,$4::jsonb,$5::uuid[],$6)',[kind,customerId,JSON.stringify(rows),JSON.stringify(carries),deleted,key]);}
async function childAmounts(kind,parent){const table=kind==='payment'?'payment_schedules':'repayment_schedules',column=kind==='payment'?'expected_amount':'repayment_amount';return (await db.query(`select ${column}::int amount from ${table} where rescheduled_from_id=$1 and deleted_at is null order by ${column}`,[parent.id])).rows.map(x=>x.amount);}
function plan(kind,amount,date='2026-10-01'){return {dueDate:date,[kind==='payment'?'dueAmount':'amount']:amount,memo:'직접 입력한 새 일정'};}

for(const kind of ['payment','repayment']){
 const seed=kind==='payment'?payment:repayment,row=kind==='payment'?payRow:repayRow,table=kind==='payment'?'payment_schedules':'repayment_schedules',amountColumn=kind==='payment'?'expected_amount':'repayment_amount',dateColumn=kind==='payment'?'due_date':'repayment_date';
 test(`${kind}: normal new rows support zero amounts and unknown dates, then edit and delete`,async()=>{
  const customerId=await customer();
  await batch(kind,customerId,[row({amount:0,paid:0},{dueDate:'',paidDate:'',status:''})]);
  const inserted=(await db.query(`select id,${amountColumn}::int amount,paid_amount::int paid,${dateColumn} due_date,paid_date,status,root_schedule_id,reschedule_sequence,created_at,updated_at,admin_created_at from ${table} where customer_id=$1`,[customerId])).rows[0];
  assert.ok(inserted.id);assert.equal(inserted.amount,0);assert.equal(inserted.paid,0);assert.equal(inserted.due_date,null);assert.equal(inserted.paid_date,null);assert.equal(inserted.status,'예정');assert.equal(inserted.reschedule_sequence,0);
  assert.ok(inserted.created_at);assert.ok(inserted.updated_at);assert.ok(inserted.admin_created_at);
  if(kind==='payment')assert.equal(inserted.root_schedule_id,inserted.id);
  const saved={id:inserted.id,customer:customerId,amount:0,paid:0};
  await batch(kind,customerId,[row(saved,{[kind==='payment'?'dueAmount':'amount']:120000,paidAmount:5000,paidDate:'',memo:'신규 일정 수정'})]);
  assert.deepEqual((await db.query(`select ${amountColumn}::int amount,paid_amount::int paid,memo from ${table} where id=$1`,[saved.id])).rows[0],{amount:120000,paid:5000,memo:'신규 일정 수정'});
  await batch(kind,customerId,[],{},[saved.id]);
  const deleted=(await db.query(`select deleted_at,paid_amount::int paid from ${table} where id=$1`,[saved.id])).rows[0];
  assert.ok(deleted.deleted_at);assert.equal(deleted.paid,5000);
 });
 test(`${kind}: children remain editable and deletable with nested carries after the root is deleted`,async()=>{
  const p=await seed();await batch(kind,p.customer,[row(p)],{[p.id]:[plan(kind,300000)]});
  const child=(await db.query(`select id,root_schedule_id from ${table} where rescheduled_from_id=$1`,[p.id])).rows[0];
  const c={id:child.id,customer:p.customer,amount:300000,paid:0};
  assert.equal(child.root_schedule_id,p.id);
  await batch(kind,p.customer,[],{},[p.id]);
  await batch(kind,p.customer,[row(c,{[kind==='payment'?'dueAmount':'amount']:400000,paidAmount:50000,paidDate:'2026-10-17',memo:'원본 삭제 후 수정'})],{[c.id]:[plan(kind,900000,'')]});
  assert.deepEqual((await db.query(`select ${amountColumn}::int amount,paid_amount::int paid,memo,root_schedule_id from ${table} where id=$1`,[c.id])).rows[0],{amount:400000,paid:50000,memo:'원본 삭제 후 수정',root_schedule_id:p.id});
  const nested=(await db.query(`select root_schedule_id,reschedule_sequence from ${table} where rescheduled_from_id=$1`,[c.id])).rows[0];
  assert.equal(nested.root_schedule_id,p.id);assert.equal(nested.reschedule_sequence,2);
  await batch(kind,p.customer,[],{},[c.id]);
  assert.ok((await db.query(`select deleted_at from ${table} where id=$1`,[c.id])).rows[0].deleted_at);
  assert.deepEqual(await childAmounts(kind,c),[900000]);
 });
 test(`${kind}: deleting a parent and editing its linked child succeeds in one save`,async()=>{
  const p=await seed();await batch(kind,p.customer,[row(p)],{[p.id]:[plan(kind,300000)]});
  const child=(await db.query(`select id from ${table} where rescheduled_from_id=$1`,[p.id])).rows[0];
  await batch(kind,p.customer,[row({id:child.id,amount:300000,paid:0},{memo:'동시에 저장',paidAmount:70000,paidDate:'2026-10-17'})],{},[p.id]);
  assert.ok((await db.query(`select deleted_at from ${table} where id=$1`,[p.id])).rows[0].deleted_at);
  assert.deepEqual((await db.query(`select paid_amount::int paid,memo,deleted_at from ${table} where id=$1`,[child.id])).rows[0],{paid:70000,memo:'동시에 저장',deleted_at:null});
 });
 test(`${kind}: actual status CHECK failure rolls back inserts, edits, deletes and receipt`,async()=>{
  const p=await seed(),removed=await seed(100000,0,p.customer),key=crypto.randomUUID();
  const validNew=row({amount:200000,paid:0},{memo:'롤백할 신규 일정'}),invalidNew={...validNew,status:'존재하지 않는 상태'};
  await assert.rejects(once(kind,p.customer,[row(p,{memo:'롤백할 수정'}),validNew,invalidNew],{},key,[removed.id]),/status_check/);
  assert.equal((await db.query(`select count(*)::int n from ${table} where customer_id=$1`,[p.customer])).rows[0].n,2);
  assert.equal((await db.query(`select memo from ${table} where id=$1`,[p.id])).rows[0].memo,null);
  assert.equal((await db.query(`select deleted_at from ${table} where id=$1`,[removed.id])).rows[0].deleted_at,null);
  assert.equal((await db.query('select count(*)::int n from dowon_private.save_requests where request_key=$1',[key])).rows[0].n,0);
 });
 test(`${kind}: requested plans may exceed the parent, use earlier dates and append after prior rescheduling`,async()=>{
  const p=await seed(500000,100000);
  await batch(kind,p.customer,[row(p)],{[p.id]:[plan(kind,300000),plan(kind,350000)]});
  await batch(kind,p.customer,[row(p)],{[p.id]:[plan(kind,200000,'2026-09-01')]});
  assert.deepEqual(await childAmounts(kind,p),[200000,300000,350000]);
  const original=(await db.query(`select ${amountColumn}::int amount,paid_amount::int paid,paid_date::text paid_date from ${table} where id=$1`,[p.id])).rows[0];
  assert.deepEqual(original,{amount:500000,paid:100000,paid_date:'2026-10-16'});
 });
 test(`${kind}: under-budget plans and unrelated saves never create automatic remainder rows`,async()=>{
  const p=await seed(510000);
  await batch(kind,p.customer,[row(p)],{[p.id]:[plan(kind,300000)]});
  await batch(kind,p.customer,[row(p,{memo:'메모만 변경'})]);
  await batch(kind,p.customer,[row(p,{memo:'다시 저장'})]);
  assert.deepEqual(await childAmounts(kind,p),[300000]);
 });
 test(`${kind}: linked original amount, date, cash and status remain independently editable`,async()=>{
  const p=await seed(500000,100000);
  await batch(kind,p.customer,[row(p)],{[p.id]:[plan(kind,900000)]});
  const patch={[kind==='payment'?'dueAmount':'amount']:50000,dueDate:'2026-11-05',paidAmount:200000,paidDate:'2026-10-17',status:kind==='payment'?'완료':'종결'};
  await batch(kind,p.customer,[row(p,patch)]);
  const original=(await db.query(`select ${amountColumn}::int amount,paid_amount::int paid,${dateColumn}::text due_date,status from ${table} where id=$1`,[p.id])).rows[0];
  assert.deepEqual(original,{amount:50000,paid:200000,due_date:'2026-11-05',status:patch.status});
  assert.deepEqual(await childAmounts(kind,p),[900000]);
 });
 test(`${kind}: a zero original and unknown dates do not block manual plan or status updates`,async()=>{
  const p=await seed(0);
  await batch(kind,p.customer,[row(p,{dueDate:'',paidAmount:120000,paidDate:'',status:kind==='payment'?'완료':'상환완료'})],{[p.id]:[plan(kind,130000,'')]});
  const original=(await db.query(`select paid_amount::int paid,paid_date,${dateColumn} due_date from ${table} where id=$1`,[p.id])).rows[0];
  assert.deepEqual(original,{paid:120000,paid_date:null,due_date:null});
  assert.deepEqual(await childAmounts(kind,p),[130000]);
  assert.equal((await db.query(`select ${dateColumn} due_date from ${table} where rescheduled_from_id=$1`,[p.id])).rows[0].due_date,null);
 });
 test(`${kind}: marking complete never fabricates a payment amount or payment date`,async()=>{
  const p=await seed();
  await batch(kind,p.customer,[row(p,{status:kind==='payment'?'완료':'상환완료'})]);
  assert.deepEqual((await db.query(`select paid_amount::int paid,paid_date from ${table} where id=$1`,[p.id])).rows[0],{paid:0,paid_date:null});
  if(kind==='payment')assert.equal((await db.query('select count(*)::int n from settlement_entries where customer_id=$1',[p.customer])).rows[0].n,0);
 });
 test(`${kind}: soft deleting a linked parent preserves the child's cash and schedule`,async()=>{
  const p=await seed();
  const child=await seed(300000,20000,p.customer,p.id);
  await batch(kind,p.customer,[],{},[p.id]);
  assert.notEqual((await db.query(`select deleted_at from ${table} where id=$1`,[p.id])).rows[0].deleted_at,null);
  const retained=(await db.query(`select ${amountColumn}::int amount,paid_amount::int paid,deleted_at from ${table} where id=$1`,[child.id])).rows[0];
  assert.deepEqual(retained,{amount:300000,paid:20000,deleted_at:null});
 });
 test(`${kind}: retrying a committed plan request never creates duplicate children`,async()=>{
  const p=await seed();const key=crypto.randomUUID();const rows=[row(p)],carries={[p.id]:[plan(kind,700000),plan(kind,900000)]};
  await once(kind,p.customer,rows,carries,key);await once(kind,p.customer,rows,carries,key);
  assert.deepEqual(await childAmounts(kind,p),[700000,900000]);
  await assert.rejects(once(kind,p.customer,rows,{[p.id]:[plan(kind,1)]},key),/내용이 변경/);
 });
 test(`${kind}: an orphaned carry rolls back edits, deletes and the retry receipt`,async()=>{
  const p=await seed(),deleted=await seed(200000,0,p.customer),orphan=await seed(300000,0,p.customer),key=crypto.randomUUID();
  await assert.rejects(once(kind,p.customer,[row(p,{memo:'롤백할 변경'})],{[orphan.id]:[plan(kind,900000)]},key,[deleted.id]),/원본.*목록/);
  assert.equal((await db.query(`select memo from ${table} where id=$1`,[p.id])).rows[0].memo,null);
  assert.equal((await db.query(`select deleted_at from ${table} where id=$1`,[deleted.id])).rows[0].deleted_at,null);
  assert.deepEqual(await childAmounts(kind,orphan),[]);
  assert.equal((await db.query('select count(*)::int n from dowon_private.save_requests where request_key=$1',[key])).rows[0].n,0);
  await once(kind,p.customer,[row(p)],{[p.id]:[plan(kind,900000)]},key);
  assert.deepEqual(await childAmounts(kind,p),[900000]);
 });
 test(`${kind}: duplicate original IDs cannot apply a carry twice or create a success receipt`,async()=>{
  const p=await seed(),key=crypto.randomUUID();
  await assert.rejects(once(kind,p.customer,[row(p,{memo:'롤백할 변경'}),row(p)],{[p.id]:[plan(kind,900000)]},key),/중복/);
  assert.equal((await db.query(`select memo from ${table} where id=$1`,[p.id])).rows[0].memo,null);
  assert.deepEqual(await childAmounts(kind,p),[]);
  assert.equal((await db.query('select count(*)::int n from dowon_private.save_requests where request_key=$1',[key])).rows[0].n,0);
 });
 test(`${kind}: a foreign customer's row rolls back all edits and newly requested plans`,async()=>{
  const p=await seed(),foreign=await seed();
  await assert.rejects(batch(kind,p.customer,[row(p,{memo:'이 내용도 롤백'}),row(foreign)],{[p.id]:[plan(kind,900000)]}));
  assert.deepEqual(await childAmounts(kind,p),[]);
  assert.equal((await db.query(`select memo from ${table} where id=$1`,[p.id])).rows[0].memo,null);
 });
 test(`${kind}: negative values are still invalid and roll back an entire batch`,async()=>{
  const p=await seed();
  await assert.rejects(batch(kind,p.customer,[row(p,{memo:'롤백'}),{...row(p),id:undefined,[kind==='payment'?'dueAmount':'amount']:-1}]));
  assert.equal((await db.query(`select memo from ${table} where id=$1`,[p.id])).rows[0].memo,null);
 });
}

test('plan changes preserve allocation records and exact cash settlement amounts',async()=>{
 const p=await payment(500000,100000);
 const recovery=(await db.query('insert into recoveries(customer_id,amount) values($1,400000) returning id',[p.customer])).rows[0].id;
 await db.query('select dowon_apply_recovery_split($1,200000,$2::jsonb)',[recovery,JSON.stringify([{paymentId:p.id,amount:200000}])]);
 const allocationsBefore=(await db.query('select * from recovery_fee_allocations where payment_schedule_id=$1',[p.id])).rows;
 await batch('payment',p.customer,[payRow(p,{dueAmount:50000})],{[p.id]:[plan('payment',900000)]});
 assert.deepEqual((await db.query('select * from recovery_fee_allocations where payment_schedule_id=$1',[p.id])).rows,allocationsBefore);
 assert.deepEqual((await db.query('select amount::int amount,payment_date::text paid_date from settlement_entries where customer_id=$1 and deleted_at is null',[p.customer])).rows,[{amount:100000,paid_date:'2026-10-16'}]);
 await assert.rejects(batch('payment',p.customer,[],{},[p.id]));
 await assert.rejects(db.query('delete from payment_schedules where id=$1',[p.id]));
 assert.deepEqual((await db.query('select * from recovery_fee_allocations where payment_schedule_id=$1',[p.id])).rows,allocationsBefore);
});

test('same-customer parent protection still rejects cross-customer and self-linked schedules',async()=>{
 const p=await payment(),foreign=await payment();
 await assert.rejects(db.query(`insert into payment_schedules(customer_id,expected_amount,paid_amount,rescheduled_from_id,schedule_type) values($1,100,0,$2,'재약정')`,[foreign.customer,p.id]));
 await assert.rejects(db.query('update payment_schedules set rescheduled_from_id=id where id=$1',[p.id]));
 const child=await payment(100,0,p.customer,p.id);
 await assert.rejects(db.query('update payment_schedules set customer_id=$1 where id=$2',[foreign.customer,child.id]));
});

test('direct edits of child amounts do not encounter an obsolete deferred parent-balance trigger',async()=>{
 const p=await payment(110000),child=await payment(110000,0,p.customer,p.id);
 await db.query('update payment_schedules set expected_amount=330000 where id=$1',[child.id]);
 assert.deepEqual(await childAmounts('payment',p),[330000]);
});

test('legacy split helper appends the requested sibling without changing existing cash or plans',async()=>{
 const p=await payment(100000),child=await payment(100000,30000,p.customer,p.id);
 await payment(20000,0,p.customer,child.id);
 await db.query("select dowon_split_rescheduled_payment($1,'2026-09-01',900000)",[child.id]);
 assert.deepEqual(await childAmounts('payment',p),[100000,900000]);
 const original=(await db.query('select expected_amount::int amount,paid_amount::int paid from payment_schedules where id=$1',[child.id])).rows[0];
 assert.deepEqual(original,{amount:100000,paid:30000});
});

test('legacy carry helper uses flexible saving even when siblings exist and dates move earlier',async()=>{
 const p=await payment();await payment(900000,0,p.customer,p.id);
 const result=await db.query("select dowon_save_payment_with_carry($1,'2026-09-15',600000,null,100000,'완료','계좌이체','사용자 변경','2026-09-01','기존 클라이언트') as id",[p.id]);
 assert.ok(result.rows[0].id);
 assert.deepEqual(await childAmounts('payment',p),[500000,900000]);
 assert.deepEqual((await db.query('select expected_amount::int amount,paid_amount::int paid,paid_date from payment_schedules where id=$1',[p.id])).rows[0],{amount:600000,paid:100000,paid_date:null});
});

test('anonymous callers cannot use either batch or the flexible implementation',async()=>{
 const p=await payment(),r=await repayment();
 await db.exec("set test.uid=''");
 try{
  await assert.rejects(batch('payment',p.customer,[payRow(p)]));
  await assert.rejects(batch('repayment',r.customer,[repayRow(r)]));
  await assert.rejects(db.query("select dowon_save_schedules_flexible('payment',$1,$2::jsonb,'{}','{}')",[p.customer,JSON.stringify([payRow(p)])]));
 }finally{await db.exec('reset test.uid');}
});
