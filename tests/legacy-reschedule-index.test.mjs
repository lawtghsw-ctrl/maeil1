import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('production single-child indexes reject 550000 split; migration allows 200000+350000 without duplicates',async()=>{
 const db=new PGlite();try{
 await db.exec(`create table payment_schedules(id uuid primary key default gen_random_uuid(),customer_id uuid,deleted_at timestamptz,schedule_type text default '일반',source_recovery_id uuid,source_additional_contract_id uuid,expected_amount numeric,paid_amount numeric default 0,due_date date,paid_date date,status text,payment_method text,memo text,root_schedule_id uuid,rescheduled_from_id uuid references payment_schedules,reschedule_sequence int);
 create unique index payment_schedules_rescheduled_from_unique_idx on payment_schedules(rescheduled_from_id) where rescheduled_from_id is not null and deleted_at is null;
 create unique index payment_schedules_one_active_child_idx on payment_schedules(rescheduled_from_id) where rescheduled_from_id is not null and deleted_at is null;`);
 const original=fs.readFileSync('tests/fixtures/dowon-reference/V37_11_32_EXISTING_LINKED_BALANCE_SAFE.sql','utf8');
 const start=original.indexOf('CREATE OR REPLACE FUNCTION public.dowon_save_payment_batch');
 assert.ok(start>=0);
 await db.exec(original.slice(start,original.indexOf('$;',start)+3));
 const customer=crypto.randomUUID();const parent=(await db.query("insert into payment_schedules(customer_id,expected_amount,paid_amount,due_date,status) values($1,550000,0,'2026-10-15','연체') returning id",[customer])).rows[0].id;
 const rows=[{id:parent,dueAmount:550000,paidAmount:0,dueDate:'2026-10-15',status:'연체'}];
 const carries={[parent]:[{dueDate:'2026-10-18',dueAmount:200000},{dueDate:'2026-10-20',dueAmount:350000}]};
 const save=()=>db.query('select dowon_save_payment_batch($1,$2::jsonb,$3::jsonb)',[customer,JSON.stringify(rows),JSON.stringify(carries)]);
 await assert.rejects(save(),/payment_schedules_rescheduled_from_unique_idx/);
 assert.equal((await db.query('select count(*)::int n from payment_schedules')).rows[0].n,1);
 await db.exec('drop index payment_schedules_rescheduled_from_unique_idx');
 await assert.rejects(save(),/payment_schedules_one_active_child_idx/);
 await db.exec('create unique index payment_schedules_rescheduled_from_unique_idx on payment_schedules(rescheduled_from_id) where rescheduled_from_id is not null and deleted_at is null');
 await db.exec(fs.readFileSync('tests/fixtures/dowon-reference/supabase/migrations/20261017070847_allow_payment_reschedule_splits.sql','utf8'));
 await save();
 assert.deepEqual((await db.query('select expected_amount::int amount,paid_amount::int paid from payment_schedules where rescheduled_from_id=$1 order by expected_amount',[parent])).rows,[{amount:200000,paid:0},{amount:350000,paid:0}]);
 await assert.rejects(save(),/이미 후속/);
 await db.query('select dowon_save_payment_batch($1,$2::jsonb)',[customer,JSON.stringify(rows)]);
 assert.equal((await db.query('select count(*)::int n from payment_schedules')).rows[0].n,3);
 }finally{await db.close();}
});
