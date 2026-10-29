const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const vm=require('node:vm');
function load(file){const mod={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{module:mod,exports:mod.exports,Error,require:name=>load(name==="./schedule-ledger"?"lib/schedule-ledger.ts":name)});return mod.exports;}
const {createRefreshQueue,createTableLoader,reuseUnchangedRows,groupBy}=load('lib/supabase/refresh-queue.ts');
const {fetchAllRows}=load('lib/supabase/fetch-all.ts');
const metrics=load('lib/payment-metrics.ts');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('events during a fetch are merged into one serialized trailing refresh',async()=>{
 const seen=[];const release=[];let running=0,max=0;
 const refresh=createRefreshQueue(async tables=>{running++;max=Math.max(max,running);seen.push(tables===null?null:[...tables]);await new Promise(r=>release.push(r));running--;});
 const first=refresh(['customers']);await tick();
 const second=refresh(['payments']);refresh(['recoveries']);refresh(['payments']);
 assert.equal(first,second);assert.equal(seen.length,1);release.shift()();await tick();
 assert.deepEqual(seen,[['customers'],['payments','recoveries']]);release.shift()();await first;assert.equal(max,1);
});
test('manual refresh overrides narrow invalidation and cannot miss a completed save',async()=>{
 const seen=[];const release=[];const refresh=createRefreshQueue(async tables=>{seen.push(tables===null?null:[...tables]);await new Promise(r=>release.push(r));});
 const done=refresh(['payments']);await tick();refresh();refresh(['customers']);release.shift()();await tick();
 assert.deepEqual(seen,[['payments'],null]);release.shift()();await done;
});
test('refresh queue recovers after transport failure',async()=>{let calls=0;const refresh=createRefreshQueue(async()=>{if(++calls===1)throw new Error('offline')});await assert.rejects(refresh(),/offline/);await refresh();assert.equal(calls,2);});
test('table cache reloads only invalidated tables and evicts stale results after returned or thrown failures',async()=>{
 const loadTable=createTableLoader();let calls=0;const fetch=async()=>{calls++;return {data:[{id:calls}],error:null}};
 const original=await loadTable('customers',false,fetch);await loadTable('payments',false,fetch);
 assert.equal(await loadTable('customers',false,fetch),original);assert.equal(calls,2);
 const newer=await loadTable('payments',true,fetch);assert.equal(calls,3);
 const failed=await loadTable('payments',true,async()=>({data:null,error:{message:'offline'}}));assert.ok(failed.error);
 const retried=await loadTable('payments',false,fetch);assert.notEqual(retried,newer);assert.equal(calls,4);
 assert.equal(await loadTable('payments',false,fetch),retried);assert.equal(calls,4);
 await assert.rejects(loadTable('payments',true,async()=>{throw new Error('transport disconnected')}),/transport disconnected/);
 const recovered=await loadTable('payments',false,fetch);assert.notEqual(recovered,retried);assert.equal(calls,5);
 assert.equal(await loadTable('payments',false,fetch),recovered);assert.equal(calls,5);
});
test('unchanged nested records retain identity; edits, deletions and order changes publish',()=>{
 const old=[{id:1,contacts:[{value:'a'}]},{id:2,contacts:[]}];
 assert.equal(reuseUnchangedRows(old,JSON.parse(JSON.stringify(old))),old);
 const changed=[{id:1,contacts:[{value:'b'}]},old[1]];
 assert.equal(reuseUnchangedRows(old,changed),changed);assert.notEqual(reuseUnchangedRows(old,[old[1]]),old);assert.notEqual(reuseUnchangedRows(old,[...old].reverse()),old);
});
test('count-aware pagination avoids terminal request and respects smaller server cap',async()=>{
 const rows=Array.from({length:1201},(_,i)=>i);let calls=0,countRequests=0;
 const result=await fetchAllRows(first=>({range:async(from)=>{calls++;if(first)countRequests++;return {data:rows.slice(from,from+137),error:null,count:first?rows.length:null}}}));
 assert.equal(result.data.length,1201);assert.equal(calls,9);assert.equal(countRequests,1);
});
test('count-aware pagination does not publish partial records on later failure',async()=>{
 let calls=0;const result=await fetchAllRows(()=>({range:async()=>++calls===1?{data:[1],count:3,error:null}:{data:null,error:{message:'offline'}}}));assert.equal(result.data,null);assert.equal(result.error.message,'offline');
});
test('payment indexes preserve cash/allocation rules and invalidate with new snapshots',()=>{
 const rows=[{id:'parent',customerId:'a',paidAmount:100,allocatedAmount:20},{id:'child',customerId:'a',paidAmount:50,rescheduledFromId:'parent'},{id:'refund',customerId:'a',paidAmount:900,status:'환불'},{id:'recovery',customerId:'a',paidAmount:800,scheduleType:'환수'},{id:'other',customerId:'b',paidAmount:40}];
 assert.equal(metrics.customerPaid(rows,'a'),150);assert.equal(metrics.customerCredit(rows,'a'),20);assert.equal(metrics.hasRescheduledChild(rows,'parent'),true);
 const next=rows.map(row=>row.id==='child'?{...row,paidAmount:75}:row);
 assert.equal(metrics.customerPaid(next,'a'),175);assert.equal(metrics.customerPaid(rows,'a'),150);assert.equal(metrics.customerPaid(rows,'missing'),0);
});
test('grouped joins preserve duplicates and source ordering',()=>{const rows=[{key:'a',id:1},{key:'b',id:2},{key:'a',id:3}];const grouped=groupBy(rows,r=>r.key);assert.deepEqual([...grouped.get('a')], [rows[0],rows[2]]);});

