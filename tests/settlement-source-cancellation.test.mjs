import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {db} from './helpers/schedule-renewal-db.mjs';

// Isolated, fabricated Postgres records only. This suite never uses a live DB.
await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/supabase/migrations/20261019115223_manual_schedule_recovery_renewal.sql','utf8'));
await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/supabase/migrations/20261023061744_recovery_bank_statement.sql','utf8'));
const legacySql=fs.readFileSync('tests/fixtures/dowon-reference/supabase/additional-contract-recovery-repayment-closed.sql','utf8');
await db.exec(legacySql.slice(legacySql.indexOf('create or replace function public.sync_additional_contract_payment'),legacySql.indexOf('-- 6)')));
const auditSql=fs.readFileSync('tests/fixtures/dowon-reference/supabase/change-history.sql','utf8');
await db.exec(auditSql.slice(0,auditSql.indexOf('create index')));
const migration='tests/fixtures/dowon-reference/supabase/migrations/20261023074550_settlement_source_cancellation.sql';
const helperModule={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/settlement-cancellation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:helperModule,exports:helperModule.exports});
async function row(table,id){return (await db.query(`select * from ${table} where id=$1`,[id])).rows[0];}
async function customer(){return (await db.query("insert into customers(name,contract_amount) values('가상 고객',2000000) returning id")).rows[0].id;}
async function payment({cid,amount=200000,status='완료',parent=null}={}){
 cid??=await customer();const p=(await db.query(`insert into payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,rescheduled_from_id,root_schedule_id)
 values($1,'2026-10-20',500000,case when $2::numeric>0 then date '2026-10-20' else null end,$2,$3,'계좌이체','가상 실제 입금',$4,$4) returning id`,[cid,amount,status,parent])).rows[0];
 return {cid,pid:p.id,sid:(await db.query('select id from settlement_entries where source_payment_schedule_id=$1',[p.id])).rows[0]?.id,kind:'payment'};
}
async function recovery({cid,legacy=false,returned=0}={}){
 cid??=await customer();const r=(await db.query(`insert into recoveries(customer_id,recovery_date,lender_name,depositor_name,amount,payment_method,memo,accounting_version,installment_amount,client_return_amount)
 values($1,'2026-10-20','가상 업체','가상 예금주',1000000,'계좌이체','가상 환수', $2,$3,$4) returning id`,[cid,legacy?1:2,legacy?0:200000,returned])).rows[0];
 const p=(await db.query('select id from payment_schedules where source_recovery_id=$1',[r.id])).rows[0];
 return {cid,rid:r.id,pid:p.id,sid:(await db.query('select id from settlement_entries where source_payment_schedule_id=$1',[p.id])).rows[0].id,kind:'recovery'};
}
async function additional(){
 const cid=await customer(),a=(await db.query(`insert into additional_contracts(customer_id,contract_date,contract_amount,upfront_amount,installment_period,lender_unit_price,lender_count,is_renegotiation,memo)
 values($1,'2026-10-20',600000,120000,12,300000,2,false,'추가 계약 원금 보존') returning id`,[cid])).rows[0];
 const p=(await db.query('select id from payment_schedules where source_additional_contract_id=$1',[a.id])).rows[0];
 return {cid,aid:a.id,pid:p.id,sid:(await db.query('select id from settlement_entries where source_payment_schedule_id=$1',[p.id])).rows[0].id,kind:'additional'};
}
async function manual(amount=-30000){return {sid:(await db.query("insert into settlement_entries(payment_date,client_name,amount,payment_method,memo,entry_source,entry_type) values('2026-10-20','가상 수기',$1,'계좌이체','독립 수기 거래','manual','계약') returning id",[amount])).rows[0].id,kind:'manual'};}
async function refund({parent,amount=245000,hidden=false}={}){
 parent??=await recovery({legacy:true});
 if(!(await db.query('select 1 from recovery_fee_splits where recovery_id=$1',[parent.rid])).rows.length){
  const credit=await payment({cid:parent.cid,amount:0,status:'예정'});
  await db.query('insert into recovery_fee_splits(recovery_id,customer_id,success_fee,applied_fee,refund_due) values($1,$2,500000,200000,300000)',[parent.rid,parent.cid]);
  await db.query('insert into recovery_fee_allocations(recovery_id,customer_id,payment_schedule_id,amount) values($1,$2,$3,200000)',[parent.rid,parent.cid,credit.pid]);
 }
 const r=(await db.query("insert into recovery_refunds(recovery_id,customer_id,refund_date,amount,recipient_name,payment_method,memo,request_key) values($1,$2,'2026-10-21',$3,'가상 반환 수취인','계좌이체','확인된 실제 반환',gen_random_uuid()) returning id",[parent.rid,parent.cid,amount])).rows[0];
 if(hidden)await db.query('update recovery_refunds set settlement_hidden=true where id=$1',[r.id]);
 return {...parent,sid:r.id,kind:'refund'};
}
const date=x=>x instanceof Date?x.toISOString().slice(0,10):x?String(x).slice(0,10):null,method=x=>x||'계좌이체';
async function expected(f){
 if(f.kind==='refund')return (await frontendSnapshot(f,crypto.randomUUID())).expected;
 const s=await row('settlement_entries',f.sid),p=s.source_payment_schedule_id?await row('payment_schedules',s.source_payment_schedule_id):null;
 const r=f.kind==='recovery'||f.kind==='recovery_return'?await row('recoveries',f.rid):null,a=f.kind==='additional'?await row('additional_contracts',f.aid):null;
 return {kind:f.kind,settlement:{id:s.id,amount:Number(s.amount),payment_date:date(s.payment_date),client_name:s.client_name||'',payment_method:method(s.payment_method),memo:s.memo||'',entry_source:s.entry_source||'manual',entry_type:s.entry_type||'계약',customer_id:s.customer_id||null,source_payment_schedule_id:s.source_payment_schedule_id||null,source_recovery_id:s.source_recovery_id||null,recovery_component:s.recovery_component||null},
  payment:p?{id:p.id,customer_id:p.customer_id,row_version:Number(p.row_version),paid_amount:Number(p.paid_amount),paid_date:date(p.paid_date),expected_amount:Number(p.expected_amount),due_date:date(p.due_date),status:p.status,promise_state:p.promise_state||null,schedule_type:p.schedule_type||'일반',source_recovery_id:p.source_recovery_id||null,source_additional_contract_id:p.source_additional_contract_id||null,memo:p.memo||'',payment_method:method(p.payment_method)}:null,
  source:r?{id:r.id,customer_id:r.customer_id,row_version:Number(r.row_version),accounting_version:r.accounting_version,recovery_date:date(r.recovery_date),lender_name:r.lender_name||'',depositor_name:r.depositor_name||'',amount:Number(r.amount),payment_method:method(r.payment_method),memo:r.memo||'',installment_amount:Number(r.installment_amount||0),client_return_amount:Number(r.client_return_amount||0),success_fee_amount:Number(r.success_fee_amount||0)}:a?{id:a.id,customer_id:a.customer_id,contract_date:date(a.contract_date),contract_amount:Number(a.contract_amount),upfront_amount:Number(a.upfront_amount||0),installment_period:Number(a.installment_period||0),lender_unit_price:Number(a.lender_unit_price||0),lender_count:Number(a.lender_count||0),is_renegotiation:!!a.is_renegotiation,memo:a.memo||''}:null};
}
async function cancel(f,{snapshot,key=crypto.randomUUID()}={}){return (await db.query('select dowon_cancel_settlement($1,$2::jsonb,$3) result',[f.sid,JSON.stringify(snapshot??await expected(f)),key])).rows[0].result;}
async function frontendSnapshot(f,key){
 const refund=f.kind==='refund'?await row('recovery_refunds',f.sid):null;
 const client=refund?await row('customers',refund.customer_id):null;
 const s=refund?{id:'refund:'+refund.id,amount:-Number(refund.amount),payment_date:refund.refund_date,client_name:client?.name||'-',payment_method:method(refund.payment_method),memo:`환수금 고객 반환 [수취인:${refund.recipient_name}]${refund.memo?` · ${refund.memo}`:''}`,entry_source:'refund',entry_type:'반환',customer_id:refund.customer_id}:await row('settlement_entries',f.sid);
 const payments=(await db.query('select * from payment_schedules where deleted_at is null')).rows.map(p=>({id:p.id,customerId:p.customer_id,rowVersion:Number(p.row_version),paidAmount:Number(p.paid_amount),paidDate:date(p.paid_date)||'',dueAmount:Number(p.expected_amount),dueDate:date(p.due_date)||'',status:p.status,promiseState:p.promise_state||undefined,scheduleType:p.schedule_type||'일반',sourceRecoveryId:p.source_recovery_id||undefined,sourceAdditionalContractId:p.source_additional_contract_id||undefined,memo:p.memo||'',paymentMethod:method(p.payment_method)}));
 const recoveries=(await db.query('select * from recoveries where deleted_at is null')).rows.map(r=>({id:r.id,customerId:r.customer_id,rowVersion:Number(r.row_version),accountingVersion:r.accounting_version,recoveryDate:date(r.recovery_date)||'',lenderName:r.lender_name||'',depositorName:r.depositor_name||'',amount:Number(r.amount),paymentMethod:method(r.payment_method),memo:r.memo||'',installmentAmount:Number(r.installment_amount||0),clientReturnAmount:Number(r.client_return_amount||0),successFeeAmount:Number(r.success_fee_amount||0)}));
 const additionalContracts=(await db.query('select * from additional_contracts where deleted_at is null')).rows.map(a=>({id:a.id,customerId:a.customer_id,contractDate:date(a.contract_date)||'',contractAmount:Number(a.contract_amount),prepaidAmount:Number(a.upfront_amount||0),installmentMonths:Number(a.installment_period||0),lenderUnitPrice:Number(a.lender_unit_price||0),lenderCount:Number(a.lender_count||0),isRenegotiation:!!a.is_renegotiation,memo:a.memo||''}));
 const recoveryRefunds=(await db.query('select * from recovery_refunds where cancelled_at is null')).rows.map(r=>({id:r.id,recoveryId:r.recovery_id,customerId:r.customer_id,refundDate:date(r.refund_date)||'',amount:Number(r.amount),recipientName:r.recipient_name,paymentMethod:method(r.payment_method),memo:r.memo||'',settlementHidden:!!r.settlement_hidden}));
 return helperModule.exports.createSettlementCancellation({id:s.id,amount:Number(s.amount),paidDate:date(s.payment_date)||'',clientName:s.client_name||'',paymentMethod:method(s.payment_method),memo:s.memo||'',entrySource:s.entry_source||'manual',entryType:s.entry_type||'계약',customerId:s.customer_id||undefined,sourcePaymentScheduleId:s.source_payment_schedule_id||undefined,sourceRecoveryId:s.source_recovery_id||undefined,recoveryComponent:s.recovery_component||undefined},
  {customers:[],payments,recoveries,additionalContracts,recoveryRefunds,recoveryAllocations:[]},key);
}
async function state(){
 const result={};for(const t of ['customers','payment_schedules','repayment_schedules','additional_contracts','recoveries','recovery_fee_splits','recovery_fee_allocations','recovery_refunds','settlement_entries'])result[t]=(await db.query(`select to_jsonb(t) row from ${t} t order by coalesce(to_jsonb(t)->>'id',to_jsonb(t)->>'recovery_id')`)).rows;
 result.requests=(await db.query('select to_jsonb(t) row from dowon_private.save_requests t order by actor_id,request_key')).rows;return result;
}
async function projection(cid){return (await db.query("select dowon_schedule_projection('payment',$1) p",[cid])).rows[0].p;}
const oldHidden=await payment();await db.query('select dowon_delete_settlement($1)',[oldHidden.sid]);
const oldHiddenRefund=await refund({hidden:true});
const oldHiddenSnapshot=await state();
for(const record of oldHiddenSnapshot.recovery_refunds)record.row.cancelled_at=null;
await db.exec(fs.readFileSync(migration,'utf8'));
after(()=>db.close());

