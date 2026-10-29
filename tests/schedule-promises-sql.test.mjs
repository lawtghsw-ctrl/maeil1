import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {db} from './helpers/schedule-promise-db.mjs';

await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/supabase/migrations/20261017134055_schedule_promises.sql','utf8'));
after(()=>db.close());
async function customer(amount=500000){return (await db.query('insert into customers(contract_amount) values($1) returning id',[amount])).rows[0].id;}
async function seed(kind,{customerId,amount=500000,paid=0,date='2026-10-16',paidDate=paid?'2026-10-16':null,parent=null}={}){
 customerId??=await customer(amount);
 const table=kind==='payment'?'payment_schedules':'repayment_schedules';
 const row=(await db.query(kind==='payment'?
  `insert into payment_schedules(customer_id,expected_amount,paid_amount,due_date,paid_date,status,rescheduled_from_id,root_schedule_id,schedule_type) values($1,$2,$3,$4,$5,'연체',$6,$6,case when $6::uuid is null then '일반' else '재약정' end) returning *`:
  `insert into repayment_schedules(customer_id,repayment_amount,paid_amount,repayment_date,paid_date,status,rescheduled_from_id,root_schedule_id,lender_name) values($1,$2,$3,$4,$5,'연체',$6,$6,'검증 업체') returning *`,[customerId,amount,paid,date,paidDate,parent])).rows[0];
 return {kind,table,id:row.id,customerId,amount,paid,date,paidDate};
}
function row(s,patch={}){return {id:s.id,[s.kind==='payment'?'dueAmount':'amount']:s.amount,paidAmount:s.paid,dueDate:s.date,paidDate:s.paidDate??'',status:'연체',lenderName:'검증 업체',paymentMethod:'계좌이체',memo:'검증',...patch};}
function plan(kind,amount,date='2026-10-20'){return {[kind==='payment'?'dueAmount':'amount']:amount,dueDate:date,memo:'새 약속'};}
async function projection(s){return (await db.query('select dowon_schedule_projection($1,$2) result',[s.kind,s.customerId])).rows[0].result;}
async function versions(s){return (await db.query(`select coalesce(jsonb_object_agg(id,row_version),'{}'::jsonb) v from ${s.table} where customer_id=$1 and deleted_at is null`,[s.customerId])).rows[0].v;}
async function save(s,rows,carries={},deleted=[],opts={}){
 const v=opts.versions??await versions(s);
 return db.query('select dowon_save_schedule_batch_v2($1,$2,$3::jsonb,$4::jsonb,$5::uuid[],$6,$7::jsonb)',[s.kind,s.customerId,JSON.stringify(rows),JSON.stringify(carries),deleted,opts.key??crypto.randomUUID(),JSON.stringify(v)]);
}
async function record(s){return (await db.query(`select * from ${s.table} where id=$1`,[s.id])).rows[0];}
async function children(s){return (await db.query(`select * from ${s.table} where rescheduled_from_id=$1 order by id`,[s.id])).rows;}
function amounts(p){const s=p.summary;return {paid:s.paid,remaining:s.remaining,planned:s.planned,unassigned:s.unassigned,undated:s.undated};}