test('actual store refresh queries only changed contracts and updates derived customer totals',async()=>{
 const source=fs.readFileSync('components/store.tsx','utf8');const ast=ts.createSourceFile('store.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let callback;
 function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='loadSnapshot')callback=node.initializer.arguments[0];ts.forEachChild(node,visit);}visit(ast);assert.ok(callback);
 const states={};const setters={};for(const name of ['Customers','Payments','Repayments','Lenders','Posts','Settlements','MetaLeads','AdditionalContracts','Recoveries','RecoveryAllocations','RecoverySplits','RecoveryRefunds']){states[name]=[];setters['set'+name]=update=>{states[name]=typeof update==='function'?update(states[name]):update};}
 const raw={customers:[{id:'c',contract_amount:1000}],payment_schedules:[{id:'p',customer_id:'c',expected_amount:1000,paid_amount:100}]};const requested=[];let failedTable;let storeError=null;
 const supabase={from:table=>{const query={select:()=>query,is:()=>query,order:()=>query,range:async(from,to)=>{requested.push(table);if(table===failedTable)return {data:null,error:{message:'offline'}};const rows=raw[table]||[];return {data:rows.slice(from,to+1),error:null,count:rows.length}}};return query}};
 const body=ts.transpileModule('const snapshot='+callback.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 const snapshot=vm.runInNewContext(body+';snapshot',{...setters,supabase,loadTable:createTableLoader(),fetchAllRows,reuseUnchangedRows,groupBy,n:v=>Number(v||0),date:v=>String(v||'').slice(0,10),initializedRef:{current:false},setLoading:()=>{},setInitialized:()=>{},setError:e=>{storeError=e}});
 await snapshot(null);assert.equal(requested.length,15);const payments=states.Payments;const customers=states.Customers;
 requested.length=0;await snapshot(new Set(['customers']));assert.deepEqual(requested,['customers']);assert.equal(states.Customers,customers);assert.equal(states.Payments,payments);
 raw.additional_contracts=[{id:'ac',customer_id:'c',contract_amount:200,upfront_amount:50}];requested.length=0;await snapshot(new Set(['additional_contracts']));assert.deepEqual(requested,['additional_contracts']);assert.equal(states.Customers[0].contractAmount,1200);assert.equal(states.Customers[0].prepaidAmount,50);assert.equal(states.Payments,payments);
 failedTable='payment_schedules';await snapshot(new Set(['payment_schedules']));assert.equal(storeError,'offline');assert.equal(states.Payments,payments);
});

