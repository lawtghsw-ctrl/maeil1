import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {db} from './helpers/schedule-renewal-db.mjs';

// Fabricated records in a local Postgres engine; this suite never uses a live DB.
await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/supabase/migrations/20261019115223_manual_schedule_recovery_renewal.sql','utf8'));
const migration='tests/fixtures/dowon-reference/supabase/migrations/20261023061744_recovery_bank_statement.sql';
const sourceTables=['customers','payment_schedules','repayment_schedules','recoveries','recovery_fee_allocations','recovery_fee_splits','recovery_refunds','additional_contracts'];
async function sourceSnapshot(){
 const snapshot={};
 for(const table of sourceTables)snapshot[table]=(await db.query(`select to_jsonb(t) row from ${table} t order by coalesce(to_jsonb(t)->>'id',to_jsonb(t)->>'recovery_id')`)).rows;
 return snapshot;
}
async function customer(){return (await db.query('insert into customers(name,contract_amount) values($1,2000000) returning id',['가상 고객'])).rows[0].id;}
async function recovery({legacy=false,amount=1000000,installment=200000,returned=0,date='2026-10-19',customerId}={}){
 customerId??=await customer();
 const r=(await db.query(`insert into recoveries(customer_id,recovery_date,lender_name,depositor_name,amount,payment_method,memo,accounting_version,installment_amount,client_return_amount)
  values($1,$2,'가상 업체','가상 예금주',$3,'계좌이체','가상 원본',$4,$5,$6) returning *`,[customerId,date,amount,legacy?1:2,legacy?0:installment,legacy?0:returned])).rows[0];
 return {id:r.id,customerId};
}
async function payment(id){return (await db.query('select * from payment_schedules where source_recovery_id=$1',[id])).rows[0];}
async function gross(id,{live=true}={}){return (await db.query(`select s.id,s.amount::int amount,s.payment_date::text date,s.entry_type type,s.user_deleted,s.deleted_at,s.memo
 from settlement_entries s join payment_schedules p on p.id=s.source_payment_schedule_id where p.source_recovery_id=$1${live?' and s.deleted_at is null':''}`,[id])).rows;}
async function components(id,{live=true}={}){return (await db.query(`select id,recovery_component component,amount::int amount,user_deleted,deleted_at from settlement_entries where source_recovery_id=$1${live?' and deleted_at is null':''} order by recovery_component`,[id])).rows;}
async function convert(id){await db.query('update recoveries set accounting_version=2,installment_amount=200000 where id=$1',[id]);}

const legacyAbsent=await recovery({legacy:true});
const legacyAbsentPayment=await payment(legacyAbsent.id);
await db.query('delete from settlement_entries where source_payment_schedule_id=$1',[legacyAbsentPayment.id]);
const manual=(await db.query(`insert into settlement_entries(payment_date,client_name,amount,payment_method,memo,customer_id,entry_source,entry_type)
 values('2026-10-19','가상 고객',1000000,'계좌이체','수기로 정정한 원본', $1,'manual','환수') returning id`,[legacyAbsent.customerId])).rows[0].id;
const legacyLinked=await recovery({legacy:true});
const oldLegacyLine=(await gross(legacyLinked.id))[0];
const legacyZero=await recovery({legacy:true,amount:0,date:null});
const legacyUndated=await recovery({legacy:true,amount:350000,date:null});
const legacyExplicitHidden=await recovery({legacy:true});
const legacyExplicitHiddenLine=(await gross(legacyExplicitHidden.id))[0];
await db.query('select dowon_delete_settlement($1)',[legacyExplicitHiddenLine.id]);
const detailed=await recovery();
const converted=await recovery({legacy:true});
const convertedLine=(await gross(converted.id))[0];
await convert(converted.id);
assert.equal((await gross(converted.id)).length,0,'old v2 writer hid the existing gross line');
const grossHidden=await recovery({legacy:true});
const hiddenLine=(await gross(grossHidden.id))[0];
await convert(grossHidden.id);
await db.query('select dowon_delete_settlement($1)',[hiddenLine.id]);
const componentHidden=await recovery();
const hiddenComponent=(await components(componentHidden.id)).find(x=>x.component==='success_fee');
await db.query('select dowon_delete_settlement($1)',[hiddenComponent.id]);
const archived=await recovery();
await db.query('update recoveries set deleted_at=now() where id=$1',[archived.id]);
const zero=await recovery({amount:0,installment:0,date:null});
const actualReturn=await recovery({legacy:true});
const refund=(await db.query(`insert into recovery_refunds(recovery_id,customer_id,refund_date,amount,recipient_name,request_key)
 values($1,$2,'2026-10-23',20000,'가상 수취인',gen_random_uuid()) returning id`,[actualReturn.id,actualReturn.customerId])).rows[0].id;
