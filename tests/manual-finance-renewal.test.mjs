import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
import {db} from './helpers/schedule-renewal-db.mjs';

const migration='tests/fixtures/dowon-reference/supabase/migrations/20261019115223_manual_schedule_recovery_renewal.sql';
async function customer(amount=1000000){return (await db.query('insert into customers(contract_amount) values($1) returning id',[amount])).rows[0].id;}
async function seed(kind,{customerId,amount=500000,paid=0,date='2026-10-16',parent=null}={}){
 customerId??=await customer();
 const table=kind==='payment'?'payment_schedules':'repayment_schedules';
 const record=(await db.query(kind==='payment'?
  `insert into payment_schedules(customer_id,expected_amount,paid_amount,due_date,paid_date,status,rescheduled_from_id,root_schedule_id,schedule_type) values($1,$2,$3::numeric,$4,case when $3::numeric>0 then date '2026-10-16' else null end,'연체',$5,$5,case when $5::uuid is null then '일반' else '재약정' end) returning *`:
  `insert into repayment_schedules(customer_id,repayment_amount,paid_amount,repayment_date,paid_date,status,rescheduled_from_id,root_schedule_id,lender_name) values($1,$2,$3,$4,case when $3::numeric>0 then date '2026-10-16' else null end,'연체',$5,$5,'테스트 업체') returning *`,[customerId,amount,paid,date,parent])).rows[0];
 return {kind,table,id:record.id,customerId,amount,paid,date};
}
function row(s,patch={}){return {id:s.id,[s.kind==='payment'?'dueAmount':'amount']:s.amount,paidAmount:s.paid,dueDate:s.date||'',paidDate:s.paid?'2026-10-16':'',status:'연체',paymentMethod:'계좌이체',lenderName:'테스트 업체',memo:'테스트',...patch};}
async function versions(table,customerId){return (await db.query(`select coalesce(jsonb_object_agg(id,row_version),'{}'::jsonb) v from ${table} where customer_id=$1 and deleted_at is null`,[customerId])).rows[0].v;}
async function save(s,rows,deleted=[],options={}){return db.query('select dowon_save_schedule_batch_v3($1,$2,$3::jsonb,$4::uuid[],$5,$6::jsonb)',[s.kind,s.customerId,JSON.stringify(rows),deleted,options.key??crypto.randomUUID(),JSON.stringify(options.versions??await versions(s.table,s.customerId))]);}
async function current(s){return (await db.query(`select *,paid_date::text cash_date from ${s.table} where id=$1`,[s.id])).rows[0];}
async function projection(kind,customerId){return (await db.query('select dowon_schedule_projection($1,$2) p',[kind,customerId])).rows[0].p;}
function recovery(patch={}){return {amount:1000000,recoveryDate:'2026-10-19',lenderName:'테스트 업체',depositorName:'실제 입금자',paymentMethod:'계좌이체',memo:'가상 환수',installmentAmount:200000,clientReturnAmount:300000,...patch};}
async function saveRecovery(customerId,rows,deleted=[],options={}){return db.query('select dowon_save_recovery_batch_v2($1,$2::jsonb,$3::uuid[],$4,$5::jsonb)',[customerId,JSON.stringify(rows),deleted,options.key??crypto.randomUUID(),JSON.stringify(options.versions??await versions('recoveries',customerId))]);}
async function recoveries(customerId){return (await db.query('select * from recoveries where customer_id=$1 order by id',[customerId])).rows;}
async function components(id,live=true){return (await db.query(`select recovery_component component,amount::int amount,entry_type type,user_deleted,deleted_at from settlement_entries where source_recovery_id=$1${live?' and deleted_at is null':''} order by recovery_component`,[id])).rows;}