test('installing source cancellation rewrites no historical hidden source or financial fact',async()=>{assert.deepEqual(await state(),oldHiddenSnapshot);assert.equal(Number((await row('payment_schedules',oldHidden.pid)).paid_amount),200000);});

test('ordinary cancellation clears cash and its promise while preserving principal, children and separate genuine receipts',async()=>{
 const f=await payment(),genuine=await payment({cid:f.cid,amount:30000}),child=await payment({cid:f.cid,amount:0,status:'예정',parent:f.pid});
 const childBefore=await row('payment_schedules',child.pid),genuineBefore=await row('payment_schedules',genuine.pid),customerBefore=await row('customers',f.cid),before=await projection(f.cid);
 const result=await cancel(f);assert.equal(result.kind,'payment');assert.equal(result.cancelled,true);
 const p=await row('payment_schedules',f.pid),s=await row('settlement_entries',f.sid);assert.equal(Number(p.paid_amount),0);assert.equal(p.paid_date,null);assert.equal(p.status,'예정');assert.equal(p.promise_state,'cancelled');assert.ok(s.deleted_at);assert.equal(s.user_deleted,false);
 assert.deepEqual(await row('payment_schedules',child.pid),childBefore);assert.deepEqual(await row('payment_schedules',genuine.pid),genuineBefore);assert.deepEqual(await row('customers',f.cid),customerBefore);
 const after=await projection(f.cid);assert.equal(before.summary.paid-after.summary.paid,200000);assert.equal(after.summary.remaining-before.summary.remaining,200000);
});