const before=await sourceSnapshot();
const protectedBefore=(await db.query("select to_jsonb(s) row from settlement_entries s where entry_source='manual' or user_deleted order by id")).rows;
await db.exec(fs.readFileSync(migration,'utf8'));
after(()=>db.close());

test('bank migration preserves every source financial fact, manual correction and explicit deletion',async()=>{
 assert.deepEqual(await sourceSnapshot(),before);
 assert.deepEqual((await db.query("select to_jsonb(s) row from settlement_entries s where entry_source='manual' or user_deleted order by id")).rows,protectedBefore);
 assert.equal((await db.query('select memo from settlement_entries where id=$1',[manual])).rows[0].memo,'수기로 정정한 원본');
});

test('v2 backfill restores one gross bank receipt and archives its allocation inflows',async()=>{
 const lines=await gross(detailed.id);assert.equal(lines.length,1);assert.equal(lines[0].amount,1000000);assert.equal(lines[0].date,'2026-10-19');assert.equal(lines[0].type,'환수');
 assert.deepEqual(await components(detailed.id),[]);
 const history=await components(detailed.id,{live:false});assert.equal(history.length,2);assert.ok(history.every(x=>x.deleted_at));
 assert.equal((await db.query('select paid_amount::int amount from payment_schedules where source_recovery_id=$1',[detailed.id])).rows[0].amount,1000000);
});

test('automatically hidden converted gross is restored with its existing ID',async()=>{
 const lines=await gross(converted.id);assert.equal(lines.length,1);assert.equal(lines[0].id,convertedLine.id);assert.equal(lines[0].amount,1000000);
});

test('legacy linked bank receipts retain their original line, and missing legacy lines remain untouched',async()=>{
 assert.deepEqual(await gross(legacyLinked.id),[oldLegacyLine]);
 assert.deepEqual(await gross(legacyAbsent.id,{live:false}),[]);
 assert.equal((await db.query('select count(*)::int n from settlement_entries where id=$1 and deleted_at is null',[manual])).rows[0].n,1);
});

test('legacy automatic-line absence is preserved through later memo edits and v2 conversion',async()=>{
 const originalManual=(await db.query('select to_jsonb(s) row from settlement_entries s where id=$1',[manual])).rows;
 const exclusion=(await db.query('select recovery_id,reason from dowon_private.recovery_bank_statement_exclusions')).rows;
 assert.equal(exclusion.length,1);assert.equal(exclusion[0].recovery_id,legacyAbsent.id);
 await db.query("update recoveries set memo='나중 메모 수정' where id=$1",[legacyAbsent.id]);
 assert.deepEqual(await gross(legacyAbsent.id,{live:false}),[]);
 await db.query("update recoveries set accounting_version=2,amount=800000,installment_amount=200000,memo='새 상세 양식으로 전환' where id=$1",[legacyAbsent.id]);
 assert.deepEqual(await gross(legacyAbsent.id,{live:false}),[]);
 assert.equal(Number((await payment(legacyAbsent.id)).paid_amount),800000,'source cash can still be corrected');
 assert.deepEqual((await db.query('select to_jsonb(s) row from settlement_entries s where id=$1',[manual])).rows,originalManual);
 assert.deepEqual(await components(legacyAbsent.id),[]);
});

test('legacy explicit deletion is retained through its original hide flag instead of a new exclusion',async()=>{
 assert.equal((await db.query('select count(*)::int n from dowon_private.recovery_bank_statement_exclusions where recovery_id=$1',[legacyExplicitHidden.id])).rows[0].n,0);
 await db.query("update recoveries set memo='기존 삭제 유지' where id=$1",[legacyExplicitHidden.id]);
 assert.deepEqual(await gross(legacyExplicitHidden.id),[]);
 const kept=(await gross(legacyExplicitHidden.id,{live:false}))[0];assert.equal(kept.id,legacyExplicitHiddenLine.id);assert.equal(kept.user_deleted,true);
});

