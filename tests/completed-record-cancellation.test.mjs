import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {db} from './helpers/schedule-renewal-db.mjs';

// Exercise the real store payload, retry/version adapter, existing RPC, and
// settlement triggers against fabricated records in an isolated Postgres engine.
// This file does not connect to Supabase or alter production data.
await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/supabase/migrations/20261019115223_manual_schedule_recovery_renewal.sql','utf8'));
after(()=>db.close());

const storeSource=fs.readFileSync('components/store.tsx','utf8');
const ast=ts.createSourceFile('store.tsx',storeSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function evaluate(source,context={}){
 return vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{Error,...context});
}
function method(name,context){
 let found;function visit(node){if(ts.isMethodDeclaration(node)&&node.name.getText(ast)===name)found=node;ts.forEachChild(node,visit);}visit(ast);
 assert.ok(found,name);return evaluate(`const handler=${found.getText(ast).replace(`async ${name}(`,'async function(')};handler`,context);
}
function realSaveBatch(context){
 let found;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='saveBatch')found=node.initializer.arguments[0];ts.forEachChild(node,visit);}visit(ast);
 assert.ok(found);return evaluate(`const handler=${found.getText(ast)};handler`,context);
}
const retryModule={exports:{}};
evaluate(fs.readFileSync('lib/supabase/retryable-save.ts','utf8'),{exports:retryModule.exports});
const {createRetryableSave}=retryModule.exports;

async function seed(kind,{state='active',paid=200000,paidDate=paid?'2026-10-21':null,amount=500000,customerId,parent=null}={}){
 customerId??=(await db.query('insert into customers(contract_amount) values(1000000) returning id')).rows[0].id;
 const table=kind==='payment'?'payment_schedules':'repayment_schedules';
 const row=(await db.query(kind==='payment'?
  `insert into payment_schedules(customer_id,expected_amount,paid_amount,due_date,paid_date,status,promise_state,rescheduled_from_id,root_schedule_id,schedule_type,memo,payment_method)
   values($1,$2,$3,'2026-10-21',$4,'완료',$5,$6,$6,case when $6::uuid is null then '일반' else '재약정' end,'original cash','계좌이체') returning id`:
  `insert into repayment_schedules(customer_id,repayment_amount,paid_amount,repayment_date,paid_date,status,promise_state,rescheduled_from_id,root_schedule_id,lender_name,memo)
   values($1,$2,$3,'2026-10-21',$4,'상환완료',$5,$6,$6,'가상 업체','original cash') returning id`,[customerId,amount,paid,paidDate,state,parent])).rows[0];
 return {kind,table,id:row.id,customerId};
}
async function snapshot(s){
 return (await db.query(`select *,paid_date::text cash_date,${s.kind==='payment'?'due_date':'repayment_date'}::text due from ${s.table} where id=$1`,[s.id])).rows[0];
}
async function projection(s){return (await db.query('select dowon_schedule_projection($1,$2) p',[s.kind,s.customerId])).rows[0].p;}
async function storeRows(kind,customerId){
 const table=kind==='payment'?'payment_schedules':'repayment_schedules';
 const allocations=kind==='payment'?(await db.query('select payment_schedule_id,sum(amount) amount from dowon_active_recovery_allocations where customer_id=$1 group by payment_schedule_id',[customerId])).rows:[];
 const allocated=new Map(allocations.map(row=>[row.payment_schedule_id,Number(row.amount)]));
 return (await db.query(`select *,paid_date::text cash_date,${kind==='payment'?'due_date':'repayment_date'}::text due from ${table} where customer_id=$1 and deleted_at is null order by id`,[customerId])).rows.map(row=>({
  id:row.id,customerId:row.customer_id,rowVersion:Number(row.row_version),promiseState:row.promise_state,
  dueDate:row.due??'',paidDate:row.cash_date??'',paidAmount:Number(row.paid_amount),status:row.status,memo:row.memo??'',
  ...(kind==='payment'?{dueAmount:Number(row.expected_amount),scheduleType:row.schedule_type,paymentMethod:row.payment_method,sourceRecoveryId:row.source_recovery_id??'',sourceAdditionalContractId:row.source_additional_contract_id??''}:{amount:Number(row.repayment_amount),lenderName:row.lender_name,contactType:row.lender_contact_type??'',contactValue:row.lender_contact_value??'',account:row.account_info??''}),
  allocatedAmount:allocated.get(row.id)||0,rootScheduleId:row.root_schedule_id??row.id,rescheduledFromId:row.rescheduled_from_id??'',obligationAmount:Number(row.obligation_amount),dateChangeCount:Number(row.date_change_count)
 }));
}
function rpcClient({loseResponse=false}={}){
 const calls=[];let lost=false;
 const persistBatch=createRetryableSave(async(name,args)=>{
  calls.push({name,args});assert.equal(name,'dowon_save_schedule_batch_v3');
  let result;
  try{result=await db.query('select dowon_save_schedule_batch_v3($1,$2,$3::jsonb,$4::uuid[],$5,$6::jsonb) result',[args.p_kind,args.p_customer_id,JSON.stringify(args.p_rows),args.p_delete_ids,args.p_request_key,JSON.stringify(args.p_versions)]);}
  catch(error){return {data:null,error:{message:error.message,code:error.code}};}
  if(loseResponse&&!lost){lost=true;throw new Error('committed response lost');}
  return {data:result.rows[0].result,error:null};
 },()=>crypto.randomUUID());
 return {persistBatch,calls};
}
async function controller(s,options={}){
 const source=await storeRows(s.kind,s.customerId);
 const client=options.client??rpcClient(options);
 let refreshed=0;
 const saveBatch=realSaveBatch({payments:s.kind==='payment'?source:[],repayments:s.kind==='repayment'?source:[],persistBatch:client.persistBatch});
 const cancel=method(s.kind==='payment'?'cancelCompletedPayment':'cancelCompletedRepayment',{
  payments:s.kind==='payment'?source:[],repayments:s.kind==='repayment'?source:[],saveBatch,refresh:async()=>{refreshed++;}
 });
 return {cancel,source,client,refreshed:()=>refreshed};
}