test('cancelling partial cash preserves existing recovery credit rather than cancelling the recovery allocation',async()=>{
 const f=await payment({status:'예정'}),r=await recovery({cid:f.cid,legacy:true});
 await db.query('insert into recovery_fee_splits(recovery_id,customer_id,success_fee,applied_fee,refund_due) values($1,$2,500000,100000,400000)',[r.rid,f.cid]);
 await db.query('insert into recovery_fee_allocations(recovery_id,customer_id,payment_schedule_id,amount) values($1,$2,$3,100000)',[r.rid,f.cid,f.pid]);
 const before=await projection(f.cid),recoveryBefore=await row('recoveries',r.rid);await cancel(f);const after=await projection(f.cid);
 assert.equal(after.summary.allocated,before.summary.allocated);assert.equal(before.summary.paid-after.summary.paid,200000);assert.deepEqual(await row('recoveries',r.rid),recoveryBefore);
});

test('a real re-receipt restores its automatic bank line, and an old UUID retry cannot cancel the new cash',async()=>{
 const f=await payment(),snapshot=await expected(f),key=crypto.randomUUID();await cancel(f,{snapshot,key});
 await db.query("update payment_schedules set paid_amount=70000,paid_date='2026-10-23',status='완료' where id=$1",[f.pid]);
 const before=await state();assert.equal((await row('settlement_entries',f.sid)).deleted_at,null);assert.equal((await row('settlement_entries',f.sid)).user_deleted,false);
 await cancel(f,{snapshot,key});assert.deepEqual(await state(),before);assert.equal(Number((await row('payment_schedules',f.pid)).paid_amount),70000);
});

