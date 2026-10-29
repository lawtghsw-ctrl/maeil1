const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const vm=require('node:vm');
function load(file){const mod={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:mod.exports,module:mod,Error,require:name=>load(name==="./schedule-ledger"?"lib/schedule-ledger.ts":name)});return mod.exports;}
const metrics=load('lib/payment-metrics.ts');
const {fetchAllRows}=load('lib/supabase/fetch-all.ts');
test('net debt subtracts allocations without changing cash',()=>{const p={customerId:'a',dueAmount:500000,paidAmount:100000,allocatedAmount:200000};assert.equal(metrics.paymentRemaining(p),200000);assert.equal(metrics.customerCredit([p],'a'),200000);assert.equal(p.paidAmount,100000);});

test('detailed recovery credit is added to legacy allocations without becoming a receipt',()=>{
 const rows=[{id:'p',customerId:'a',dueAmount:500000,paidAmount:100000,allocatedAmount:50000},
  {id:'other',customerId:'b',dueAmount:100000,paidAmount:100000,allocatedAmount:10000},
  {id:'recovery',customerId:'a',scheduleType:'환수',paidAmount:300000,allocatedAmount:300000}];
 assert.equal(metrics.customerCredit(rows,'a',100000),150000);
 assert.equal(metrics.customerCredit(rows,'a'),50000);assert.equal(metrics.customerPaid(rows,'a'),100000);
 assert.equal(metrics.customerCredit([],'a',100000),100000);
});

test('cumulative paid includes cash and legacy and detailed recovery installment credit once',()=>{
 const rows=[
  {id:'upfront',customerId:'a',scheduleType:'일반',paidAmount:200000},
  {id:'legacy-credit',customerId:'a',scheduleType:'일반',paidAmount:0,allocatedAmount:100000,status:'완료'},
  {id:'recovery-shadow',customerId:'a',scheduleType:'환수',paidAmount:1000000,allocatedAmount:300000},
  {id:'refund',customerId:'a',scheduleType:'일반',paidAmount:50000,allocatedAmount:20000,status:'환불'},
  {id:'other',customerId:'b',scheduleType:'일반',paidAmount:900000,allocatedAmount:600000},
 ],before=JSON.stringify(rows);
 assert.equal(metrics.customerCumulativePaid(rows,'a',150000),450000);
 assert.equal(metrics.customerPaid(rows,'a'),200000);
 assert.equal(metrics.customerCredit(rows,'a',150000),250000);
 assert.equal(JSON.stringify(rows),before);
});

test('recovery-only credit counts as cumulative paid without a fictitious cash receipt',()=>{
 assert.equal(metrics.customerCumulativePaid([],'a',180000),180000);
 assert.equal(metrics.customerPaid([],'a'),0);
 assert.equal(metrics.customerCumulativePaid([],'a'),0);
 assert.equal(metrics.customerCumulativePaid([],'a',-180000),0);
});

test('cumulative paid retains real cash on retired promises and reflects cancelled receipts and credit',()=>{
 const rows=[{id:'old',customerId:'a',paidAmount:200000,allocatedAmount:100000,promiseState:'cancelled'}];
 assert.equal(metrics.customerCumulativePaid(rows,'a',150000),450000);
 const afterCashCancel=rows.map(row=>({...row,paidAmount:0}));
 assert.equal(metrics.customerCumulativePaid(afterCashCancel,'a',150000),250000);
 const afterCreditCancel=afterCashCancel.map(row=>({...row,allocatedAmount:0}));
 assert.equal(metrics.customerCumulativePaid(afterCreditCancel,'a',0),0);
 assert.equal(metrics.customerPaid(rows,'a'),200000);
});