function recoverySnapshotHarness(raw){
 const source=fs.readFileSync('components/store.tsx','utf8');const ast=ts.createSourceFile('store.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let callback;
 function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='loadSnapshot')callback=node.initializer.arguments[0];ts.forEachChild(node,visit);}visit(ast);assert.ok(callback);
 const states={},setters={},requested=[],failures=new Map();let storeError=null;
 for(const name of ['Customers','Payments','Repayments','Lenders','Posts','Settlements','MetaLeads','AdditionalContracts','Recoveries','RecoveryAllocations','RecoverySplits','RecoveryRefunds']){states[name]=[];setters['set'+name]=update=>{states[name]=typeof update==='function'?update(states[name]):update};}
 const supabase={from:table=>{const filters=[];const query={select:()=>query,is:(column,value)=>{filters.push([column,value]);return query},order:()=>query,range:async(from,to)=>{
  requested.push(table);
  if(failures.has(table)){const throws=failures.get(table);failures.delete(table);if(throws)throw new Error('offline');return {data:null,error:{message:'offline'}};}
  const records=table==='dowon_active_recovery_allocations'
   ?raw.recovery_fee_allocations.filter(allocation=>raw.recoveries.some(recovery=>recovery.id===allocation.recovery_id&&recovery.accounting_version===1&&!recovery.deleted_at))
   :raw[table]||[];
  const rows=records.filter(row=>filters.every(([column,value])=>(row[column]??null)===value));
  return {data:rows.slice(from,to+1),error:null,count:rows.length};
 }};return query}};
 const body=ts.transpileModule('const snapshot='+callback.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
 const snapshot=vm.runInNewContext(body+';snapshot',{...setters,supabase,loadTable:createTableLoader(),fetchAllRows,reuseUnchangedRows,groupBy,n:v=>Number(v||0),date:v=>String(v||'').slice(0,10),initializedRef:{current:false},setLoading:()=>{},setInitialized:()=>{},setError:error=>{storeError=error}});
 function amounts(){
  const customer=states.Customers[0],cash=metrics.customerPaid(states.Payments,customer.id),credit=metrics.customerCredit(states.Payments,customer.id,customer.recoveryCredit);
  const cumulative=metrics.customerCumulativePaid(states.Payments,customer.id,customer.recoveryCredit);
  const ledger=load('lib/schedule-ledger.ts').buildScheduleLedger(states.Payments,customer.contractAmount,customer.recoveryCredit);
  assert.equal(ledger.totals.paid,cash);assert.equal(ledger.totals.credit,credit);assert.equal(ledger.totals.remaining,Math.max(0,customer.contractAmount-cumulative));
  return {cash,credit,cumulative,receivable:ledger.totals.remaining};
 }
 return {states,requested,snapshot,amounts,failNext:(table,throws=false)=>failures.set(table,throws),get error(){return storeError}};
}

function recoveryFixture(version=1){return {
 customers:[{id:'c',contract_amount:1000000,eformsign_status:'003'}],
 payment_schedules:[{id:'cash',customer_id:'c',expected_amount:200000,paid_amount:200000,status:'완료',schedule_type:'일반'},
  {id:'credited',customer_id:'c',expected_amount:100000,paid_amount:0,status:'완료',schedule_type:'일반'},
  {id:'recovery-shadow',customer_id:'c',expected_amount:1000000,paid_amount:1000000,status:'완료',schedule_type:'환수',source_recovery_id:'r'}],
 recoveries:[{id:'r',customer_id:'c',accounting_version:version,amount:1000000,installment_amount:version===2?100000:0}],
 recovery_fee_allocations:Object.freeze([Object.freeze({id:'allocation',recovery_id:'r',customer_id:'c',payment_schedule_id:'credited',amount:100000})]),
}}