test('an exact response-loss retry creates neither a second source update nor a save-request collision',async()=>{
 const f=await payment(),snapshot=await expected(f),key=crypto.randomUUID();await cancel(f,{snapshot,key});const before=await state();await cancel(f,{snapshot,key});assert.deepEqual(await state(),before);
 const receipts=(await db.query('select request_key from dowon_private.save_requests where request_key=any($1::uuid[])',[[key,(await db.query("select md5('dowon_cancel_settlement:v1:'||$1::text)::uuid id",[key])).rows[0].id]])).rows;assert.equal(receipts.length,2);
});

test('reusing a request UUID with a different snapshot fails before touching a source',async()=>{
 const f=await payment(),snapshot=await expected(f),key=crypto.randomUUID();await cancel(f,{snapshot,key});snapshot.settlement.amount++;const before=await state();await assert.rejects(cancel(f,{snapshot,key}),/동일 요청 키/);assert.deepEqual(await state(),before);
});

test('manual inflow and outflow cancellation touches only the independent manual transaction',async()=>{
 for(const amount of [45000,-30000]){const f=await manual(amount),before=await state();await cancel(f);const after=await state();assert.ok((await row('settlement_entries',f.sid)).deleted_at);assert.equal((await row('settlement_entries',f.sid)).user_deleted,false);for(const t of ['customers','payment_schedules','recoveries','additional_contracts','recovery_refunds'])assert.deepEqual(after[t],before[t]);}
});

test('a source-linked manual transaction is rejected rather than hidden',async()=>{
 const f=await payment();await db.query("update settlement_entries set entry_source='manual' where id=$1",[f.sid]);f.kind='manual';const before=await state();await assert.rejects(cancel(f),/원본이 연결된 수기/);assert.deepEqual(await state(),before);
});

test('additional upfront cancellation preserves every contract principal and revives normally when a new upfront receipt is recorded',async()=>{
 const f=await additional(),a=await row('additional_contracts',f.aid),customerBefore=await row('customers',f.cid),before=await projection(f.cid);await cancel(f);
 const updated=await row('additional_contracts',f.aid);assert.equal(Number(updated.upfront_amount),0);for(const key of Object.keys(a))if(key!=='upfront_amount')assert.deepEqual(updated[key],a[key]);
 assert.ok((await row('payment_schedules',f.pid)).deleted_at);assert.ok((await row('settlement_entries',f.sid)).deleted_at);assert.equal((await row('settlement_entries',f.sid)).user_deleted,false);assert.deepEqual(await row('customers',f.cid),customerBefore);assert.equal((await projection(f.cid)).summary.remaining-before.summary.remaining,120000);
 await db.query('update additional_contracts set upfront_amount=80000 where id=$1',[f.aid]);assert.equal((await row('settlement_entries',f.sid)).deleted_at,null);assert.equal(Number((await row('settlement_entries',f.sid)).amount),80000);
});

test('cancelling a gross recovery cancels that recovery and credit without changing a different real cash receipt',async()=>{
 const f=await recovery(),genuine=await payment({cid:f.cid,amount:30000}),genuineBefore=await row('payment_schedules',genuine.pid),before=await projection(f.cid);await cancel(f);
 assert.ok((await row('recoveries',f.rid)).deleted_at);assert.ok((await row('payment_schedules',f.pid)).deleted_at);assert.ok((await row('settlement_entries',f.sid)).deleted_at);assert.equal((await row('settlement_entries',f.sid)).user_deleted,false);assert.deepEqual(await row('payment_schedules',genuine.pid),genuineBefore);
 const after=await projection(f.cid);assert.equal(after.summary.paid,before.summary.paid);assert.equal(before.summary.allocated-after.summary.allocated,200000);
});

test('a plain legacy recovery can be cancelled but a legacy confirmed allocation must use dedicated management',async()=>{
 const plain=await recovery({legacy:true});await cancel(plain);assert.ok((await row('recoveries',plain.rid)).deleted_at);
 const f=await recovery({legacy:true});await db.query('insert into recovery_fee_splits(recovery_id,customer_id,success_fee,applied_fee,refund_due) values($1,$2,500000,0,500000)',[f.rid,f.cid]);const before=await state();await assert.rejects(cancel(f),/기존 배분이 확정된/);assert.deepEqual(await state(),before);
});