// Seed imported data before the migration to verify there is no silent rewrite.
const untouchedCustomer=await customer();
const untouchedRecovery=(await db.query("insert into recoveries(customer_id,recovery_date,lender_name,depositor_name,amount,payment_method,memo) values($1,'2026-08-27','과거 업체','과거 예금주',100000,'계좌이체','원본 메모') returning id",[untouchedCustomer])).rows[0].id;
const importedPayment=await seed('payment',{customerId:untouchedCustomer,paid:30000});
const legacyCustomer=await customer();
const legacyPayment=await seed('payment',{customerId:legacyCustomer,amount:200000});
const legacyRecovery=(await db.query("insert into recoveries(customer_id,recovery_date,lender_name,depositor_name,amount,payment_method,memo) values($1,'2026-10-01','구형 업체','구형 입금자',200000,'계좌이체','구형 기록') returning id",[legacyCustomer])).rows[0].id;
await db.query('insert into recovery_fee_splits(recovery_id,customer_id,success_fee,applied_fee,refund_due) values($1,$2,100000,60000,40000)',[legacyRecovery,legacyCustomer]);
await db.query('insert into recovery_fee_allocations(recovery_id,customer_id,payment_schedule_id,amount) values($1,$2,$3,60000)',[legacyRecovery,legacyCustomer,legacyPayment.id]);
const legacyRefund=(await db.query("insert into recovery_refunds(recovery_id,customer_id,refund_date,amount,recipient_name,request_key) values($1,$2,'2026-10-02',20000,'테스트 수취인',gen_random_uuid()) returning id",[legacyRecovery,legacyCustomer])).rows[0].id;
const blankLegacyCustomer=await customer();
const blankLegacyRecovery=(await db.query("insert into recoveries(customer_id,recovery_date,lender_name,depositor_name,amount,payment_method,memo) values($1,'2026-09-01','구형 업체','',100000,'계좌이체','과거 예금주 미입력') returning id",[blankLegacyCustomer])).rows[0].id;
const importedSnapshot=(await db.query('select id,due_date::text due,expected_amount,paid_date::text paid_date,paid_amount,status,memo from payment_schedules order by id')).rows;
const legacyAllocationSnapshot=(await db.query('select * from recovery_fee_allocations')).rows;
const legacyRefundSnapshot=(await db.query('select id,amount,refund_date::text date,recipient_name from recovery_refunds')).rows;
await db.exec(fs.readFileSync(migration,'utf8'));
after(()=>db.close());

