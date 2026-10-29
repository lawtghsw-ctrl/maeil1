import test, {after} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {PGlite} from "@electric-sql/pglite";

const schema=JSON.parse(fs.readFileSync(new URL("./fixtures/ropower-schema-before.json",import.meta.url),"utf8"));
const patch=fs.readFileSync(new URL("../supabase/ropower-web-feature-patch.sql",import.meta.url),"utf8");
const q=x=>'"'+x.replaceAll('"','""')+'"';
const id=(schemaName,name)=>q(schemaName)+"."+q(name);
const admin="00000000-0000-4000-8000-000000000001";
const staff="00000000-0000-4000-8000-000000000002";
const customer="00000000-0000-4000-8000-000000000010";
const payment="00000000-0000-4000-8000-000000000020";
const recovery="00000000-0000-4000-8000-000000000030";
const repayment="00000000-0000-4000-8000-000000000040";
const miscellaneous="00000000-0000-4000-8000-000000000060";
const db=new PGlite();
after(()=>db.close());
const cancellationModule={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../lib/settlement-cancellation.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:cancellationModule,exports:cancellationModule.exports});
const date=x=>x instanceof Date?x.toISOString().slice(0,10):x?String(x).slice(0,10):"";
async function asUser(actor,fn){await db.query("select set_config('test.uid',$1,false)",[actor]);await db.exec("set role authenticated");try{return await fn();}finally{await db.exec("reset role");}}
async function projection(){return (await db.query("select dowon_schedule_projection('payment',$1) value",[customer])).rows[0].value;}
async function row(table,rowId){return (await db.query("select to_jsonb(t) value from "+table+" t where id=$1",[rowId])).rows[0]?.value;}
async function frontendCancellation(rowId,{refund=false}={}){
 const payments=(await db.query("select * from payment_schedules where deleted_at is null")).rows.map(p=>({id:p.id,customerId:p.customer_id,rowVersion:Number(p.row_version),paidAmount:Number(p.paid_amount),paidDate:date(p.paid_date),dueAmount:Number(p.expected_amount),dueDate:date(p.due_date),status:p.status,promiseState:p.promise_state||undefined,scheduleType:p.schedule_type,sourceRecoveryId:p.source_recovery_id||undefined,sourceAdditionalContractId:p.source_additional_contract_id||undefined,memo:p.memo||"",paymentMethod:p.payment_method||"계좌이체"}));
 const recoveries=(await db.query("select * from recoveries where deleted_at is null")).rows.map(r=>({id:r.id,customerId:r.customer_id,rowVersion:Number(r.row_version),accountingVersion:r.accounting_version,recoveryDate:date(r.recovery_date),lenderName:r.lender_name||"",depositorName:r.depositor_name||"",amount:Number(r.amount),paymentMethod:r.payment_method||"계좌이체",memo:r.memo||"",installmentAmount:Number(r.installment_amount),clientReturnAmount:Number(r.client_return_amount),successFeeAmount:Number(r.success_fee_amount)}));
 const recoveryRefunds=(await db.query("select * from recovery_refunds where cancelled_at is null")).rows.map(r=>({id:r.id,recoveryId:r.recovery_id,customerId:r.customer_id,refundDate:date(r.refund_date),amount:Number(r.amount),recipientName:r.recipient_name,paymentMethod:r.payment_method||"계좌이체",memo:r.memo||"",settlementHidden:r.settlement_hidden}));
 const recoveryAllocations=(await db.query("select * from dowon_active_recovery_allocations")).rows.map(r=>({id:r.id,recoveryId:r.recovery_id,customerId:r.customer_id,paymentScheduleId:r.payment_schedule_id,amount:Number(r.amount)}));
 let s;if(refund){const r=recoveryRefunds.find(r=>r.id===rowId);const c=await row("customers",r.customerId);s={id:"refund:"+r.id,amount:-r.amount,paidDate:r.refundDate,clientName:c.name||"-",paymentMethod:r.paymentMethod,memo:`환수금 고객 반환 [수취인:${r.recipientName}]${r.memo?` · ${r.memo}`:""}`,entrySource:"refund",entryType:"반환",customerId:r.customerId};}else{const r=await row("settlement_entries",rowId);s={id:r.id,amount:Number(r.amount),paidDate:date(r.payment_date),clientName:r.client_name||"",paymentMethod:r.payment_method||"계좌이체",memo:r.memo||"",entrySource:r.entry_source||"manual",entryType:r.entry_type||"계약",customerId:r.customer_id||undefined,sourcePaymentScheduleId:r.source_payment_schedule_id||undefined,sourceRecoveryId:r.source_recovery_id||undefined,recoveryComponent:r.recovery_component||undefined};}
 return cancellationModule.exports.createSettlementCancellation(s,{customers:[],payments,recoveries,additionalContracts:[],recoveryRefunds,recoveryAllocations},crypto.randomUUID());
}
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
create function auth.role() returns text language sql stable as $$select current_user::text$$;
grant usage on schema auth,public to anon,authenticated,service_role;
grant execute on function auth.uid(),auth.role() to anon,authenticated,service_role;
set check_function_bodies=off;`);
const tables=[...new Set(schema.columns.map(c=>c.schema+"."+c.table_name))];
for(const table of tables){
 const cols=schema.columns.filter(c=>c.schema+"."+c.table_name===table);
 await db.exec("create table "+table+" ("+cols.map(c=>q(c.name)+" "+c.type+(c.default_expr?" default "+c.default_expr:"")+(c.not_null?" not null":"")).join(",")+");");
}
for(const c of [...schema.constraints].sort((a,b)=>(a.type==="f")-(b.type==="f"))){
 await db.exec("alter table "+id(c.schema,c.table_name)+" add constraint "+q(c.name)+" "+c.definition+";");
}
for(const i of schema.indexes){
 if(schema.constraints.some(c=>c.schema===i.schema&&c.table_name===i.table_name&&c.name===i.name))continue;
 await db.exec(i.definition+";");
}
for(const f of schema.functions)await db.exec(f.definition+";");
for(const g of schema.grants)await db.exec("grant "+g.privilege_type+" on "+id(g.schema,g.table_name)+" to "+q(g.grantee)+";");
for(const table of tables)await db.exec("alter table "+table+" enable row level security;");
for(const p of schema.policies)await db.exec("create policy "+q(p.name)+" on "+id(p.schema,p.table_name)+" for "+p.cmd+" to "+p.roles.slice(1,-1)+(p.qual?" using ("+p.qual+")":"")+(p.with_check?" with check ("+p.with_check+")":"")+";");
for(const tr of schema.triggers)await db.exec(tr.definition+";");
await db.exec(`set test.uid='${admin}';
insert into auth.users(id,email) values('${admin}','admin@example.test'),('${staff}','staff@example.test');
insert into profiles(id,name,role) values('${admin}','테스트 관리자','ADMIN'),('${staff}','테스트 직원','STAFF');
insert into customers(id,name,phone,contract_amount,upfront_amount,manager,sales_manager,coordination_manager)
 values('${customer}','검증용 가상 고객','01000000000',500000.50,0,'로파워 담당자','로파워 담당자','로파워 담당자');