test('a newly created legacy-format recovery still gets its normal automatic bank line',async()=>{
 const r=await recovery({legacy:true});assert.equal((await gross(r.id)).length,1);
 assert.equal((await db.query('select count(*)::int n from dowon_private.recovery_bank_statement_exclusions where recovery_id=$1',[r.id])).rows[0].n,0);
 await db.query("update recoveries set memo='신규 원본 수정' where id=$1",[r.id]);assert.equal((await gross(r.id)).length,1);
});

test('a legacy zero draft is not excluded when its first positive dated bank receipt is recorded',async()=>{
 assert.deepEqual(await gross(legacyZero.id),[]);
 assert.equal((await db.query('select count(*)::int n from dowon_private.recovery_bank_statement_exclusions where recovery_id=$1',[legacyZero.id])).rows[0].n,0);
 await db.query("update recoveries set amount=250000,recovery_date='2026-10-23' where id=$1",[legacyZero.id]);
 const lines=await gross(legacyZero.id);assert.equal(lines.length,1);assert.equal(lines[0].amount,250000);assert.equal(lines[0].date,'2026-10-23');
});

test('a legacy undated draft is not excluded when its actual receipt date is supplied',async()=>{
 assert.deepEqual(await gross(legacyUndated.id),[]);
 assert.equal((await db.query('select count(*)::int n from dowon_private.recovery_bank_statement_exclusions where recovery_id=$1',[legacyUndated.id])).rows[0].n,0);
 await db.query("update recoveries set recovery_date='2026-10-23' where id=$1",[legacyUndated.id]);
 const lines=await gross(legacyUndated.id);assert.equal(lines.length,1);assert.equal(lines[0].amount,350000);assert.equal(lines[0].date,'2026-10-23');
});

test('explicit gross deletion is honored while deleting an old fee component does not hide the gross bank receipt',async()=>{
 assert.deepEqual(await gross(grossHidden.id),[]);
 const hidden=(await gross(grossHidden.id,{live:false}))[0];assert.equal(hidden.id,hiddenLine.id);assert.equal(hidden.user_deleted,true);assert.ok(hidden.deleted_at);
 assert.equal((await gross(componentHidden.id)).length,1);
 const fee=(await components(componentHidden.id,{live:false})).find(x=>x.id===hiddenComponent.id);assert.equal(fee.user_deleted,true);assert.ok(fee.deleted_at);
});

test('archived and zero recoveries never acquire live bank statement deposits',async()=>{
 assert.deepEqual(await gross(archived.id),[]);assert.deepEqual(await gross(zero.id),[]);
});

test('legacy actual returns retain their own bank date and amount',async()=>{
 assert.deepEqual((await db.query('select amount::int amount,refund_date::text date,recipient_name,settlement_hidden from recovery_refunds where id=$1',[refund])).rows[0],
  {amount:20000,date:'2026-10-23',recipient_name:'가상 수취인',settlement_hidden:false});
});

test('new and repeated recovery saves create one gross receipt without success-fee or installment deposits',async()=>{
 const r=await recovery({amount:1200000,installment:300000});
 const line=(await gross(r.id))[0];assert.equal(line.amount,1200000);assert.deepEqual(await components(r.id),[]);
 for(let i=0;i<2;i++)await db.query("update recoveries set memo='수정된 원본' where id=$1",[r.id]);
 assert.equal((await gross(r.id)).length,1);assert.equal((await gross(r.id))[0].id,line.id);
 assert.equal((await db.query('select count(*)::int n from payment_schedules where source_recovery_id=$1',[r.id])).rows[0].n,1);
 const projection=(await db.query("select dowon_schedule_projection('payment',$1) p",[r.customerId])).rows[0].p;
 assert.equal(projection.summary.paid,0);assert.equal(projection.summary.allocated,300000);assert.equal(projection.summary.remaining,1700000);
});