for(const kind of ['payment','repayment']){
 test(`${kind}: 500k due, 200k paid on October 16, replan only 300k`,async()=>{
  const s=await seed(kind,{paid:200000});
  assert.deepEqual(amounts(await projection(s)),{paid:200000,remaining:300000,planned:300000,unassigned:0,undated:0});
  await save(s,[row(s)],{[s.id]:[plan(kind,300000)]});
  const original=await record(s),child=(await children(s))[0];
  assert.equal(original.promise_state,'rescheduled');assert.equal(original.deleted_at,null);
  assert.equal(Number(original.paid_amount),200000);assert.equal((await db.query(`select paid_date::text date from ${s.table} where id=$1`,[s.id])).rows[0].date,'2026-10-16');
  assert.equal(Number(child.paid_amount),0);assert.equal(child.paid_date,null);
  assert.deepEqual(amounts(await projection(s)),{paid:200000,remaining:300000,planned:300000,unassigned:0,undated:0});
  if(kind==='payment')assert.deepEqual((await db.query('select amount::int amount,payment_date::text date,deleted_at from settlement_entries where source_payment_schedule_id=$1',[s.id])).rows[0],{amount:200000,date:'2026-10-16',deleted_at:null});
 });
 test(`${kind}: partial payment without a new date does not force replan`,async()=>{
  const s=await seed(kind);
  await save(s,[row(s,{paidAmount:200000,paidDate:'2026-10-16'})]);
  assert.equal((await children(s)).length,0);assert.equal((await record(s)).status,'연체');
  assert.equal((await projection(s)).summary.remaining,300000);
 });
 test(`${kind}: partial allocation leaves explicit unassigned debt with no invented row`,async()=>{
  const s=await seed(kind,{paid:200000});
  await save(s,[row(s)],{[s.id]:[plan(kind,100000)]});
  assert.deepEqual(amounts(await projection(s)),{paid:200000,remaining:300000,planned:100000,unassigned:200000,undated:200000});
  assert.equal((await children(s)).length,1);
  await save(s,[row(s)],{[s.id]:[plan(kind,200000,'')]});
  assert.deepEqual(amounts(await projection(s)),{paid:200000,remaining:300000,planned:100000,unassigned:0,undated:200000});
  await assert.rejects(save(s,[row(s)],{[s.id]:[plan(kind,1)]}),/초과/);
 });
 test(`${kind}: above-balance replan rolls back all edits and retry receipt`,async()=>{
  const s=await seed(kind,{paid:200000}),key=crypto.randomUUID();
  await assert.rejects(save(s,[row(s,{memo:'rollback'})],{[s.id]:[plan(kind,300001)]},[],{key}),/초과/);
  assert.equal((await record(s)).memo,null);assert.equal((await children(s)).length,0);
  assert.equal((await db.query('select count(*)::int n from dowon_private.save_requests where request_key=$1',[key])).rows[0].n,0);
 });
 test(`${kind}: cancelling a paid promise keeps cash and makes only its balance unassigned`,async()=>{
  const s=await seed(kind,{paid:200000});
  await save(s,[],{},[s.id]);
  const old=await record(s);assert.equal(old.deleted_at,null);assert.equal(old.promise_state,'cancelled');assert.equal(Number(old.paid_amount),200000);
  assert.deepEqual(amounts(await projection(s)),{paid:200000,remaining:300000,planned:0,unassigned:300000,undated:300000});
  if(kind==='payment')assert.equal((await db.query('select amount::int amount from settlement_entries where source_payment_schedule_id=$1 and deleted_at is null',[s.id])).rows[0].amount,200000);
 });
 test(`${kind}: entering cash and cancelling a promise in the same save preserves both`,async()=>{
  const s=await seed(kind);
  await save(s,[row(s,{paidAmount:200000,paidDate:'2026-10-16',promiseState:'cancelled'})],{[s.id]:[]});
  const old=await record(s);assert.equal(old.promise_state,'cancelled');assert.equal(Number(old.paid_amount),200000);assert.equal(old.deleted_at,null);
  assert.deepEqual(amounts(await projection(s)),{paid:200000,remaining:300000,planned:0,unassigned:300000,undated:300000});
 });
 test(`${kind}: paid child can replan its remainder without counting cash twice`,async()=>{
  const s=await seed(kind,{paid:200000});await save(s,[row(s)],{[s.id]:[plan(kind,300000)]});
  const saved=(await children(s))[0],child={...s,id:saved.id,amount:300000,paid:100000,paidDate:'2026-10-20',date:'2026-10-20'};
  await save(s,[row(child)],{[child.id]:[plan(kind,200000,'2026-10-30')]});
  assert.deepEqual(amounts(await projection(s)),{paid:300000,remaining:200000,planned:200000,unassigned:0,undated:0});
  assert.equal((await projection(s)).rows[s.id].remaining,0);assert.equal((await projection(s)).rows[child.id].remaining,0);
 });
 test(`${kind}: late receipt against old promise consumes future promises once, overpayment stays separate`,async()=>{
  const s=await seed(kind,{paid:200000});await save(s,[row(s)],{[s.id]:[plan(kind,100000),plan(kind,200000,'2026-10-30')]});
  await save(s,[row(s,{paidAmount:350000})]);
  assert.deepEqual(amounts(await projection(s)),{paid:350000,remaining:150000,planned:150000,unassigned:0,undated:0});
  await save(s,[row(s,{paidAmount:600000})]);
  const p=await projection(s);assert.equal(p.summary.remaining,0);assert.equal(p.summary.planned,0);
  assert.equal(Object.values(p.pools)[0].excess,100000);assert.equal((await children(s)).length,2);
 });
 test(`${kind}: promise amount edits never alter debt`,async()=>{
  const s=await seed(kind,{paid:200000});
  await save(s,[row(s,{[kind==='payment'?'dueAmount':'amount']:250000})]);
  assert.equal((await projection(s)).summary.remaining,300000);
  assert.equal(Number((await record(s)).obligation_amount),500000);
 });
 test(`${kind}: stale snapshot rejects concurrent changes and successful retry remains idempotent`,async()=>{
  const s=await seed(kind),v=await versions(s),key=crypto.randomUUID(),rows=[row(s)],carries={[s.id]:[plan(kind,500000)]};
  await save(s,rows,carries,[],{key,versions:v});await save(s,rows,carries,[],{key,versions:v});
  assert.equal((await children(s)).length,1);
  await assert.rejects(save(s,[row(s,{paidAmount:1})],{},[],{versions:v}),/다른 화면/);
  await assert.rejects(save(s,[],{},[s.id],{versions:v}),/다른 화면/);
 });
 test(`${kind}: legacy positive cash without a date is preserved, never fabricated`,async()=>{
  const s=await seed(kind,{paid:200000,paidDate:null});await save(s,[row(s)],{[s.id]:[plan(kind,300000)]});
  assert.equal((await record(s)).paid_date,null);assert.equal(Number((await record(s)).paid_amount),200000);
 });
}