test('a legacy allocation without a split record also blocks gross cancellation instead of silently dropping credit',async()=>{
 const f=await recovery({legacy:true}),p=await payment({cid:f.cid,amount:0,status:'예정'});
 await db.query('insert into recovery_fee_allocations(recovery_id,customer_id,payment_schedule_id,amount) values($1,$2,$3,100000)',[f.rid,f.cid,p.pid]);const before=await state();
 await assert.rejects(cancel(f),/기존 배분이 확정된/);assert.deepEqual(await state(),before);
});

test('gross recovery cancellation refuses declared or separately recorded client returns',async()=>{
 const declared=await recovery({returned:100000});let before=await state();await assert.rejects(cancel(declared),/의뢰인 반환 내역/);assert.deepEqual(await state(),before);
 const f=await recovery({legacy:true});await db.query("insert into recovery_refunds(recovery_id,customer_id,refund_date,amount,recipient_name,request_key) values($1,$2,'2026-10-21',100000,'가상 수취인',gen_random_uuid())",[f.rid,f.cid]);before=await state();await assert.rejects(cancel(f),/의뢰인 반환 내역/);assert.deepEqual(await state(),before);
});

test('client-return cancellation preserves gross recovery, success fee, contract credit and separate legacy returns',async()=>{
 const f=await recovery({returned:150000});await db.query("insert into recovery_refunds(recovery_id,customer_id,refund_date,amount,recipient_name,request_key) values($1,$2,'2026-10-21',50000,'가상 별도 수취인',gen_random_uuid())",[f.rid,f.cid]);
 await db.query("update recoveries set memo='별도 반환 반영' where id=$1",[f.rid]);
 const ret={...f,kind:'recovery_return',sid:(await db.query("select id from settlement_entries where source_recovery_id=$1 and recovery_component='client_return'",[f.rid])).rows[0].id};
 const r=await row('recoveries',f.rid),grossBefore=await row('payment_schedules',f.pid),refunds=(await db.query('select * from recovery_refunds where recovery_id=$1',[f.rid])).rows;await cancel(ret);
 const after=await row('recoveries',f.rid);assert.equal(Number(after.client_return_amount),50000);assert.equal(Number(after.amount),Number(r.amount));assert.equal(Number(after.success_fee_amount),Number(r.success_fee_amount));assert.equal(Number(after.installment_amount),Number(r.installment_amount));assert.equal(after.deleted_at,null);assert.deepEqual((await db.query('select * from recovery_refunds where recovery_id=$1',[f.rid])).rows,refunds);assert.ok((await row('settlement_entries',ret.sid)).deleted_at);assert.equal((await row('settlement_entries',f.sid)).deleted_at,null);
 const grossAfter=await row('payment_schedules',f.pid);for(const key of ['paid_amount','paid_date','customer_id','source_recovery_id','deleted_at'])assert.deepEqual(grossAfter[key],grossBefore[key]);
 await db.query('update recoveries set client_return_amount=100000 where id=$1',[f.rid]);const restored=await row('settlement_entries',ret.sid);assert.equal(restored.deleted_at,null);assert.equal(restored.user_deleted,false);assert.equal(Number(restored.amount),-50000);
});

test('a v2 separate refund stays guarded so cancelling it cannot recreate a declared v2 return',async()=>{
 const f=await recovery({returned:100000}),refund=(await db.query("insert into recovery_refunds(recovery_id,customer_id,refund_date,amount,recipient_name,request_key) values($1,$2,'2026-10-21',50000,'가상 수취인',gen_random_uuid()) returning id",[f.rid,f.cid])).rows[0];
 const before=await state();await assert.rejects(db.query("select dowon_cancel_settlement($1,'{\"kind\":\"refund\"}'::jsonb,gen_random_uuid())",[refund.id]),/신형 환수의 별도 반환/);assert.deepEqual(await state(),before);
});

test('a stale payment row version, changed manual value and stale additional source all roll back atomically',async()=>{
 const p=await payment(),ps=await expected(p);await db.query("update payment_schedules set memo='다른 화면 수정' where id=$1",[p.pid]);let before=await state();await assert.rejects(cancel(p,{snapshot:ps}),/변경되었습니다/);assert.deepEqual(await state(),before);
 const m=await manual(),ms=await expected(m);await db.query('update settlement_entries set amount=amount-1 where id=$1',[m.sid]);before=await state();await assert.rejects(cancel(m,{snapshot:ms}),/변경되었습니다/);assert.deepEqual(await state(),before);
 const a=await additional(),as=await expected(a);await db.query("update additional_contracts set memo='새 조건' where id=$1",[a.aid]);before=await state();await assert.rejects(cancel(a,{snapshot:as}),/변경되었습니다/);assert.deepEqual(await state(),before);
});

test('a missing automatic bank-line update aborts source and nested request receipt together',async()=>{
 const f=await payment();await db.exec(`create function fixture_keep_bank_line() returns trigger language plpgsql as $$ begin if old.id='${f.sid}'::uuid and new.deleted_at is not null then return old;end if;return new;end;$$;
 create trigger zzz_fixture_keep_bank_line before update on settlement_entries for each row execute function fixture_keep_bank_line();`);
 const before=await state();try{await assert.rejects(cancel(f),/원본 거래 취소가 정산표에 반영되지/);assert.deepEqual(await state(),before);}finally{await db.exec('drop trigger zzz_fixture_keep_bank_line on settlement_entries;drop function fixture_keep_bank_line()');}
});