insert into payment_schedules(id,customer_id,due_date,expected_amount,paid_date,paid_amount,status,memo)
 values('${payment}','${customer}','2026-10-01',500000.50,'2026-10-01',100000.50,'완료','과거 입금 원문');
insert into repayment_schedules(id,customer_id,lender_name,repayment_date,repayment_amount,status)
 values('${repayment}','${customer}','가상업체','2026-10-10',250000.25,'예정');
insert into recoveries(id,customer_id,recovery_date,lender_name,amount,legacy_imported,memo)
 values('${recovery}','${customer}','2026-10-02','가상 환수업체',200000,true,'이전 환수 원문');
insert into settlement_entries(id,payment_date,client_name,amount,memo,entry_source,entry_type)
 values('${miscellaneous}','2026-10-03','가상 기타 정산',123.45,'기타 정산 원문','manual','기타');
`);
const before=new Map();
for(const table of tables){const projection=schema.columns.filter(c=>c.schema+"."+c.table_name===table).map(c=>q(c.name)).join(",");before.set(table,(await db.query("select to_jsonb(q) row from (select "+projection+" from "+table+") q order by to_jsonb(q)::text")).rows);}
const policyBefore=(await db.query("select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname")).rows;
// A deliberate legacy-row mutation must abort the complete migration.
const guardAt=patch.lastIndexOf("DO $guard$");
assert.ok(guardAt>0);
await assert.rejects(db.exec(patch.slice(0,guardAt)+"UPDATE public.customers SET memo='deliberate regression';\n"+patch.slice(guardAt)),/Existing data changed/);
await db.exec("ROLLBACK");
await db.exec(patch);

test("patch keeps every original field, decimal amount, row and target RBAC policy",async()=>{
 for(const table of tables){const projection=schema.columns.filter(c=>c.schema+"."+c.table_name===table).map(c=>q(c.name)).join(",");assert.deepEqual((await db.query("select to_jsonb(q) row from (select "+projection+" from "+table+") q order by to_jsonb(q)::text")).rows,before.get(table),table);}
 const after=(await db.query("select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname")).rows;
 for(const policy of policyBefore)assert.deepEqual(after.find(p=>p.tablename===policy.tablename&&p.policyname===policy.policyname),policy);
 assert.equal((await db.query("select contract_amount::text amount from customers where id=$1",[customer])).rows[0].amount,"500000.50");
});

test("legacy recoveries remain version 1; no external-company or native tables or rows are installed",async()=>{
 assert.equal((await db.query("select accounting_version from recoveries where id=$1",[recovery])).rows[0].accounting_version,1);
 assert.equal((await db.query("select column_default from information_schema.columns where table_schema='public' and table_name='recoveries' and column_name='accounting_version'")).rows[0].column_default,"2");
 for(const name of ["external_leads","call_devices","call_requests","communication_requests","communication_preferences"])assert.equal((await db.query("select to_regclass($1)::text name",["public."+name])).rows[0].name,null);
 for(const name of ["recovery_fee_allocations","recovery_fee_splits","recovery_refunds","dowon_private.save_requests","dowon_private.recovery_bank_statement_exclusions"])assert.equal((await db.query("select count(*)::int n from "+name)).rows[0].n,0);
 const missing=(await db.query("select paid_amount,promise_state,row_version,date_change_count from repayment_schedules where id=$1",[repayment])).rows[0];
 assert.equal(missing.paid_amount,"0");assert.equal(missing.promise_state,null);assert.equal(missing.row_version,1);assert.equal(missing.date_change_count,0);
});

test("existing 기타 settlements are preserved and remain editable by the target administrator",async()=>{
 const original=await row("settlement_entries",miscellaneous);
 assert.equal(original.entry_type,"기타");assert.equal(original.memo,"기타 정산 원문");assert.equal(original.amount,123.45);
 const edited=await asUser(admin,()=>db.query("update settlement_entries set memo='명시적으로 수정한 기타 메모' where id=$1 returning entry_type,amount,memo",[miscellaneous]));
 assert.equal(edited.rows.length,1);assert.equal(edited.rows[0].entry_type,"기타");assert.equal(Number(edited.rows[0].amount),123.45);assert.equal(edited.rows[0].memo,"명시적으로 수정한 기타 메모");
});

test("reading legacy partial receipts derives decimal balances without modifying stored fields",async()=>{
 await db.query("select set_config('test.uid',$1,false)",[admin]);
 const original=await row("payment_schedules",payment),before=await row("recoveries",recovery);
 const summary=await asUser(admin,projection);
 assert.equal(summary.summary.obligation,500000.5);assert.equal(summary.summary.paid,100000.5);assert.equal(summary.summary.remaining,400000);
 assert.deepEqual(await row("payment_schedules",payment),original);assert.deepEqual(await row("recoveries",recovery),before);
});

test("multiple manual follow-up promises are allowed without the legacy parent uniqueness index",async()=>{
 const customerId=(await db.query("insert into customers(name,phone,contract_amount) values('추가 일정 검증','01000000002',1000) returning id")).rows[0].id;
 const parentId=(await db.query("insert into payment_schedules(customer_id,due_date,expected_amount,status) values($1,'2026-11-01',1000,'예정') returning id",[customerId])).rows[0].id;
 await db.query("insert into payment_schedules(customer_id,due_date,expected_amount,status,rescheduled_from_id,root_schedule_id) values($1,'2026-11-10',300,'예정',$2,$2),($1,'2026-11-20',700,'예정',$2,$2)",[customerId,parentId]);
 assert.equal((await db.query("select count(*)::int n from payment_schedules where rescheduled_from_id=$1",[parentId])).rows[0].n,2);
 assert.equal((await db.query("select to_regclass('public.payment_schedules_rescheduled_from_unique_idx')::text name")).rows[0].name,null);
});

test("explicit transactional save supports the target numeric schema and new repayment fields",async()=>{
 await db.exec("set role authenticated");
 try{
  await db.query("select dowon_save_schedule_batch_v3('repayment',$1,$2::jsonb,'{}'::uuid[],$3,'{}'::jsonb)",[
   customer,JSON.stringify([{lenderName:"새 가상업체",dueDate:"2026-11-01",amount:10000,paidAmount:0,contactType:"번호",contactValue:"01000000001",account:"",status:"예정",memo:"새로 저장한 검증 건"}]),"00000000-0000-4000-8000-000000000050"
  ]).catch(async error=>{
   // Version snapshot must contain every existing live row.
   assert.match(error.message,/다른 화면에서 일정이 변경/);
   const versions=(await db.query("select jsonb_object_agg(id,row_version) versions from repayment_schedules where customer_id=$1 and deleted_at is null",[customer])).rows[0].versions;
   await db.query("select dowon_save_schedule_batch_v3('repayment',$1,$2::jsonb,'{}'::uuid[],$3,$4::jsonb)",[customer,JSON.stringify([{lenderName:"새 가상업체",dueDate:"2026-11-01",amount:10000,paidAmount:0,contactType:"번호",contactValue:"01000000001",account:"",status:"예정",memo:"새로 저장한 검증 건"}]),"00000000-0000-4000-8000-000000000050",JSON.stringify(versions)]);
  });
 }finally{await db.exec("reset role");}
 assert.equal((await db.query("select count(*)::int n from repayment_schedules where customer_id=$1",[customer])).rows[0].n,2);
});

test("existing staff soft-delete restriction remains enforced",async()=>{
 await db.exec(`set test.uid='${staff}';set role authenticated`);
 try{await assert.rejects(db.query("update customers set deleted_at=now() where id=$1",[customer]),/삭제는 최종관리자만/);}finally{await db.exec("reset role");}
});

test("new recovery save is atomic on the target numeric schema and synchronizes gross cash and client returns",async()=>{
 const versions=(await db.query("select jsonb_object_agg(id,row_version) versions from recoveries where customer_id=$1 and deleted_at is null",[customer])).rows[0].versions;
 const key=crypto.randomUUID();const payload=JSON.stringify([{recoveryDate:"2026-11-02",lenderName:"검증용 환수업체",depositorName:"검증 예금주",amount:10000,paymentMethod:"계좌이체",memo:"새 환수",installmentAmount:1000,clientReturnAmount:2000}]);
 await asUser(admin,()=>db.query("select dowon_save_recovery_batch_v2($1,$2::jsonb,'{}'::uuid[],$3,$4::jsonb)",[customer,payload,key,JSON.stringify(versions)]));
 const r=(await db.query("select * from recoveries where lender_name='검증용 환수업체'")).rows[0];assert.equal(r.accounting_version,2);assert.equal(Number(r.success_fee_amount),5000);assert.equal(Number(r.installment_amount),1000);assert.equal(Number(r.client_return_amount),2000);
 const gross=(await db.query("select s.amount from settlement_entries s join payment_schedules p on p.id=s.source_payment_schedule_id where p.source_recovery_id=$1 and s.deleted_at is null",[r.id])).rows;assert.equal(gross.length,1);assert.equal(Number(gross[0].amount),10000);
 const returned=(await db.query("select amount from settlement_entries where source_recovery_id=$1 and recovery_component='client_return' and deleted_at is null",[r.id])).rows;assert.equal(returned.length,1);assert.equal(Number(returned[0].amount),-2000);
 const credit=(await asUser(admin,projection)).summary.allocated;assert.equal(credit,1000);
 await asUser(admin,()=>db.query("select dowon_save_recovery_batch_v2($1,$2::jsonb,'{}'::uuid[],$3,$4::jsonb)",[customer,payload,key,JSON.stringify(versions)]));
 assert.equal((await db.query("select count(*)::int n from recoveries where lender_name='검증용 환수업체'")).rows[0].n,1);
});

test("legacy split and refund remain separate from actual receipts; staff cannot cancel either refund or statement",async()=>{
 await db.query("select set_config('test.uid',$1,false)",[admin]);
 await db.query("insert into recovery_fee_splits(recovery_id,customer_id,success_fee,applied_fee,refund_due) values($1,$2,100000,10,99990)",[recovery,customer]);
 await db.query("insert into recovery_fee_allocations(recovery_id,customer_id,payment_schedule_id,amount) values($1,$2,$3,10)",[recovery,customer,payment]);
 const refund=(await db.query("insert into recovery_refunds(recovery_id,customer_id,refund_date,amount,recipient_name,memo,request_key) values($1,$2,'2026-11-03',20,'가상 수취인','기존 반환 원본',gen_random_uuid()) returning id",[recovery,customer])).rows[0].id;
 const sourceBefore=await row("recoveries",recovery),refundBefore=await row("recovery_refunds",refund);
 const before=await asUser(admin,projection);assert.equal(before.summary.paid,100000.5);assert.equal(before.summary.allocated,1010);
 const cancellation=await frontendCancellation(refund,{refund:true});assert.ok(cancellation.expected,cancellation.guidance);
 await asUser(staff,async()=>{
  await assert.rejects(db.query("select dowon_cancel_settlement($1,$2::jsonb,$3)",[refund,JSON.stringify(cancellation.expected),cancellation.requestKey]),/최종관리자만/);
  assert.equal((await db.query("update recovery_refunds set cancelled_at=now() where id=$1 returning id",[refund])).rows.length,0);
 });
 assert.deepEqual(await row("recovery_refunds",refund),refundBefore);
 await asUser(admin,()=>db.query("select dowon_cancel_settlement($1,$2::jsonb,$3)",[refund,JSON.stringify(cancellation.expected),cancellation.requestKey]));
 const cancelled=await row("recovery_refunds",refund);assert.ok(cancelled.cancelled_at);delete cancelled.cancelled_at;const original={...refundBefore};delete original.cancelled_at;assert.deepEqual(cancelled,original);
 assert.deepEqual(await row("recoveries",recovery),sourceBefore);assert.deepEqual(await asUser(admin,projection),before);
});

test("frontend statement snapshot cancels partial decimal cash atomically while preserving principal and recovery credit",async()=>{
 const sid=(await db.query("select id from settlement_entries where source_payment_schedule_id=$1",[payment])).rows[0].id;
 const snapshot=await frontendCancellation(sid);assert.ok(snapshot.expected,snapshot.guidance);
 await asUser(staff,()=>assert.rejects(db.query("select dowon_cancel_settlement($1,$2::jsonb,$3)",[sid,JSON.stringify(snapshot.expected),snapshot.requestKey]),/최종관리자만/));
 const before=await asUser(admin,projection),originalCustomer=await row("customers",customer),originalRecovery=await row("recoveries",recovery);
 await asUser(admin,()=>db.query("select dowon_cancel_settlement($1,$2::jsonb,$3)",[sid,JSON.stringify(snapshot.expected),snapshot.requestKey]));
 const p=await row("payment_schedules",payment);assert.equal(p.expected_amount,500000.5);assert.equal(p.paid_amount,0);assert.equal(p.paid_date,null);assert.equal(p.promise_state,"cancelled");
 const after=await asUser(admin,projection);assert.equal(before.summary.paid-after.summary.paid,100000.5);assert.equal(after.summary.allocated,before.summary.allocated);assert.equal(after.summary.remaining-before.summary.remaining,100000.5);
 assert.deepEqual(await row("customers",customer),originalCustomer);assert.deepEqual(await row("recoveries",recovery),originalRecovery);
 const paidBefore=await row("payment_schedules",payment);await asUser(admin,()=>db.query("select dowon_cancel_settlement($1,$2::jsonb,$3)",[sid,JSON.stringify(snapshot.expected),snapshot.requestKey]));assert.deepEqual(await row("payment_schedules",payment),paidBefore);
});