for(const kind of ['payment','repayment']){
 for(const state of ['active','cancelled','rescheduled'])test(`${kind}: cancelling ${state} completed cash recalculates totals and retains the debt anchor and later plans`,async()=>{
  const target=await seed(kind,{state});
  const child=await seed(kind,{customerId:target.customerId,parent:target.id,paid:0,amount:300000});
  const other=await seed(kind,{customerId:target.customerId,paid:100000,amount:100000});
  const before=await snapshot(target),childBefore=await snapshot(child),otherBefore=await snapshot(other),totalsBefore=(await projection(target)).summary;
  const c=await controller(target);await c.cancel(target.id,Number(before.row_version));
  const after=await snapshot(target),totalsAfter=(await projection(target)).summary;
  assert.equal(Number(after.paid_amount),0);assert.equal(after.cash_date,null);assert.equal(after.status,'예정');assert.equal(after.promise_state,'cancelled');assert.equal(after.deleted_at,null);
  for(const field of ['due','expected_amount','repayment_amount','obligation_amount','root_schedule_id','rescheduled_from_id','date_change_count','memo'])assert.deepEqual(after[field],before[field],field);
  assert.deepEqual(await snapshot(child),childBefore);assert.deepEqual(await snapshot(other),otherBefore);
  assert.equal(totalsAfter.paid,totalsBefore.paid-200000);assert.equal(totalsAfter.remaining,totalsBefore.remaining+200000);
  assert.equal((await projection(target)).rows[child.id].remaining,300000);assert.equal(c.refreshed(),1);
  if(kind==='payment'){
   const statement=(await db.query('select amount::int amount,deleted_at from settlement_entries where source_payment_schedule_id=$1',[target.id])).rows[0];
   assert.equal(statement.amount,200000);assert.ok(statement.deleted_at);
   assert.equal((await db.query('select amount::int amount from settlement_entries where source_payment_schedule_id=$1 and deleted_at is null',[other.id])).rows[0].amount,100000);
  }
 });
 test(`${kind}: a standalone completed record cancellation restores owed balance without recreating a dated promise`,async()=>{
  const target=await seed(kind,{paid:500000});const before=await snapshot(target),c=await controller(target);
  await c.cancel(target.id,Number(before.row_version));const result=(await projection(target)).summary;
  assert.equal(result.paid,0);assert.equal(result.remaining,kind==='payment'?1000000:500000);assert.equal(result.planned,0);
  assert.equal(Number((await snapshot(target)).obligation_amount),500000);
 });
 test(`${kind}: receipt changed while confirmation is open is rejected with all cash and statements intact`,async()=>{
  const target=await seed(kind),before=await snapshot(target);
  await db.query(`update ${target.table} set paid_amount=250000,memo='new receipt correction' where id=$1`,[target.id]);
  const latest=await snapshot(target),c=await controller(target);
  await assert.rejects(c.cancel(target.id,Number(before.row_version)),/다른 화면/);
  assert.deepEqual(await snapshot(target),latest);assert.equal(c.refreshed(),0);
  assert.equal((await db.query('select count(*)::int count from dowon_private.save_requests where request_key=$1',[c.client.calls[0].args.p_request_key])).rows[0].count,0);
  if(kind==='payment')assert.equal((await db.query('select amount::int amount from settlement_entries where source_payment_schedule_id=$1 and deleted_at is null',[target.id])).rows[0].amount,250000);
 });
 test(`${kind}: another receipt changed after the save snapshot causes an atomic conflict without touching either record`,async()=>{
  const target=await seed(kind),other=await seed(kind,{customerId:target.customerId,paid:100000}),before=await snapshot(target),c=await controller(target);
  await db.query(`update ${other.table} set paid_amount=150000 where id=$1`,[other.id]);const otherLatest=await snapshot(other);
  await assert.rejects(c.cancel(target.id,Number(before.row_version)),/다른 화면/);
  assert.deepEqual(await snapshot(target),before);assert.deepEqual(await snapshot(other),otherLatest);assert.equal(c.refreshed(),0);
 });
 test(`${kind}: retry after committed but lost response reuses the request after a realtime refresh`,async()=>{
  const target=await seed(kind),before=await snapshot(target),c=await controller(target,{loseResponse:true});
  await assert.rejects(c.cancel(target.id,Number(before.row_version)),/response lost/);assert.equal(c.refreshed(),0);
  const committed=await snapshot(target),retry=await controller(target,{client:c.client});
  await retry.cancel(target.id,Number(before.row_version));
  assert.deepEqual(await snapshot(target),committed);assert.equal(retry.refreshed(),1);
  assert.equal(c.client.calls[0].args.p_request_key,c.client.calls[1].args.p_request_key);
  assert.equal((await db.query('select count(*)::int count from dowon_private.save_requests where request_key=$1',[c.client.calls[0].args.p_request_key])).rows[0].count,1);
 });
}