test('old hidden bank lines cannot trigger a retrospective source cancellation',async()=>{const before=await state();await assert.rejects(cancel(oldHidden),/이미 삭제되었거나 변경된/);assert.deepEqual(await state(),before);assert.equal(Number((await row('payment_schedules',oldHidden.pid)).paid_amount),200000);});

test('old one-argument hide-only callers must refresh instead of acquiring destructive semantics',async()=>{const f=await payment(),before=await state();await assert.rejects(db.query('select dowon_delete_settlement($1)',[f.sid]),/새로고침 후 정산표/);assert.deepEqual(await state(),before);});

test('anonymous and unauthenticated requests cannot cancel sources; the new RPC stays invoker-only',async()=>{
 assert.deepEqual((await db.query("select has_function_privilege('anon','dowon_cancel_settlement(uuid,jsonb,uuid)','EXECUTE') anon,has_function_privilege('authenticated','dowon_cancel_settlement(uuid,jsonb,uuid)','EXECUTE') authenticated,(select prosecdef from pg_proc where oid='dowon_cancel_settlement(uuid,jsonb,uuid)'::regprocedure) definer")).rows[0],{anon:false,authenticated:true,definer:false});
 const f=await payment(),snapshot=await expected(f),before=await state();await db.exec("set test.uid=''");try{await assert.rejects(cancel(f,{snapshot}),/로그인이 필요/);}finally{await db.exec("set test.uid='00000000-0000-4000-8000-000000000001'");}assert.deepEqual(await state(),before);
 await db.exec('set role anon');try{await assert.rejects(cancel(f,{snapshot}),/permission denied/);}finally{await db.exec('reset role');}
});

test('the authenticated browser role can use existing source permissions without new refund delete access',async()=>{
 const f=await payment(),snapshot=await expected(f);await db.exec('grant select,insert,update on customers,payment_schedules,repayment_schedules,recoveries,recovery_fee_allocations,recovery_fee_splits,settlement_entries,additional_contracts to authenticated;set role authenticated');
 try{await cancel(f,{snapshot});}finally{await db.exec('reset role');}
 assert.equal(Number((await row('payment_schedules',f.pid)).paid_amount),0);assert.equal((await db.query("select has_table_privilege('authenticated','recovery_refunds','DELETE') allowed")).rows[0].allowed,false);
});

test('legacy refund cancellation removes only that outflow and increases the unreturned balance while preserving original cash, fees and credit',async()=>{
 const f=await refund(),other=await refund({parent:f,amount:25000}),snapshot=await expected(f),before=await state(),original=await row('recovery_refunds',f.sid);
 const remaining=async()=>(await db.query('select s.refund_due-coalesce((select sum(amount) from recovery_refunds where recovery_id=s.recovery_id and cancelled_at is null),0) amount from recovery_fee_splits s where recovery_id=$1',[f.rid])).rows[0].amount;
 const oldRemaining=Number(await remaining());await cancel(f,{snapshot});const after=await state(),cancelled=await row('recovery_refunds',f.sid);
 assert.ok(cancelled.cancelled_at);for(const key of Object.keys(original))if(key!=='cancelled_at')assert.deepEqual(cancelled[key],original[key]);assert.equal(Number(await remaining())-oldRemaining,245000);
 assert.deepEqual(after.recovery_refunds.find(x=>x.row.id===other.sid),before.recovery_refunds.find(x=>x.row.id===other.sid),'same-parent separate actual return remains unchanged');
 for(const table of ['customers','payment_schedules','repayment_schedules','additional_contracts','recoveries','recovery_fee_splits','recovery_fee_allocations','settlement_entries'])assert.deepEqual(after[table],before[table],table);
 const audits=(await db.query("select * from change_history where source='settlement_source_cancellation' and record_id=$1",[f.sid])).rows;assert.equal(audits.length,1);assert.equal(audits[0].actor_id,'00000000-0000-4000-8000-000000000001');assert.equal(audits[0].old_data.cancelled_at,null);assert.ok(audits[0].new_data.cancelled_at);
});

test('an actual frontend refund confirmation and response-loss retry use the parent version and retain one audit',async()=>{
 const f=await refund(),key=crypto.randomUUID(),captured=await frontendSnapshot(f,key);assert.ok(captured.expected,captured.guidance);assert.equal(captured.expected.kind,'refund');assert.equal(captured.expected.settlement.id,'refund:'+f.sid);
 await cancel(f,{snapshot:captured.expected,key});const before=await state();await cancel(f,{snapshot:captured.expected,key});assert.deepEqual(await state(),before);
 const audits=(await db.query("select dedupe_key from change_history where source='settlement_source_cancellation' and record_id=$1",[f.sid])).rows;assert.equal(audits.length,1);assert.ok(audits[0].dedupe_key.includes(key));
 await assert.rejects(cancel(f,{snapshot:captured.expected,key:crypto.randomUUID()}),/이미 취소·미표기/);assert.deepEqual(await state(),before);
});