test('a separately entered manual schedule remains visible even when historical cash already covers the contract',()=>{
 const rows=[{id:'old',customerId:'a',dueDate:'2026-10-16',dueAmount:500000,paidAmount:500000,promiseState:'rescheduled'},
  {id:'current',customerId:'a',dueDate:'2026-10-20',dueAmount:500000,paidAmount:0,rescheduledFromId:'old'}];
 const balances=metrics.currentPaymentBalances(rows,[{id:'a',contractAmount:500000}]);
 assert.equal(balances.get('old'),0);assert.equal(balances.get('current'),500000);
 assert.equal(metrics.effectivePayments(rows,[{id:'a',contractAmount:500000}])[0].id,'current');
 assert.equal(metrics.customerPaid(rows,'a'),500000);
});
test('unallocated legacy rows retain original behavior',()=>assert.equal(metrics.paymentRemaining({dueAmount:375000,paidAmount:350000}),25000));
test('manual partial carry amount is preserved instead of replaced by full balance',()=>{const p={dueAmount:500000,paidAmount:0,allocatedAmount:200000};assert.equal(metrics.paymentCarryAmount(p,100000),100000);assert.equal(metrics.paymentCarryAmount(p),300000);assert.equal(metrics.paymentCarryAmount(p,300001),300001);assert.equal(metrics.paymentCarryAmount(p,0),0);assert.throws(()=>metrics.paymentCarryAmount(p,-1));});
test('fully allocated completion does not demand a fictitious cash receipt',()=>assert.equal(metrics.paymentCompletionIssue({status:'완료',dueAmount:500000,allocatedAmount:500000,paidAmount:0,paidDate:''}),''));
test('real cash still requires its receipt date',()=>assert.match(metrics.paymentCompletionIssue({status:'완료',dueAmount:500000,allocatedAmount:200000,paidAmount:300000,paidDate:''}),/입금일/));
test('pagination continues beyond server cap below requested size',async()=>{const records=Array.from({length:1201},(_,i)=>i);let calls=0;const r=await fetchAllRows(()=>({range:async(from,to)=>{calls++;return {data:records.slice(from,Math.min(to+1,from+137)),error:null}}}));assert.equal(r.data.length,1201);assert.equal(r.data[1200],1200);assert.ok(calls>8);});
test('pagination discards partial rows if later page fails',async()=>{let calls=0;const r=await fetchAllRows(()=>({range:async()=>++calls===1?{data:[1,2],error:null}:{data:null,error:{message:'offline'}}}));assert.equal(r.data,null);assert.equal(r.error.message,'offline');});
test('network exception becomes error instead of publishing incomplete state',async()=>{const r=await fetchAllRows(()=>({range:async()=>{throw new Error('offline')}}));assert.equal(r.error.message,'offline');});

const {createRetryableSave}=load('lib/supabase/retryable-save.ts');
test('concurrent submits share request and lost-response retry keeps key',async()=>{let calls=0;const keys=[];let resolve;const save=createRetryableSave((_name,args)=>{calls++;keys.push(args.p_request_key);return new Promise(r=>{resolve=r})},()=>String(keys.length+1));const first=save('payment',{p_rows:[1]});const duplicate=save('payment',{p_rows:[1]});assert.equal(first,duplicate);await Promise.resolve();resolve({data:null,error:{message:'offline'}});await first;const retry=save('payment',{p_rows:[1]});await Promise.resolve();resolve({data:1,error:null});await retry;assert.equal(calls,2);assert.equal(keys[0],keys[1]);const next=save('payment',{p_rows:[1]});await Promise.resolve();resolve({data:1,error:null});await next;assert.notEqual(keys[2],keys[0]);});
test('thrown transport error keeps retry identity',async()=>{const keys=[];const save=createRetryableSave(async(_name,args)=>{keys.push(args.p_request_key);if(keys.length===1)throw new Error('network');return {data:1,error:null}},()=>String(keys.length+1));await assert.rejects(save('recovery',{}),/network/);await save('recovery',{});assert.equal(keys[0],keys[1]);});
test('lost create response plus realtime refresh retries original version snapshot',async()=>{
 const calls=[];let commits=0;const recorded=new Map();
 const save=createRetryableSave(async(name,args)=>{calls.push({name,args});if(recorded.has(args.p_request_key))return {data:recorded.get(args.p_request_key),error:null};recorded.set(args.p_request_key,++commits);return {data:null,error:{message:'response lost'}}},()=>`key-${calls.length+1}`);
 const input={p_customer_id:'c',p_rows:[{dueAmount:100000}],p_carries:{},p_delete_ids:[]};
 await save('payment',input,{...input,p_versions:{}});
 await save('payment',input,{...input,p_versions:{'just-created-row':1}});
 assert.equal(commits,1);assert.equal(calls[0].name,'dowon_save_schedule_batch_v3');
 assert.equal(calls[0].args.p_request_key,calls[1].args.p_request_key);
 assert.equal(JSON.stringify(calls[1].args.p_versions),'{}');
 assert.equal('p_carries' in calls[1].args,false);
});

test('confirmed rollback releases stale versions for a refreshed retry',async()=>{
 const calls=[];const save=createRetryableSave(async(_name,args)=>{calls.push(args);return args.p_versions.row===1?{data:null,error:{message:'stale',code:'P0001'}}:{data:1,error:null}},()=>`key-${calls.length+1}`);
 const input={p_customer_id:'c',p_rows:[{dueAmount:100000}]};
 const first=await save('payment',input,{...input,p_versions:{row:1}});
 const retry=await save('payment',input,{...input,p_versions:{row:2}});
 assert.equal(first.error.code,'P0001');assert.equal(retry.error,null);
 assert.notEqual(calls[0].p_request_key,calls[1].p_request_key);assert.equal(calls[1].p_versions.row,2);
});