test('the real recovery batch RPC retries once without duplicate bank cash and rejects stale updates',async()=>{
 const cid=await customer(),key=crypto.randomUUID();
 const payload=JSON.stringify([{amount:1000000,recoveryDate:'2026-10-19',lenderName:'가상 업체',depositorName:'가상 예금주',paymentMethod:'계좌이체',memo:'가상 RPC',installmentAmount:200000,clientReturnAmount:0}]);
 const save=()=>db.query("select dowon_save_recovery_batch_v2($1,$2::jsonb,'{}'::uuid[],$3,'{}'::jsonb)",[cid,payload,key]);
 await save();await save();
 const records=(await db.query('select id,row_version from recoveries where customer_id=$1',[cid])).rows;assert.equal(records.length,1);
 const r=records[0],lines=await gross(r.id);assert.equal(lines.length,1);assert.equal(lines[0].amount,1000000);assert.deepEqual(await components(r.id),[]);
 await assert.rejects(db.query("select dowon_save_recovery_batch_v2($1,$2::jsonb,'{}'::uuid[],gen_random_uuid(),'{}'::jsonb)",[cid,payload]),/다른 화면/);
 assert.deepEqual(await gross(r.id),lines);
});

test('editing recovery cash changes the same gross statement amount and cash date once',async()=>{
 const r=await recovery(),line=(await gross(r.id))[0];
 await db.query("update recoveries set amount=800000,recovery_date='2026-10-22',installment_amount=100000 where id=$1",[r.id]);
 const lines=await gross(r.id);assert.equal(lines.length,1);assert.equal(lines[0].id,line.id);assert.equal(lines[0].amount,800000);assert.equal(lines[0].date,'2026-10-22');
 assert.deepEqual(await components(r.id),[]);assert.equal((await payment(r.id)).date_change_count,0);
});

test('a user-deleted gross never returns after recovery edits or archive/restore',async()=>{
 const r=await recovery(),line=(await gross(r.id))[0];await db.query('select dowon_delete_settlement($1)',[line.id]);
 await db.query("update recoveries set amount=1200000,recovery_date='2026-10-22' where id=$1",[r.id]);
 await db.query('update recoveries set deleted_at=now() where id=$1',[r.id]);
 await db.query('update recoveries set deleted_at=null where id=$1',[r.id]);
 assert.deepEqual(await gross(r.id),[]);const kept=(await gross(r.id,{live:false}))[0];assert.equal(kept.id,line.id);assert.equal(kept.user_deleted,true);assert.ok(kept.deleted_at);
});

test('archiving one recovery hides its gross without affecting another recovery or manual bank line',async()=>{
 const a=await recovery(),b=await recovery();const bLine=(await gross(b.id))[0];
 await db.query('update recoveries set deleted_at=now() where id=$1',[a.id]);
 assert.deepEqual(await gross(a.id),[]);assert.deepEqual(await gross(b.id),[bLine]);
 assert.equal((await db.query('select deleted_at from settlement_entries where id=$1',[manual])).rows[0].deleted_at,null);
});

test('ordinary payment receipts retain partial-cash sync and never count recovery allocation as fresh cash',async()=>{
 const cid=await customer();
 const p=(await db.query(`insert into payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo)
  values($1,'2026-10-19',500000,'2026-10-19',100000,'예정','계좌이체','가상 분납') returning id`,[cid])).rows[0];
 const line=(await db.query('select id from settlement_entries where source_payment_schedule_id=$1',[p.id])).rows[0];
 await db.query("update payment_schedules set due_date='2026-11-01' where id=$1",[p.id]);
 assert.equal((await db.query('select amount::int amount from settlement_entries where id=$1',[line.id])).rows[0].amount,100000);
 await db.query('update payment_schedules set paid_amount=150000 where id=$1',[p.id]);
 assert.equal((await db.query('select amount::int amount from settlement_entries where id=$1',[line.id])).rows[0].amount,150000);
 await db.query('select dowon_delete_settlement($1)',[line.id]);
 await db.query('update payment_schedules set paid_amount=200000 where id=$1',[p.id]);
 assert.ok((await db.query('select deleted_at from settlement_entries where id=$1',[line.id])).rows[0].deleted_at);
});

test('hard deleting a source cannot alter a source-linked statement that is explicitly manual',async()=>{
 const cid=await customer();
 const p=(await db.query(`insert into payment_schedules(customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo)
  values($1,'2026-10-19',200000,'2026-10-19',200000,'완료','계좌이체','가상 원본') returning id`,[cid])).rows[0];
 await db.query("update settlement_entries set entry_source='manual',memo='수기 관리 내역' where source_payment_schedule_id=$1",[p.id]);
 const original=(await db.query('select to_jsonb(s) row from settlement_entries s where source_payment_schedule_id=$1',[p.id])).rows;
 await db.query('delete from payment_schedules where id=$1',[p.id]);
 assert.deepEqual((await db.query('select to_jsonb(s) row from settlement_entries s where source_payment_schedule_id=$1',[p.id])).rows,original);
});