test('historically hidden refund rows are not retroactively cancelled or made visible',async()=>{
 const original=await row('recovery_refunds',oldHiddenRefund.sid),before=await state();
 await assert.rejects(db.query("select dowon_cancel_settlement($1,'{\"kind\":\"refund\"}'::jsonb,gen_random_uuid())",[oldHiddenRefund.sid]),/이미 취소·미표기/);
 assert.deepEqual(await state(),before);assert.deepEqual(await row('recovery_refunds',oldHiddenRefund.sid),original);assert.equal(original.cancelled_at,null);assert.equal(original.settlement_hidden,true);
});

test('stale parent recovery versions reject refund cancellation without changing the refund or another financial fact',async()=>{
 const f=await refund(),snapshot=await expected(f);await db.query("update recoveries set memo='다른 화면에서 환수 수정' where id=$1",[f.rid]);const before=await state();
 await assert.rejects(cancel(f,{snapshot}),/환수 버전이 변경/);assert.deepEqual(await state(),before);assert.equal((await row('recovery_refunds',f.sid)).cancelled_at,null);
});

test('refund money, recipient, source link and cancellation marker are immutable, with no delete permission granted',async()=>{
 const f=await refund(),snapshot=await expected(f);await cancel(f,{snapshot});const before=await state();
 await assert.rejects(db.query('update recovery_refunds set amount=amount+1 where id=$1',[f.sid]),/반환 금액·날짜·수취인/);
 await assert.rejects(db.query('update recovery_refunds set cancelled_at=null where id=$1',[f.sid]),/복구할 수 없습니다/);
 await assert.rejects(db.query('delete from recovery_refunds where id=$1',[f.sid]),/반환 원본은 삭제/);assert.deepEqual(await state(),before);
 assert.deepEqual((await db.query("select has_column_privilege('authenticated','recovery_refunds','cancelled_at','UPDATE') cancel,has_column_privilege('authenticated','recovery_refunds','amount','UPDATE') money,has_table_privilege('authenticated','recovery_refunds','DELETE') remove")).rows[0],{cancel:true,money:false,remove:false});
 await assert.rejects(db.query("select dowon_record_recovery_refund($1,'2026-10-21',245000,'가상 반환 수취인','계좌이체','취소된 요청 재시도',$2)",[f.rid,(await row('recovery_refunds',f.sid)).request_key]),/새로고침/);assert.deepEqual(await state(),before);
});

test('cancelled legacy refunds are excluded when converting to v2 or recording a new declared return',async()=>{
 const f=await refund();await cancel(f);const r=await row('recoveries',f.rid);
 const versions=(await db.query('select jsonb_object_agg(id,row_version) v from recoveries where customer_id=$1 and deleted_at is null',[f.cid])).rows[0].v;
 const payload=[{id:r.id,recoveryDate:date(r.recovery_date),lenderName:r.lender_name,depositorName:r.depositor_name,amount:Number(r.amount),paymentMethod:r.payment_method,memo:r.memo,installmentAmount:200000,clientReturnAmount:0}];
 await db.query("select dowon_save_recovery_batch_v2($1,$2::jsonb,'{}'::uuid[],gen_random_uuid(),$3::jsonb)",[f.cid,JSON.stringify(payload),JSON.stringify(versions)]);
 assert.equal((await row('recoveries',f.rid)).accounting_version,2);assert.equal((await db.query("select count(*)::int n from settlement_entries where source_recovery_id=$1 and recovery_component='client_return' and deleted_at is null",[f.rid])).rows[0].n,0);
 await db.query('update recoveries set client_return_amount=100000 where id=$1',[f.rid]);
 assert.equal(Number((await db.query("select amount from settlement_entries where source_recovery_id=$1 and recovery_component='client_return' and deleted_at is null",[f.rid])).rows[0].amount),-100000);assert.ok((await row('recovery_refunds',f.sid)).cancelled_at);
});

test('the existing recovery archive guard ignores cancelled refunds while preserving their original records',async()=>{
 const f=await refund();await cancel(f);const original=await row('recovery_refunds',f.sid);
 const versions=(await db.query('select jsonb_object_agg(id,row_version) v from recoveries where customer_id=$1 and deleted_at is null',[f.cid])).rows[0].v;
 await db.query("select dowon_save_recovery_batch_v2($1,'[]'::jsonb,$2::uuid[],gen_random_uuid(),$3::jsonb)",[f.cid,[f.rid],JSON.stringify(versions)]);
 assert.ok((await row('recoveries',f.rid)).deleted_at);assert.deepEqual(await row('recovery_refunds',f.sid),original);
});

