const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const vm=require('node:vm');
const loaded={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/supabase/retryable-save.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:loaded,exports:loaded.exports,Error});
const {createRetryableSave}=loaded.exports;
const plain=value=>JSON.parse(JSON.stringify(value));

for(const kind of ['payment','repayment']){
 test(kind+' uses direct v3 with original cash and versions and no carry argument',async()=>{
  let sent;const save=createRetryableSave(async(name,args)=>{sent={name,args};return {data:1,error:null}},()=> 'request');
  const args={p_customer_id:'customer',p_rows:[{id:'old',paidAmount:200000,paidDate:'2026-10-16',promiseState:'cancelled'}],p_carries:{},p_delete_ids:[],p_versions:{old:7}};
  await save(kind,args);
  assert.equal(sent.name,'dowon_save_schedule_batch_v3');assert.equal(sent.args.p_kind,kind);assert.equal(Object.hasOwn(sent.args,'p_carries'),false);assert.equal(sent.args.p_request_key,'request');
  assert.deepEqual(plain(sent.args.p_rows),args.p_rows);assert.deepEqual(plain(sent.args.p_versions),{old:7});assert.deepEqual(args.p_carries,{});
 });
 test(kind+' rejects obsolete carries before sending a request',async()=>{
  let calls=0;const save=createRetryableSave(async()=>{calls++;return {data:1,error:null}},()=> 'request');
  await assert.rejects(save(kind,{p_rows:[],p_carries:{old:[{dueDate:'2026-10-20',amount:100000}]}}),/직접 수정/);assert.equal(calls,0);
 });
}

test('recovery uses the v2 RPC without a kind parameter',async()=>{
 let sent;const save=createRetryableSave(async(name,args)=>{sent={name,args};return {data:1,error:null}},()=> 'recovery-request');
 const args={p_customer_id:'customer',p_rows:[{amount:100000,successFeeAmount:50000,installmentAmount:30000,clientReturnAmount:20000}],p_delete_ids:[],p_versions:{}};
 await save('recovery',args);
 assert.equal(sent.name,'dowon_save_recovery_batch_v2');assert.equal(Object.hasOwn(sent.args,'p_kind'),false);assert.equal(Object.hasOwn(sent.args,'p_carries'),false);assert.deepEqual(plain(sent.args.p_rows),args.p_rows);assert.equal(sent.args.p_request_key,'recovery-request');
});

test('additional contracts keep the existing once RPC contract',async()=>{
 let sent;const save=createRetryableSave(async(name,args)=>{sent={name,args};return {data:1,error:null}},()=> 'additional-request');
 await save('additional',{p_customer_id:'customer',p_rows:[{prepaidAmount:10000}],p_carries:{},p_delete_ids:[]});
 assert.equal(sent.name,'dowon_save_schedule_batch_once');assert.equal(sent.args.p_kind,'additional');assert.deepEqual(plain(sent.args.p_carries),{});
});

test('concurrent direct saves share a pending request and preserve its snapshot',async()=>{
 let finish,calls=0;const save=createRetryableSave(async()=>{calls++;return new Promise(resolve=>{finish=resolve})},()=> 'key');
 const first=save('payment',{p_rows:[{id:'p'}],p_carries:{}},{p_rows:[{id:'p'}],p_carries:{},p_versions:{p:7}});
 const second=save('payment',{p_rows:[{id:'p'}],p_carries:{}},{p_rows:[{id:'p'}],p_carries:{},p_versions:{p:8}});
 assert.equal(first,second);await Promise.resolve();assert.equal(calls,1);finish({data:1,error:null});await first;
});

test('a lost committed response retries the same direct-save key and original versions',async()=>{
 const calls=[];let keys=0;
 const save=createRetryableSave(async(name,args)=>{calls.push({name,args});return calls.length===1?{data:null,error:{message:'response lost'}}:{data:1,error:null}},()=>String(++keys));
 const identity={p_rows:[{id:'p',paidAmount:200000}],p_carries:{}};
 await save('payment',identity,{...identity,p_versions:{p:7}});await save('payment',identity,{...identity,p_versions:{p:8}});
 assert.equal(calls[0].args.p_request_key,calls[1].args.p_request_key);assert.equal(calls[1].args.p_versions.p,7);assert.equal(calls[1].name,'dowon_save_schedule_batch_v3');
 await save('payment',identity,{...identity,p_versions:{p:8}});assert.notEqual(calls[2].args.p_request_key,calls[1].args.p_request_key);assert.equal(calls[2].args.p_versions.p,8);
});

test('confirmed stale failures allow a fresh version snapshot on retry',async()=>{
 const calls=[];let keys=0;const save=createRetryableSave(async(_name,args)=>{calls.push(args);return calls.length===1?{data:null,error:{message:'stale',code:'P0001'}}:{data:1,error:null}},()=>String(++keys));
 const identity={p_rows:[{id:'r'}]};await save('repayment',identity,{...identity,p_versions:{r:7}});await save('repayment',identity,{...identity,p_versions:{r:8}});
 assert.notEqual(calls[0].p_request_key,calls[1].p_request_key);assert.equal(calls[1].p_versions.r,8);
});

test('recovery transport failures retain the same request key and deletion versions',async()=>{
 const calls=[];let keys=0;const save=createRetryableSave(async(_name,args)=>{calls.push(args);if(calls.length===1)throw Error('disconnected');return {data:1,error:null}},()=>String(++keys));
 const identity={p_rows:[],p_delete_ids:['old'],p_versions:{old:7}};
 await assert.rejects(save('recovery',identity),/disconnected/);await save('recovery',identity);assert.equal(calls[0].p_request_key,calls[1].p_request_key);assert.equal(calls[1].p_versions.old,7);
});