test('payment: contract 693k with an old 473k root can carry the full current 693k plan',async()=>{
 const customerId=await customer(693000),s=await seed('payment',{customerId,amount:473000});
 // This reproduces a legacy family without changing its historical amount.
 const child=await seed('payment',{customerId,amount:693000,parent:s.id});
 await db.exec('set session_replication_role=replica');
 await db.query('update payment_schedules set promise_state=null,obligation_amount=null where customer_id=$1',[customerId]);
 await db.exec('set session_replication_role=origin');
 assert.equal((await projection(s)).rows[child.id].remaining,693000);
 await save(s,[row(child)],{[child.id]:[plan('payment',693000)]});
 assert.equal((await projection(s)).summary.remaining,693000);
});
test('payment: one unified save consumes only selected current promises',async()=>{
 const customerId=await customer(1000000),a=await seed('payment',{customerId,amount:300000}),b=await seed('payment',{customerId,amount:200000}),untouched=await seed('payment',{customerId,amount:500000});
 await save(a,[row(a),row(b)],{[a.id]:[plan('payment',300000)],[b.id]:[plan('payment',200000)]});
 const p=await projection(a);assert.equal(p.summary.planned,1000000);assert.equal(p.rows[untouched.id].state,'active');assert.equal(p.rows[untouched.id].remaining,500000);
});
test('payment: cancelled roots share one unassigned pool, not one copy each',async()=>{
 const customerId=await customer(500000),a=await seed('payment',{customerId,amount:300000}),b=await seed('payment',{customerId,amount:200000});
 await save(a,[],{},[a.id,b.id]);
 await assert.rejects(save(a,[row(a),row(b)],{[a.id]:[plan('payment',400000)],[b.id]:[plan('payment',400000)]}),/초과/);
 assert.equal((await children(a)).length,0);assert.equal((await children(b)).length,0);
});
test('repayment: explicit root debt edit is separate from changing the promise',async()=>{
 const s=await seed('repayment');await save(s,[row(s,{amount:400000,obligationAmount:600000})]);
 assert.equal((await projection(s)).summary.obligation,600000);assert.equal((await projection(s)).summary.planned,400000);
});
test('payment: unchanged obligation metadata remains safe on repeat saves',async()=>{
 const s=await seed('payment',{paid:200000});
 await save(s,[row(s,{obligationAmount:500000})]);await save(s,[row(s,{obligationAmount:500000,memo:'again'})]);
 assert.equal((await projection(s)).summary.remaining,300000);
 await assert.rejects(save(s,[row(s,{obligationAmount:600000})]),/계약 관리/);
});
test('payment: old unversioned endpoints cannot overwrite newer cash',async()=>{
 const s=await seed('payment',{paid:200000});
 await assert.rejects(db.query('select dowon_split_rescheduled_payment($1,$2,$3)',[s.id,'2026-10-20',100000]),/새로고침/);
 await assert.rejects(db.query('select dowon_save_payment_batch($1,$2::jsonb,$3::jsonb,$4::uuid[])',[s.customerId,JSON.stringify([row(s,{paidAmount:0})]),'{}',[]]),/새로고침/);
 await assert.rejects(db.query('select dowon_save_schedule_batch_once($1,$2,$3::jsonb,$4::jsonb,$5::uuid[],$6)',['payment',s.customerId,JSON.stringify([row(s,{paidAmount:0})]),'{}',[],crypto.randomUUID()]),/새로고침/);
 assert.equal(Number((await record(s)).paid_amount),200000);assert.equal((await children(s)).length,0);
});
test('repayment: deleted ancestor exposes only obligation metadata and does not resurrect cash',async()=>{
 const s=await seed('repayment',{paid:100000});
 const c=await seed('repayment',{customerId:s.customerId,amount:300000,parent:s.id});
 await db.query('update repayment_schedules set deleted_at=now() where id=$1',[s.id]);
 const rows=(await db.query('select id,paid_amount,root_obligation_amount from dowon_repayment_promises where customer_id=$1',[s.customerId])).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].id,c.id);assert.equal(Number(rows[0].root_obligation_amount),500000);assert.equal(Number(rows[0].paid_amount),0);
 await save(c,[],{},[c.id]);
 assert.deepEqual(amounts(await projection(c)),{paid:0,remaining:500000,planned:0,unassigned:500000,undated:500000});
 await save(c,[row(c)],{[c.id]:[plan('repayment',500000)]});
 assert.equal((await projection(c)).summary.planned,500000);
});
test('repayment: another root cannot offset an increase beyond this root debt',async()=>{
 const customerId=await customer(),a=await seed('repayment',{customerId}),b=await seed('repayment',{customerId});
 await assert.rejects(save(a,[row(a,{amount:600000}),row(b,{amount:400000})]),/남은 채무/);
 assert.equal((await projection(a)).summary.planned,1000000);
});
test('payment: contract extras count as debt but advance payment is not subtracted twice',async()=>{
 const s=await seed('payment',{amount:500000,paid:100000});
 await db.query('insert into additional_contracts(customer_id,contract_amount,upfront_amount,is_renegotiation) values($1,200000,100000,true)',[s.customerId]);
 let p=await projection(s);assert.equal(p.summary.obligation,700000);assert.equal(p.summary.remaining,600000);
 await db.query('update customers set is_accident=true,accident_contract_amount=100000 where id=$1',[s.customerId]);
 p=await projection(s);assert.equal(p.summary.remaining,0);assert.equal(p.summary.planned,0);
});
test('payment: refunded cash and recovery rows do not pay the ordinary contract twice',async()=>{
 const s=await seed('payment',{paid:100000});
 await db.query("update payment_schedules set status='환불' where id=$1",[s.id]);
 let p=await projection(s);assert.equal(p.summary.paid,0);assert.equal(p.rows[s.id].state,'cancelled');
 const r=await seed('payment',{customerId:s.customerId,paid:300000,amount:300000});
 await db.query("update payment_schedules set schedule_type='환수' where id=$1",[r.id]);
 p=await projection(s);assert.equal(p.summary.paid,0);assert.equal(p.rows[r.id].state,'cancelled');
});
for(const legacy of [false,true])test(`payment: late receipt consumes its own family first (${legacy?'legacy frozen on edit':'new explicit budget'})`,async()=>{
 const customerId=await customer(500000),a=await seed('payment',{customerId,amount:300000}),b=await seed('payment',{customerId,amount:200000,date:'2026-11-20'});
 await save(a,[row(a)],{[a.id]:[plan('payment',300000,'2026-10-20')]});
 const child=(await children(a))[0];
 if(legacy){await db.exec('set session_replication_role=replica');await db.query('update payment_schedules set obligation_amount=null,promise_state=null where customer_id=$1',[customerId]);await db.exec('set session_replication_role=origin');}
 const originalVersion=(await record(a)).row_version;
 await save(a,[row(a,{paidAmount:100000,paidDate:'2026-10-17',expectedVersion:originalVersion})]);
 const p=await projection(a);assert.equal(p.rows[child.id].remaining,200000);assert.equal(p.rows[b.id].remaining,200000);
 assert.equal(p.summary.paid,100000);assert.equal(p.summary.remaining,400000);assert.equal(p.summary.planned,400000);
 assert.equal(Number((await record(a)).obligation_amount),300000);
});
test('payment: first legacy mutation freezes expanded 693k family, not historical 473k',async()=>{
 const customerId=await customer(693000),root=await seed('payment',{customerId,amount:473000}),child=await seed('payment',{customerId,amount:693000,parent:root.id});
 await db.exec('set session_replication_role=replica');await db.query('update payment_schedules set obligation_amount=null,promise_state=null where customer_id=$1',[customerId]);await db.exec('set session_replication_role=origin');
 await save(root,[row(root,{paidAmount:100000,paidDate:'2026-10-16'})]);
 const p=await projection(root);assert.equal(Number((await record(root)).obligation_amount),693000);assert.equal(p.rows[child.id].remaining,593000);
});
test('payment: allocated credit survives promise cancellation and is never fabricated as cash',async()=>{
 const s=await seed('payment',{paid:100000});
 const recovery=(await db.query('insert into recoveries(customer_id,amount) values($1,100000) returning id',[s.customerId])).rows[0].id;
 await db.query('insert into recovery_fee_allocations(recovery_id,customer_id,payment_schedule_id,amount) values($1,$2,$3,100000)',[recovery,s.customerId,s.id]);
 await save(s,[],{},[s.id]);
 const p=await projection(s);assert.equal(p.summary.paid,100000);assert.equal(p.summary.allocated,100000);assert.equal(p.summary.remaining,300000);
 assert.equal(p.summary.unassigned,300000);assert.equal(Number((await record(s)).paid_amount),100000);
 assert.equal((await db.query('select amount::int amount from recovery_fee_allocations where payment_schedule_id=$1',[s.id])).rows[0].amount,100000);
});
test('repayment: new rows created by another editor invalidate an otherwise unchanged snapshot',async()=>{
 const s=await seed('repayment'),v=await versions(s);await seed('repayment',{customerId:s.customerId,amount:100000});
 await assert.rejects(save(s,[row(s,{paidAmount:1})],{},[],{versions:v}),/다른 화면/);
 assert.equal(Number((await record(s)).paid_amount),0);
});
test('payment: a zero placeholder can later assign existing contract debt',async()=>{
 const customerId=await customer(1000000),s=await seed('payment',{customerId,amount:0});
 await save(s,[row(s,{dueAmount:100000})]);
 const p=await projection(s);assert.equal(p.summary.obligation,1000000);assert.equal(p.summary.remaining,1000000);
 assert.equal(p.rows[s.id].remaining,100000);assert.equal(p.summary.unassigned,900000);assert.equal(Number((await record(s)).obligation_amount),100000);
});
test('payment: increasing an existing promise uses only the unassigned pool',async()=>{
 const customerId=await customer(1000000),s=await seed('payment',{customerId,amount:500000});
 await save(s,[row(s,{dueAmount:700000})]);
 let p=await projection(s);assert.equal(p.summary.obligation,1000000);assert.equal(p.summary.planned,700000);assert.equal(p.summary.unassigned,300000);
 assert.equal(Number((await record(s)).obligation_amount),700000);
 await assert.rejects(save(s,[row(s,{dueAmount:1100000})]),/남은 채무/);
 p=await projection(s);assert.equal(p.summary.planned,700000);assert.equal(Number((await record(s)).obligation_amount),700000);
});
test('payment: promise increases in several families cannot reuse the same unassigned debt',async()=>{
 const customerId=await customer(1000000),a=await seed('payment',{customerId,amount:300000}),b=await seed('payment',{customerId,amount:300000});
 await assert.rejects(save(a,[row(a,{dueAmount:600000}),row(b,{dueAmount:600000})]),/남은 채무/);
 const p=await projection(a);assert.equal(p.summary.planned,600000);assert.equal(Number((await record(a)).obligation_amount),300000);assert.equal(Number((await record(b)).obligation_amount),300000);
});
for(const contract of [300000,500000])test(`payment: promise increase accounts for already received excess cash (${contract} contract)`,async()=>{
 const customerId=await customer(contract),s=await seed('payment',{customerId,amount:100000,paid:150000});
 await save(s,[row(s,{dueAmount:300000})]);
 const p=await projection(s);assert.equal(Number((await record(s)).obligation_amount),300000);
 assert.equal(p.summary.paid,150000);assert.equal(p.summary.remaining,contract-150000);assert.equal(p.summary.planned,150000);
 assert.equal(p.summary.unassigned,contract-300000);assert.equal(p.summary.overplanned,0);
});
test('payment: authenticated writes still run the settlement trigger after direct execute is revoked',async()=>{
 const s=await seed('payment',{paid:200000});
 assert.equal((await db.query("select has_function_privilege('authenticated','public.sync_payment_schedule_to_settlement()','EXECUTE') allowed")).rows[0].allowed,false);
 await db.exec('grant select,update on payment_schedules to authenticated; grant select on recovery_fee_allocations to authenticated');
 await db.exec('set role authenticated');
 try{await db.query('update payment_schedules set paid_amount=250000 where id=$1',[s.id]);}
 finally{await db.exec('reset role');}
 assert.equal((await db.query('select amount::int amount from settlement_entries where source_payment_schedule_id=$1 and deleted_at is null',[s.id])).rows[0].amount,250000);
});
test('payment: existing legacy overplanned rows still allow date-only corrections',async()=>{
 const customerId=await customer(500000),root=await seed('payment',{customerId,amount:500000}),child=await seed('payment',{customerId,amount:700000,parent:root.id});
 await db.exec('set session_replication_role=replica');await db.query('update payment_schedules set obligation_amount=null,promise_state=null where customer_id=$1',[customerId]);await db.exec('set session_replication_role=origin');
 const before=(await projection(root)).summary;
 await save(root,[row(child,{dueDate:'2026-10-25'})]);
 const after=(await projection(root)).summary;
 assert.equal(after.paid,before.paid);assert.equal(after.remaining,before.remaining);assert.equal(after.planned,before.planned);assert.equal(after.overplanned,200000);
 assert.equal((await db.query('select due_date::text date from payment_schedules where id=$1',[child.id])).rows[0].date,'2026-10-25');
});
for(const schedulePaid of [0,200000])test(`payment: promise-only edits preserve legacy settlement cash and known date (schedule paid ${schedulePaid})`,async()=>{
 const s=await seed('payment',{paid:schedulePaid,paidDate:null});
 const settlement=(await db.query("insert into settlement_entries(payment_date,client_name,amount,payment_method,memo,customer_id,source_payment_schedule_id,entry_source,entry_type) values('2026-10-16','검증 고객',200000,'계좌이체','기존 입금 이력',$1,$2,'payment','계약') returning id",[s.customerId,s.id])).rows[0];
 // Reproduce a legacy NULL budget so its first schedule edit also performs the
 // internal metadata update that used to damage a known settlement date.
 await db.exec('set session_replication_role=replica');await db.query('update payment_schedules set obligation_amount=null,promise_state=null where id=$1',[s.id]);await db.exec('set session_replication_role=origin');
 const receipt=async()=>(await db.query('select amount::int amount,payment_date::text date,deleted_at,memo from settlement_entries where id=$1',[settlement.id])).rows[0];
 const before=await receipt();
 await save(s,[row(s,{dueDate:'2026-10-25',status:'예정'})]);assert.deepEqual(await receipt(),before);
 await save(s,[row(s,{dueDate:'2026-10-25'})],{[s.id]:[plan('payment',500000-schedulePaid)]});assert.deepEqual(await receipt(),before);
 await save(s,[],{},[s.id]);assert.deepEqual(await receipt(),before);
});