test('payment cash cancellation preserves legacy recovery allocation credit and every recovery source record',async()=>{
 const target=await seed('payment',{paid:200000});
 const recovery=(await db.query("insert into recoveries(customer_id,amount,recovery_date,lender_name,accounting_version) values($1,200000,'2026-10-20','가상 환수 업체',1) returning id",[target.customerId])).rows[0].id;
 await db.query('insert into recovery_fee_allocations(recovery_id,customer_id,payment_schedule_id,amount) values($1,$2,$3,50000)',[recovery,target.customerId,target.id]);
 const allocations=(await db.query('select * from recovery_fee_allocations where payment_schedule_id=$1',[target.id])).rows;
 const recoveryBefore=(await db.query('select * from recoveries where id=$1',[recovery])).rows;
 const summaryBefore=(await projection(target)).summary,before=await snapshot(target),c=await controller(target);
 await c.cancel(target.id,Number(before.row_version));
 const summaryAfter=(await projection(target)).summary;
 assert.equal(summaryBefore.allocated,50000);assert.equal(summaryAfter.allocated,50000);
 assert.equal(summaryAfter.paid,summaryBefore.paid-200000);assert.equal(summaryAfter.remaining,summaryBefore.remaining+200000);
 assert.deepEqual((await db.query('select * from recovery_fee_allocations where payment_schedule_id=$1',[target.id])).rows,allocations);
 assert.deepEqual((await db.query('select * from recoveries where id=$1',[recovery])).rows,recoveryBefore);
});

test('cash beside recovery credit can retry a lost committed response without cancelling the credit',async()=>{
 const target=await seed('payment'),before=await snapshot(target);
 const recovery=(await db.query("insert into recoveries(customer_id,amount,recovery_date,lender_name,accounting_version) values($1,200000,'2026-10-20','가상 환수 업체',1) returning id",[target.customerId])).rows[0].id;
 await db.query('insert into recovery_fee_allocations(recovery_id,customer_id,payment_schedule_id,amount) values($1,$2,$3,50000)',[recovery,target.customerId,target.id]);
 const c=await controller(target,{loseResponse:true});
 await assert.rejects(c.cancel(target.id,Number(before.row_version)),/response lost/);
 const committed=await snapshot(target),retry=await controller(target,{client:c.client});
 await retry.cancel(target.id,Number(before.row_version));
 assert.deepEqual(await snapshot(target),committed);assert.equal((await projection(target)).summary.allocated,50000);
 assert.equal(c.client.calls[0].args.p_request_key,c.client.calls[1].args.p_request_key);
 await assert.rejects(retry.cancel(target.id,Number(committed.row_version)),/환수금으로 충당/);
});

test('zero-cash completed error and closed repayment markers can be removed without inventing receipts',async()=>{
 for(const kind of ['payment','repayment']){
  const target=await seed(kind,{paid:0,paidDate:null}),before=await snapshot(target);
  if(kind==='repayment')await db.query("update repayment_schedules set status='종결' where id=$1",[target.id]);
  const current=await snapshot(target),c=await controller(target);await c.cancel(target.id,Number(current.row_version));
  const after=await snapshot(target),summary=(await projection(target)).summary;
  assert.equal(summary.paid,0);assert.equal(after.status,'예정');assert.equal(after.promise_state,'cancelled');assert.equal(Number(after.obligation_amount),Number(before.obligation_amount));
 }
});