test('migration preserves all imported cash, dates, allocations and return facts',async()=>{
 assert.deepEqual((await db.query('select id,due_date::text due,expected_amount,paid_date::text paid_date,paid_amount,status,memo from payment_schedules order by id')).rows,importedSnapshot);
 assert.deepEqual((await db.query('select * from recovery_fee_allocations')).rows,legacyAllocationSnapshot);
 assert.deepEqual((await db.query('select id,amount,refund_date::text date,recipient_name from recovery_refunds')).rows,legacyRefundSnapshot);
 const old=(await recoveries(untouchedCustomer))[0];assert.equal(old.accounting_version,1);assert.equal(Number(old.success_fee_amount),0);
 assert.equal((await current(importedPayment)).date_change_count,0);assert.equal((await components(untouchedRecovery)).length,0);
 assert.equal((await db.query('select count(*)::int n from settlement_entries where customer_id=$1 and deleted_at is null',[untouchedCustomer])).rows[0].n,2);
});
test('repayment view retains its original columns and exposes the complete store projection',async()=>{
 await db.query('select date_change_count from dowon_repayment_promises limit 0');
 await db.query('select id,customer_id,admin_created_at,lender_name,lender_contact_type,lender_contact_value,repayment_date,repayment_amount,account_info,status,memo,paid_amount,paid_date,rescheduled_from_id,root_schedule_id,reschedule_sequence,promise_state,row_version,obligation_amount,root_obligation_amount,date_change_count from dowon_repayment_promises where deleted_at is null order by repayment_date desc,admin_created_at desc,id desc limit 0');
 const columns=(await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='dowon_repayment_promises' order by ordinal_position")).rows.map(r=>r.column_name);
 assert.deepEqual(columns.slice(-2),['root_obligation_amount','date_change_count']);
});
test('migration preservation guard aborts and rolls back any existing financial-row change',async()=>{
 const isolated=new PGlite();try{
  for(const table of ['payment_schedules','repayment_schedules','recoveries','settlement_entries','recovery_fee_allocations','recovery_fee_splits','recovery_refunds'])await isolated.exec(`create table ${table}(id integer primary key,amount numeric);insert into ${table} values(1,100);`);
  const sql=fs.readFileSync(migration,'utf8'),before=sql.slice(0,sql.indexOf('ALTER TABLE public.payment_schedules ADD COLUMN')),after=sql.slice(sql.lastIndexOf('DO $$'));
  await isolated.exec(before+after);
  await assert.rejects(isolated.exec(before+'UPDATE payment_schedules SET amount=999 WHERE id=1;'+after),/changed existing financial rows/);
  await isolated.exec('rollback');assert.equal(Number((await isolated.query('select amount from payment_schedules where id=1')).rows[0].amount),100);
 }finally{await isolated.close();}
});

for(const kind of ['payment','repayment']){
 test(`${kind}: each committed existing-date change counts once, including retry`,async()=>{
  const s=await seed(kind,{paid:200000});const v=await versions(s.table,s.customerId),key=crypto.randomUUID();
  const changed=[row(s,{dueDate:'2026-10-20',dateChangeCount:999})];
  await save(s,changed,[],{key,versions:v});await save(s,changed,[],{key,versions:v});
  assert.equal((await current(s)).date_change_count,1);assert.equal(Number((await current(s)).paid_amount),200000);assert.equal((await current(s)).cash_date,'2026-10-16');
  await save(s,[row(s,{dueDate:'2026-10-20',memo:'금액만 수정',[kind==='payment'?'dueAmount':'amount']:600000})]);
  assert.equal((await current(s)).date_change_count,1);
  await save(s,[row(s,{dueDate:'2026-10-21'})]);assert.equal((await current(s)).date_change_count,2);
  await assert.rejects(save(s,[row(s,{dueDate:'2026-10-22'})],[],{versions:v}),/다른 화면/);assert.equal((await current(s)).date_change_count,2);
 });
 test(`${kind}: initial date, blank date, inserts and forged counts do not add misses`,async()=>{
  const s=await seed(kind,{date:null});assert.equal((await current(s)).date_change_count,0);
  await save(s,[row(s,{dueDate:'2026-10-20',dateChangeCount:99})]);assert.equal((await current(s)).date_change_count,0);
  await save(s,[row(s,{dueDate:'',dateChangeCount:99})]);assert.equal((await current(s)).date_change_count,0);
  await db.query(`update ${s.table} set date_change_count=99 where id=$1`,[s.id]);assert.equal((await current(s)).date_change_count,0);
 });
 test(`${kind}: direct amount edits and independent new plans bypass obsolete family limits`,async()=>{
  const s=await seed(kind,{paid:200000});
  const child=await seed(kind,{customerId:s.customerId,amount:300000,parent:s.id});
  await db.query(`update ${s.table} set promise_state='rescheduled' where id=$1`,[s.id]);
  await save(s,[row(child,{[kind==='payment'?'dueAmount':'amount']:900000}),{[kind==='payment'?'dueAmount':'amount']:700000,dueDate:'2026-11-01',paidAmount:0,status:'예정'}]);
  assert.equal(Number((await current(child))[kind==='payment'?'expected_amount':'repayment_amount']),900000);
  assert.equal(Number((await current(s)).paid_amount),200000);
  const p=await projection(kind,s.customerId);assert.equal(p.rows[child.id].remaining,900000);assert.equal(p.summary.planned,1600000);
  assert.equal(p.summary.remaining,kind==='payment'?800000:1000000);assert.ok(p.summary.overplanned>0);
 });
 test(`${kind}: deleting a promise preserves paid receipt and actual cash date`,async()=>{
  const s=await seed(kind,{paid:200000});const before=await current(s);await save(s,[],[s.id]);const after=await current(s);
  assert.equal(after.promise_state,'cancelled');assert.equal(after.deleted_at,null);assert.equal(Number(after.paid_amount),200000);assert.equal(after.cash_date,before.cash_date);
  assert.equal((await projection(kind,s.customerId)).summary.paid,200000);
  if(kind==='payment')assert.equal((await db.query('select amount::int n from settlement_entries where source_payment_schedule_id=$1 and deleted_at is null',[s.id])).rows[0].n,200000);
 });
 test(`${kind}: a failed batch rolls back earlier date changes and request receipt`,async()=>{
  const s=await seed(kind);const key=crypto.randomUUID();
  await assert.rejects(save(s,[row(s,{dueDate:'2026-11-01'}),{[kind==='payment'?'dueAmount':'amount']:-1}],[],{key}),/금액/);
  assert.equal((await current(s)).date_change_count,0);
  assert.equal((await db.query('select count(*)::int n from dowon_private.save_requests where request_key=$1',[key])).rows[0].n,0);
 });
}
for(const state of ['rescheduled','cancelled'])test(`historical ${state} receipt corrections preserve its state and the later plan`,async()=>{
 const cid=await customer(500000),old=await seed('payment',{customerId:cid,paid:200000}),child=await seed('payment',{customerId:cid,amount:300000,parent:old.id});
 await db.query('update payment_schedules set promise_state=$2 where id=$1',[old.id,state]);
 await save(old,[row(old,{paidAmount:250000,paidDate:'2026-10-17',promiseState:state,memo:'실제 입금 정정'})]);
 assert.equal((await current(old)).promise_state,state);assert.equal(Number((await current(old)).paid_amount),250000);assert.equal(Number((await current(child)).expected_amount),300000);
 assert.deepEqual((await db.query('select amount::int amount,payment_date::text paid_date from settlement_entries where source_payment_schedule_id=$1 and deleted_at is null',[old.id])).rows[0],{amount:250000,paid_date:'2026-10-17'});
 const p=await projection('payment',cid);assert.equal(p.summary.remaining,250000);assert.equal(p.rows[child.id].remaining,300000);assert.equal(p.summary.overplanned,50000);
});

test('detailed recovery saves three nonzero components once and retains gross bank receipt',async()=>{
 const cid=await customer(),key=crypto.randomUUID(),v=await versions('recoveries',cid),payload=[recovery()];
 await saveRecovery(cid,payload,[],{key,versions:v});await saveRecovery(cid,payload,[],{key,versions:v});
 const records=await recoveries(cid);assert.equal(records.length,1);const r=records[0];assert.equal(r.accounting_version,2);assert.equal(Number(r.success_fee_amount),500000);
 assert.deepEqual((await components(r.id)).map(({component,amount,type})=>({component,amount,type})),[
  {component:'client_return',amount:-300000,type:'의뢰인 환수 반환금'},
  {component:'installment',amount:200000,type:'환수 분납금'},
  {component:'success_fee',amount:500000,type:'환수 성공보수'}]);
 const cash=(await db.query('select id,paid_amount::int amount,paid_date::text date,deleted_at,date_change_count from payment_schedules where source_recovery_id=$1',[r.id])).rows[0];
 assert.deepEqual({amount:cash.amount,date:cash.date,deleted:cash.deleted_at,count:cash.date_change_count},{amount:1000000,date:'2026-10-19',deleted:null,count:0});
 assert.equal((await db.query('select count(*)::int n from settlement_entries where source_payment_schedule_id=$1 and deleted_at is null',[cash.id])).rows[0].n,0);
 const p=await projection('payment',cid);assert.equal(p.summary.paid,0);assert.equal(p.summary.allocated,200000);assert.equal(p.summary.remaining,800000);
});
test('blank/zero manual fields produce only the automatic success fee, with integer 50% rounding',async()=>{
 const cid=await customer();await saveRecovery(cid,[recovery({amount:100001,installmentAmount:0,clientReturnAmount:0})]);
 const r=(await recoveries(cid))[0];assert.equal(Number(r.success_fee_amount),50000);
 assert.deepEqual((await components(r.id)).map(c=>[c.component,c.amount]),[['success_fee',50000]]);
});
test('converting one old recovery leaves other imported recoveries untouched and keeps old cash live',async()=>{
 const oldCash=(await db.query('select id,paid_amount::int amount,paid_date::text date from payment_schedules where source_recovery_id=$1',[legacyRecovery])).rows[0];
 await saveRecovery(legacyCustomer,[recovery({id:legacyRecovery,amount:200000,recoveryDate:'2026-10-01',lenderName:'구형 업체',depositorName:'구형 입금자',installmentAmount:60000,clientReturnAmount:40000})]);
 assert.equal((await recoveries(legacyCustomer))[0].accounting_version,2);assert.equal((await recoveries(untouchedCustomer))[0].accounting_version,1);
 assert.deepEqual((await db.query('select id,paid_amount::int amount,paid_date::text date from payment_schedules where source_recovery_id=$1 and deleted_at is null',[legacyRecovery])).rows[0],oldCash);
 assert.equal((await db.query('select count(*)::int n from settlement_entries where source_payment_schedule_id=$1 and deleted_at is null',[oldCash.id])).rows[0].n,0);
 assert.deepEqual((await db.query('select * from recovery_fee_allocations')).rows,legacyAllocationSnapshot);
 assert.deepEqual((await db.query('select id,amount,refund_date::text date,recipient_name from recovery_refunds')).rows,legacyRefundSnapshot);
 assert.equal((await db.query('select count(*)::int n from dowon_active_recovery_allocations where recovery_id=$1',[legacyRecovery])).rows[0].n,0);
 assert.equal((await components(legacyRecovery)).find(r=>r.component==='client_return').amount,-20000);
 assert.equal((await projection('payment',legacyCustomer)).summary.allocated,60000);
});
test('detailed recovery changes upsert existing components, clear zero components and reject stale saves',async()=>{
 const cid=await customer();await saveRecovery(cid,[recovery()]);const r=(await recoveries(cid))[0],v=await versions('recoveries',cid);
 await saveRecovery(cid,[recovery({id:r.id,amount:800000,installmentAmount:200000,clientReturnAmount:0,recoveryDate:'2026-10-20'})]);
 assert.deepEqual((await components(r.id)).map(c=>[c.component,c.amount]),[['installment',200000],['success_fee',400000]]);
 assert.equal((await components(r.id,false)).length,3);assert.equal((await db.query('select date_change_count n from payment_schedules where source_recovery_id=$1',[r.id])).rows[0].n,0);
 await assert.rejects(saveRecovery(cid,[recovery({id:r.id})],[],{versions:v}),/다른 화면/);
});
test('invalid recovery amounts, split excess and excess contract credit roll back source cash and all components',async()=>{
 for(const patch of [{installmentAmount:1.5},{amount:-1},{installmentAmount:300000,clientReturnAmount:300000}]){
  const cid=await customer();await assert.rejects(saveRecovery(cid,[recovery(patch)]),/금액|초과/);assert.equal((await recoveries(cid)).length,0);
 }
 const cid=await customer(100000);await assert.rejects(saveRecovery(cid,[recovery({installmentAmount:200000,clientReturnAmount:0})]),/계약금/);
 assert.equal((await recoveries(cid)).length,0);assert.equal((await db.query('select count(*)::int n from payment_schedules where customer_id=$1',[cid])).rows[0].n,0);
});
test('confirmed legacy returns cannot be reduced, deleted or counted twice',async()=>{
 await assert.rejects(saveRecovery(legacyCustomer,[recovery({id:legacyRecovery,amount:200000,installmentAmount:60000,clientReturnAmount:10000})]),/이미 반환/);
 await assert.rejects(saveRecovery(legacyCustomer,[],[legacyRecovery]),/반환 이력/);
 assert.equal((await db.query('select amount::int amount from recovery_refunds where id=$1',[legacyRefund])).rows[0].amount,20000);
});
test('legacy recovery with an empty historical depositor can be archived without filling new fields',async()=>{
 await saveRecovery(blankLegacyCustomer,[],[blankLegacyRecovery]);
 const archived=(await recoveries(blankLegacyCustomer))[0];assert.ok(archived.deleted_at);assert.equal(archived.depositor_name,'');assert.equal(Number(archived.amount),100000);
 const cash=(await db.query('select paid_amount::int amount,paid_date::text paid_date,deleted_at from payment_schedules where source_recovery_id=$1',[blankLegacyRecovery])).rows[0];
 assert.equal(cash.amount,100000);assert.equal(cash.paid_date,'2026-09-01');assert.ok(cash.deleted_at);
});
test('a hidden automatic payment statement never returns after receipt edits; source cash remains editable',async()=>{
 const s=await seed('payment',{paid:200000}),line=(await db.query('select id from settlement_entries where source_payment_schedule_id=$1',[s.id])).rows[0];
 await db.query('select dowon_delete_settlement($1)',[line.id]);await save(s,[row(s,{paidAmount:210000,paidDate:'2026-10-17'})]);
 const record=(await db.query('select user_deleted,deleted_at from settlement_entries where id=$1',[line.id])).rows[0];assert.equal(record.user_deleted,true);assert.ok(record.deleted_at);
 assert.equal(Number((await current(s)).paid_amount),210000);assert.equal((await current(s)).cash_date,'2026-10-17');
});
test('a hidden detailed component stays hidden on recovery edits without hiding other components',async()=>{
 const cid=await customer();await saveRecovery(cid,[recovery()]);const r=(await recoveries(cid))[0];
 const fee=(await db.query("select id from settlement_entries where source_recovery_id=$1 and recovery_component='success_fee'",[r.id])).rows[0];
 await db.query('select dowon_delete_settlement($1)',[fee.id]);
 await saveRecovery(cid,[recovery({id:r.id,amount:1200000,installmentAmount:200000,clientReturnAmount:300000})]);
 assert.deepEqual((await components(r.id)).map(c=>c.component),['client_return','installment']);
 assert.equal(Number((await recoveries(cid))[0].success_fee_amount),600000);
});
test('legacy return statement hide preserves actual return and only grants display-flag updates',async()=>{
 await db.query('select dowon_delete_settlement($1)',[legacyRefund]);
 const record=(await db.query('select settlement_hidden,amount::int amount from recovery_refunds where id=$1',[legacyRefund])).rows[0];assert.deepEqual(record,{settlement_hidden:true,amount:20000});
 const privileges=(await db.query("select has_column_privilege('authenticated','recovery_refunds','settlement_hidden','UPDATE') can_hide,has_column_privilege('authenticated','recovery_refunds','amount','UPDATE') can_change_cash")).rows[0];
 assert.deepEqual(privileges,{can_hide:true,can_change_cash:false});
});
test('old clients and anonymous mutation calls fail explicitly',async()=>{
 await assert.rejects(db.query("select dowon_save_schedule_batch_v2('payment',$1,'[]','{}','{}',gen_random_uuid(),'{}')",[untouchedCustomer]),/새로고침/);
 await assert.rejects(db.query("select dowon_save_finance_batch('recovery',$1,'[]','{}')",[untouchedCustomer]),/새로고침/);
 await assert.rejects(db.query("select dowon_apply_recovery_split($1,0,'[]')",[untouchedRecovery]),/새로고침/);
 await db.exec("set test.uid=''");try{await assert.rejects(saveRecovery(untouchedCustomer,[]),/로그인/);await assert.rejects(db.query('select dowon_delete_settlement($1)',[legacyRefund]),/로그인/);}finally{await db.exec("set test.uid='00000000-0000-4000-8000-000000000001'");}
 const grants=(await db.query("select has_function_privilege('anon','dowon_save_schedule_batch_v3(text,uuid,jsonb,uuid[],uuid,jsonb)','EXECUTE') schedule,has_function_privilege('anon','dowon_save_recovery_batch_v2(uuid,jsonb,uuid[],uuid,jsonb)','EXECUTE') recovery,has_function_privilege('anon','dowon_delete_settlement(uuid)','EXECUTE') deletion")).rows[0];
 assert.deepEqual(grants,{schedule:false,recovery:false,deletion:false});
});
test('actual TypeScript ledger and database projection agree for every fabricated customer and schedule',async()=>{
 const compiled=ts.transpileModule(fs.readFileSync('lib/schedule-ledger.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};vm.runInNewContext(compiled,{module,exports:module.exports});
 const build=module.exports.buildScheduleLedger;
 const customers=(await db.query('select id,contract_amount::int amount from customers')).rows;
 for(const c of customers)for(const kind of ['payment','repayment']){
  const records=(await db.query(kind==='payment'?
   `select p.*,p.due_date::text as due_day,coalesce((select sum(a.amount) from dowon_active_recovery_allocations a where a.payment_schedule_id=p.id),0) credit from payment_schedules p where p.customer_id=$1 and p.deleted_at is null`:
   `select p.*,p.repayment_date::text as due_day from dowon_repayment_promises p where p.customer_id=$1`,[c.id])).rows;
  const extra=Number((await db.query('select coalesce(sum(installment_amount),0) credit from recoveries where customer_id=$1 and accounting_version=2 and deleted_at is null',[c.id])).rows[0].credit);
  const rows=records.map(r=>({id:r.id,customerId:r.customer_id,dueDate:r.due_day||'',dueAmount:Number(r.expected_amount??r.repayment_amount),paidAmount:Number(r.paid_amount),allocatedAmount:Number(r.credit||0),
   status:r.status,scheduleType:r.schedule_type,promiseState:r.promise_state||undefined,rootScheduleId:r.root_schedule_id,rescheduledFromId:r.rescheduled_from_id,
   obligationAmount:r.obligation_amount===null?undefined:Number(r.obligation_amount),rootObligationAmount:r.root_obligation_amount==null?undefined:Number(r.root_obligation_amount)}));
  const ledger=build(rows,kind==='payment'?c.amount:undefined,kind==='payment'?extra:0),p=await projection(kind,c.id),t=ledger.totals;
  assert.deepEqual({paid:p.summary.paid,credit:p.summary.allocated,owed:p.summary.obligation,remaining:p.summary.remaining,planned:p.summary.planned,undated:p.summary.undated,unassigned:p.summary.unassigned,overplanned:p.summary.overplanned},
   {paid:t.paid,credit:t.credit,owed:t.owed,remaining:t.remaining,planned:t.planned,undated:t.undated,unassigned:t.unassigned,overplanned:t.overplanned},`${kind} totals must agree`);
  for(const r of rows){const pos=ledger.byId.get(r.id);assert.equal(p.rows[r.id].remaining,pos.remaining);assert.equal(p.rows[r.id].state,pos.state);}
 }
});