test('a side-effect on parent recovery during refund cancellation rolls back the marker, source changes, audit and request receipt',async()=>{
 const f=await refund(),snapshot=await expected(f);await db.exec(`create function fixture_change_refund_parent() returns trigger language plpgsql as $$ begin if new.id='${f.sid}'::uuid and new.cancelled_at is not null then update recoveries set memo='unexpected side effect' where id=new.recovery_id;end if;return new;end;$$;
 create trigger zzz_fixture_change_refund_parent after update on recovery_refunds for each row execute function fixture_change_refund_parent();`);
 const before=await state(),audits=(await db.query('select * from change_history order by id')).rows;
 try{await assert.rejects(cancel(f,{snapshot}),/반환 취소의 원본 보존/);assert.deepEqual(await state(),before);assert.deepEqual((await db.query('select * from change_history order by id')).rows,audits);}finally{await db.exec('drop trigger zzz_fixture_change_refund_parent on recovery_refunds;drop function fixture_change_refund_parent()');}
});

test('the authenticated role soft-cancels a legacy refund through the audit-only privilege boundary',async()=>{
 const f=await refund(),snapshot=await expected(f);await db.exec('set role authenticated');try{await cancel(f,{snapshot});}finally{await db.exec('reset role');}
 assert.ok((await row('recovery_refunds',f.sid)).cancelled_at);assert.equal((await db.query("select count(*)::int n from change_history where source='settlement_source_cancellation' and record_id=$1",[f.sid])).rows[0].n,1);
 assert.deepEqual((await db.query("select has_function_privilege('authenticated','dowon_audit_refund_cash_cancellation()','EXECUTE') call,has_table_privilege('authenticated','change_history','INSERT') insert_audit,has_table_privilege('authenticated','recovery_refunds','DELETE') delete_refund")).rows[0],{call:false,insert_audit:false,delete_refund:false});
});

test('an audit dedupe collision fails the refund cancellation atomically instead of suppressing its history',async()=>{
 const f=await refund(),snapshot=await expected(f),key=crypto.randomUUID();
 await db.query("insert into change_history(category,action,table_name,record_id,source,dedupe_key) values('가상 기존 감사','수정','recovery_refunds',$1,'fixture',$2)",[f.sid,'settlement_source_cancellation:00000000-0000-4000-8000-000000000001:refund:'+f.sid+':'+key]);
 const before=await state(),audits=(await db.query('select * from change_history order by id')).rows;await assert.rejects(cancel(f,{snapshot,key}),/duplicate key/);assert.deepEqual(await state(),before);assert.deepEqual((await db.query('select * from change_history order by id')).rows,audits);assert.equal((await row('recovery_refunds',f.sid)).cancelled_at,null);
});

test('a direct permitted legacy cancellation still records one actor audit with a generated request identifier',async()=>{
 const f=await refund();await db.exec("select set_config('dowon.settlement_cancel_request','',false);set role authenticated");
 try{await db.query('update recovery_refunds set cancelled_at=clock_timestamp() where id=$1',[f.sid]);}finally{await db.exec('reset role');}
 const audits=(await db.query("select * from change_history where source='settlement_source_cancellation' and record_id=$1",[f.sid])).rows;assert.equal(audits.length,1);assert.equal(audits[0].actor_id,'00000000-0000-4000-8000-000000000001');assert.match(audits[0].dedupe_key,new RegExp('^settlement_source_cancellation:[0-9a-f-]+:refund:'+f.sid+':[0-9a-f-]{36}$'));
});

test('the column permission cannot bypass the v2 separate-return guard',async()=>{
 const parent=await recovery({returned:100000}),f=(await db.query("insert into recovery_refunds(recovery_id,customer_id,refund_date,amount,recipient_name,request_key) values($1,$2,'2026-10-21',50000,'가상 수취인',gen_random_uuid()) returning id",[parent.rid,parent.cid])).rows[0];const before=await state();
 await assert.rejects(db.query('update recovery_refunds set cancelled_at=clock_timestamp() where id=$1',[f.id]),/신형 환수의 별도 반환/);assert.deepEqual(await state(),before);
});

for(const kind of ['manual','payment','additional','recovery','recovery_return'])test(`the actual frontend confirmation helper sends an accepted ${kind} RPC snapshot`,async()=>{
 let f;
 if(kind==='manual')f=await manual(25000);
 else if(kind==='payment')f=await payment();
 else if(kind==='additional')f=await additional();
 else if(kind==='recovery')f=await recovery();
 else {f=await recovery({returned:100000});f={...f,kind:'recovery_return',sid:(await db.query("select id from settlement_entries where source_recovery_id=$1 and recovery_component='client_return'",[f.rid])).rows[0].id};}
 const key=crypto.randomUUID(),captured=await frontendSnapshot(f,key);assert.ok(captured.expected,captured.guidance);assert.equal(captured.expected.kind,kind);
 assert.deepEqual(JSON.parse(JSON.stringify(captured.expected)),await expected(f));const result=await cancel(f,{snapshot:captured.expected,key});assert.equal(result.cancelled,true);assert.equal(result.kind,kind);
});