for(const scenario of [
 {name:'legacy conversion preserves the same credit once',initialVersion:1,next:{accounting_version:2,installment_amount:100000},expectedCredit:100000},
 {name:'legacy conversion applies the changed credit once',initialVersion:1,next:{accounting_version:2,installment_amount:150000},expectedCredit:150000},
 {name:'legacy deletion removes credit without changing immutable allocations',initialVersion:1,next:{deleted_at:'2026-10-23T03:00:00Z'},expectedCredit:0},
 {name:'detailed deletion removes its credit without reviving legacy allocations',initialVersion:2,next:{deleted_at:'2026-10-23T03:00:00Z'},expectedCredit:0},
 {name:'detailed credit edits retain cash and ignore preserved legacy allocations',initialVersion:2,next:{installment_amount:200000},expectedCredit:200000},
 {name:'ordinary legacy metadata edits preserve cash and credit',initialVersion:1,next:{memo:'updated recovery memo'},expectedCredit:100000},
])test('actual recovery-only store refresh: '+scenario.name,async()=>{
 const raw=recoveryFixture(scenario.initialVersion);
 const allocationBefore=JSON.stringify(raw.recovery_fee_allocations),paymentsBefore=JSON.stringify(raw.payment_schedules);
 const screen=recoverySnapshotHarness(raw);
 await screen.snapshot(null);
 assert.deepEqual(screen.amounts(),{cash:200000,credit:100000,cumulative:300000,receivable:700000});
 raw.recoveries=raw.recoveries.map(recovery=>({...recovery,...scenario.next}));
 screen.requested.length=0;await screen.snapshot(new Set(['recoveries']));
 assert.deepEqual(screen.amounts(),{cash:200000,credit:scenario.expectedCredit,cumulative:200000+scenario.expectedCredit,receivable:800000-scenario.expectedCredit});
 assert.deepEqual(screen.requested,['recoveries','dowon_active_recovery_allocations']);
 assert.equal(screen.states.RecoveryAllocations.length,scenario.initialVersion===1&&scenario.next.accounting_version!==2&&!scenario.next.deleted_at?1:0);
 assert.equal(JSON.stringify(raw.recovery_fee_allocations),allocationBefore);
 assert.equal(JSON.stringify(raw.payment_schedules),paymentsBefore);
});

for(const change of [
 {name:'conversion',next:{accounting_version:2,installment_amount:100000},expectedCredit:100000},
 {name:'deletion',next:{deleted_at:'2026-10-23T03:00:00Z'},expectedCredit:0},
])for(const failedTable of ['dowon_active_recovery_allocations','recoveries'])test(`failed ${failedTable} during ${change.name} retains the UI and retries on an unrelated refresh`,async()=>{
 const raw=recoveryFixture(),allocationBefore=JSON.stringify(raw.recovery_fee_allocations),paymentsBefore=JSON.stringify(raw.payment_schedules);
 const screen=recoverySnapshotHarness(raw);await screen.snapshot(null);
 const customers=screen.states.Customers,payments=screen.states.Payments;
 raw.recoveries=raw.recoveries.map(recovery=>({...recovery,...change.next}));
 screen.failNext(failedTable,change.name==='deletion');await screen.snapshot(new Set(['recoveries']));
 assert.equal(screen.error,'offline');assert.equal(screen.states.Customers,customers);assert.equal(screen.states.Payments,payments);
 assert.deepEqual(screen.amounts(),{cash:200000,credit:100000,cumulative:300000,receivable:700000});
 screen.requested.length=0;await screen.snapshot(new Set(['customers']));
 assert.equal(screen.error,null);
 assert.deepEqual(screen.amounts(),{cash:200000,credit:change.expectedCredit,cumulative:200000+change.expectedCredit,receivable:800000-change.expectedCredit});
 assert.deepEqual(screen.requested,['customers',failedTable]);
 assert.equal(screen.states.RecoveryAllocations.length,0);
 assert.equal(JSON.stringify(raw.recovery_fee_allocations),allocationBefore);assert.equal(JSON.stringify(raw.payment_schedules),paymentsBefore);
});