test('the migration is repeatable without changing source versions or protected manual rows',async()=>{
 const facts=await sourceSnapshot();
 const protectedRows=(await db.query("select to_jsonb(s) row from settlement_entries s where entry_source='manual' or user_deleted order by id")).rows;
 const count=(await db.query('select count(*)::int n from settlement_entries')).rows[0].n;
 await db.exec(fs.readFileSync(migration,'utf8'));
 assert.deepEqual(await sourceSnapshot(),facts);
 assert.deepEqual((await db.query("select to_jsonb(s) row from settlement_entries s where entry_source='manual' or user_deleted order by id")).rows,protectedRows);
 assert.equal((await db.query('select count(*)::int n from settlement_entries')).rows[0].n,count);
 assert.deepEqual(await gross(legacyAbsent.id,{live:false}),[],'repeating migration cannot restore an excluded recovery after v2 conversion');
});

test('source preservation guard aborts and rolls back an accidental financial rewrite',async()=>{
 const facts=await sourceSnapshot(),lines=(await db.query('select to_jsonb(s) row from settlement_entries s order by id')).rows;
 const sql=fs.readFileSync(migration,'utf8'),guard=sql.lastIndexOf('DO $$');
 await assert.rejects(db.exec(sql.slice(0,guard)+"UPDATE public.recoveries SET memo='unexpected source rewrite';\n"+sql.slice(guard)),/changed source facts/);
 await db.exec('rollback');
 assert.deepEqual(await sourceSnapshot(),facts);assert.deepEqual((await db.query('select to_jsonb(s) row from settlement_entries s order by id')).rows,lines);
});

test('manual protection guard aborts and rolls back an accidental manual statement rewrite',async()=>{
 const original=(await db.query('select to_jsonb(s) row from settlement_entries s where id=$1',[manual])).rows;
 const sql=fs.readFileSync(migration,'utf8'),guard=sql.lastIndexOf('DO $$');
 await assert.rejects(db.exec(sql.slice(0,guard)+"UPDATE public.settlement_entries SET memo='unexpected manual rewrite' WHERE entry_source='manual';\n"+sql.slice(guard)),/changed a manual or explicitly deleted/);
 await db.exec('rollback');
 assert.deepEqual((await db.query('select to_jsonb(s) row from settlement_entries s where id=$1',[manual])).rows,original);
});

test('internal trigger functions expose no new executable RPC to browser roles',async()=>{
 assert.deepEqual((await db.query("select has_function_privilege('authenticated','sync_recovery_payment()','EXECUTE') recovery,has_function_privilege('anon','sync_payment_schedule_to_settlement()','EXECUTE') payment")).rows[0],{recovery:false,payment:false});
});

test('the existing definer trigger can honor the private exclusion for an authenticated source edit',async()=>{
 // Fixture-only grants model existing public-table access; the private policy
 // table is deliberately absent from these grants and remains inaccessible.
 await db.exec('grant usage on schema public to authenticated;grant select on all tables in schema public to authenticated;grant update on payment_schedules to authenticated;set role authenticated');
 try{await db.query("update payment_schedules set memo='인증된 화면의 원본 메모 수정' where id=$1",[legacyAbsentPayment.id]);}
 finally{await db.exec('reset role');}
 assert.deepEqual(await gross(legacyAbsent.id,{live:false}),[]);
});

test('legacy source policy stays private and cannot be read or changed by browser roles',async()=>{
 assert.deepEqual((await db.query(`select
  has_table_privilege('authenticated','dowon_private.recovery_bank_statement_exclusions','SELECT') authenticated_read,
  has_table_privilege('authenticated','dowon_private.recovery_bank_statement_exclusions','INSERT') authenticated_write,
  has_table_privilege('anon','dowon_private.recovery_bank_statement_exclusions','SELECT') anonymous_read,
  (select relrowsecurity from pg_class where oid='dowon_private.recovery_bank_statement_exclusions'::regclass) rls`)).rows[0],
  {authenticated_read:false,authenticated_write:false,anonymous_read:false,rls:true});
 await db.exec('set role authenticated');
 try{await assert.rejects(db.query('select * from dowon_private.recovery_bank_statement_exclusions'),/permission denied/);}
 finally{await db.exec('reset role');}
});
