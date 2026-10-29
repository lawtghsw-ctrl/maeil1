const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const vm=require('node:vm');
const source=fs.readFileSync('components/store.tsx','utf8');
const ast=ts.createSourceFile('store.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function method(name,context){let found;function visit(node){if(ts.isMethodDeclaration(node)&&node.name.getText(ast)===name)found=node;ts.forEachChild(node,visit);}visit(ast);assert.ok(found);const text=found.getText(ast).replace(`async ${name}(`,'async function(');const js=ts.transpileModule(`const handler=${text};handler`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return vm.runInNewContext(js,{Error,...context});}
const payment={id:'p',customerId:'c',dueAmount:500000,paidAmount:0,allocatedAmount:200000,dueDate:'2026-10-15',paidDate:'',status:'연체'};
test('individual save throws RPC error and does not refresh on failure',async()=>{let refreshed=false;const save=method('updatePayment',{payments:[payment],saveBatch:async()=>({error:{message:'rejected'}}),refresh:async()=>{refreshed=true}});await assert.rejects(save('p',{paidAmount:300001}),/rejected/);assert.equal(refreshed,false);});
test('individual carry sends the requested partial amount to atomic batch',async()=>{let sent;const save=method('savePaymentWithCarry',{payments:[payment],paymentCarryAmount:(_p,requested)=>requested,saveBatch:async(name,args)=>{sent={name,args};return {error:null}},refresh:async()=>{}});await save('p',{}, {dueDate:'2026-10-23',dueAmount:100000,memo:'partial'});assert.equal(sent.name,'payment');assert.equal(sent.args.p_carries.p[0].dueAmount,100000);assert.equal(sent.args.p_rows[0].paidAmount,0);});
test('bulk replacement submits deletion and edits in one transaction',async()=>{const calls=[];const save=method('setCustomerPayments',{payments:[payment,{...payment,id:'system',scheduleType:'환수'}],saveBatch:async(name,args)=>{calls.push({name,args});return {error:null}},refresh:async()=>{}});await save('c',[]);assert.equal(calls.length,1);assert.equal(calls[0].name,'payment');assert.equal(calls[0].args.p_delete_ids.length,1);assert.equal(calls[0].args.p_delete_ids[0],'p');});

for(const [name,collection,kind] of [['setCustomerAdditionalContracts','additionalContracts','additional'],['setCustomerRecoveries','recoveries','recovery']]){
test(name+' propagates failure without refreshing',async()=>{let refreshed=false;const save=method(name,{[collection]:[{id:'old',customerId:'c'}],saveBatch:async(k,args)=>{assert.equal(k,kind);assert.equal(args.p_delete_ids[0],'old');return {error:{message:'failed'}}},refresh:async()=>{refreshed=true}});await assert.rejects(save('c',[]),/failed/);assert.equal(refreshed,false);});}

test('new payment batch failure reaches editor without refresh',async()=>{let refreshed=false;const save=method('addPayments',{saveBatch:async()=>({error:{message:'network'}}),refresh:async()=>{refreshed=true}});await assert.rejects(save([payment]),/network/);assert.equal(refreshed,false);});
test('new payment batch rejects mixed customers before writing',async()=>{let calls=0;const save=method('addPayments',{saveBatch:async()=>{calls++;return {error:null}},refresh:async()=>{}});await assert.rejects(save([payment,{...payment,customerId:'other'}]),/한 고객/);assert.equal(calls,0);});

const repayment={id:'r',customerId:'c',lenderName:'Lender',contactType:'번호',contactValue:'01012345678',dueDate:'2026-10-15',amount:500000,paidAmount:100000,paidDate:'2026-10-15',status:'연체',account:'account',memo:''};
const repaymentChild={...repayment,id:'child',rescheduledFromId:'r',paidAmount:0,paidDate:'',amount:400000,status:'예정'};

for(const name of ['addRepayment','updateRepayment']){
 test(name+' rejects failed saves before refresh or lender synchronization',async()=>{
  let refreshed=0,synced=0;
  const save=method(name,{repayments:[repayment],saveBatch:async(kind)=>{assert.equal(kind,'repayment');return {error:{message:'connection failed'}}},syncLendersFromRepayments:async()=>{synced++},refresh:async()=>{refreshed++}});
  await assert.rejects(name==='addRepayment'?save(repayment):save('r',{amount:600000}),/connection failed/);
  assert.equal(refreshed,0);
  assert.equal(synced,0);
 });
}

test('linked repayment parent can change expected and actual amounts independently',async()=>{
 let sent,refreshed=0;
 const save=method('updateRepayment',{repayments:[repayment,repaymentChild],saveBatch:async(kind,args)=>{sent={kind,args};return {error:null}},syncLendersFromRepayments:async()=>{},refresh:async()=>{refreshed++}});
 await save('r',{amount:50000,paidAmount:600000,paidDate:'',status:'종결'});
 assert.equal(sent.kind,'repayment');
 assert.equal(sent.args.p_rows[0].amount,50000);
 assert.equal(sent.args.p_rows[0].paidAmount,600000);
 assert.equal(sent.args.p_rows[0].paidDate,'');
 assert.equal(sent.args.p_rows[0].status,'종결');
 assert.equal(refreshed,1);
});

test('repayment carry accepts an earlier date and above-balance amount beside an existing child',async()=>{
 let sent;
 const save=method('createRescheduledRepayment',{repayments:[repayment,repaymentChild],saveBatch:async(kind,args)=>{sent={kind,args};return {error:null}},refresh:async()=>{}});
 await save('r',{dueDate:'2026-09-01',amount:900000,memo:'new agreement'});
 assert.equal(sent.kind,'repayment');
 assert.equal(sent.args.p_carries.r[0].amount,900000);
 assert.equal(sent.args.p_carries.r[0].dueDate,'2026-09-01');
 assert.equal(sent.args.p_rows[0].amount,500000);
 assert.equal(sent.args.p_rows[0].paidAmount,100000);
});

test('repayment replacement deletes the last linked parent and child in one atomic request',async()=>{
 const calls=[];
 let refreshed=0;
 const save=method('setCustomerRepayments',{repayments:[repayment,repaymentChild,{...repayment,id:'other',customerId:'different'}],saveBatch:async(kind,args)=>{calls.push({kind,args});return {error:null}},syncLendersFromRepayments:async(rows)=>{assert.equal(rows.length,0)},refresh:async()=>{refreshed++}});
 await save('c',[]);
 assert.equal(calls.length,1);
 assert.equal(calls[0].kind,'repayment');
 assert.equal(calls[0].args.p_customer_id,'c');
 assert.equal(calls[0].args.p_rows.length,0);
 assert.deepEqual(Array.from(calls[0].args.p_delete_ids),['r','child']);
 assert.equal(refreshed,1);
});

test('repayment update still rejects moving a schedule to another customer before writing',async()=>{
 let calls=0;
 const save=method('updateRepayment',{repayments:[repayment],saveBatch:async()=>{calls++;return {error:null}},refresh:async()=>{}});
 await assert.rejects(save('r',{customerId:'different'}),/고객은 변경/);
 assert.equal(calls,0);
});

for(const [name,collection,record,kind] of [['deletePayment','payments',payment,'payment'],['deleteRepayment','repayments',repayment,'repayment']]){
 test(name+' returns a pending promise and refreshes only after the atomic deletion succeeds',async()=>{
  let finish,sent,refreshed=0;
  const save=method(name,{[collection]:[record],saveBatch:(k,args)=>{sent={kind:k,args};return new Promise(resolve=>{finish=resolve})},refresh:async()=>{refreshed++}});
  const pending=save(record.id);
  assert.equal(typeof pending.then,'function');
  assert.equal(refreshed,0);
  assert.equal(sent.kind,kind);
  assert.deepEqual(Array.from(sent.args.p_delete_ids),[record.id]);
  assert.equal(sent.args.p_rows.length,0);
  finish({error:null});await pending;
  assert.equal(refreshed,1);
 });
 test(name+' propagates both database and transport failure without refreshing',async()=>{
  for(const transport of [false,true]){
   let refreshed=0;
   const save=method(name,{[collection]:[record],saveBatch:async()=>{if(transport)throw new Error('transport disconnected');return {error:{message:'database rejected'}}},refresh:async()=>{refreshed++}});
   await assert.rejects(save(record.id),transport?/transport disconnected/:/database rejected/);
   assert.equal(refreshed,0);
  }
 });
}

test('system-created payment deletion is still rejected before issuing a request',async()=>{
 let called=false;
 const save=method('deletePayment',{payments:[{...payment,scheduleType:'환수'}],saveBatch:async()=>{called=true},refresh:async()=>{}});
 await assert.rejects(save(payment.id),/환수 등록/);
 assert.equal(called,false);
});

for(const [name,collection,original,kind] of [['cancelCompletedPayment','payments',payment,'payment'],['cancelCompletedRepayment','repayments',repayment,'repayment']]){
 test(name+' cancels cash and promise while retaining the selected version, debt and lineage',async()=>{
  const target={...original,paidAmount:200000,paidDate:'2026-10-21',status:kind==='payment'?'완료':'상환완료',promiseState:'rescheduled',rowVersion:9,obligationAmount:500000,rootScheduleId:'root',rescheduledFromId:'parent',dateChangeCount:3,memo:'original receipt'};
  let sent,refreshed=0;
  const save=method(name,{[collection]:[target],saveBatch:async(k,args)=>{sent={kind:k,args};return {error:null}},refresh:async()=>{refreshed++}});
  await save(target.id,7);
  assert.equal(sent.kind,kind);assert.equal(sent.args.p_customer_id,target.customerId);
  assert.equal(sent.args.p_delete_ids.length,0);assert.equal(sent.args.p_rows.length,1);
  const row=sent.args.p_rows[0];
  assert.equal(row.rowVersion,7);assert.equal(row.paidAmount,0);assert.equal(row.paidDate,'');
  assert.equal(row.status,'예정');assert.equal(row.promiseState,'cancelled');
  for(const key of ['id','customerId','dueDate','dueAmount','amount','allocatedAmount','obligationAmount','rootScheduleId','rescheduledFromId','dateChangeCount','memo'])assert.equal(row[key],target[key],key);
  assert.equal(target.paidAmount,200000);assert.equal(target.rowVersion,9);assert.equal(refreshed,1);
 });
 test(name+' waits for confirmation from the database before refreshing',async()=>{
  let finish,refreshed=0;
  const save=method(name,{[collection]:[{...original,paidAmount:200000}],saveBatch:()=>new Promise(resolve=>{finish=resolve}),refresh:async()=>{refreshed++}});
  const pending=save(original.id,1);assert.equal(refreshed,0);
  finish({error:null});await pending;assert.equal(refreshed,1);
 });
 test(name+' preserves the screen after a rejected save or ambiguous network failure',async()=>{
  for(const transport of [false,true]){
   let refreshed=0;
   const save=method(name,{[collection]:[{...original,paidAmount:200000}],saveBatch:async()=>{if(transport)throw new Error('response lost');return {error:{message:'stale version'}}},refresh:async()=>{refreshed++}});
   await assert.rejects(save(original.id,1),transport?/response lost/:/stale version/);assert.equal(refreshed,0);
  }
 });
 test(name+' rejects unknown records and invalid snapshots before writing',async()=>{
  let calls=0;
  const save=method(name,{[collection]:[original],saveBatch:async()=>{calls++;return {error:null}},refresh:async()=>{}});
  await assert.rejects(save('missing',1),/찾지 못했습니다/);
  for(const version of [0,-1,NaN,Infinity,1.5,undefined])await assert.rejects(save(original.id,version),/새로 불러온/);
  assert.equal(calls,0);
 });
}

for(const patch of [{scheduleType:'환수'},{scheduleType:'추가계약'},{sourceRecoveryId:'recovery'},{sourceAdditionalContractId:'contract'}])test('completed payment cancellation protects source-managed '+Object.keys(patch)[0]+':'+Object.values(patch)[0],async()=>{
 let calls=0;
 const save=method('cancelCompletedPayment',{payments:[{...payment,...patch,paidAmount:200000}],saveBatch:async()=>{calls++;return {error:null}},refresh:async()=>{}});
 await assert.rejects(save(payment.id,1),/환수 등록|추가 계약/);assert.equal(calls,0);
});

test('completed payment cancellation protects allocation-only credit but permits cancelling real cash beside credit',async()=>{
 let calls=0;
 const onlyCredit=method('cancelCompletedPayment',{payments:[payment],saveBatch:async()=>{calls++;return {error:null}},refresh:async()=>{}});
 await assert.rejects(onlyCredit(payment.id,1),/환수금으로 충당/);assert.equal(calls,0);
 const withCash=method('cancelCompletedPayment',{payments:[{...payment,paidAmount:200000}],saveBatch:async(_kind,args)=>{assert.equal(args.p_rows[0].allocatedAmount,200000);calls++;return {error:null}},refresh:async()=>{}});
 await withCash(payment.id,1);assert.equal(calls,1);
});

const recovery=(patch={})=>({id:'recovery',customerId:'c',recoveryDate:'2026-10-19',lenderName:'업체',depositorName:'입금자',amount:100000,paymentMethod:'계좌이체',memo:'',successFeeAmount:50000,installmentAmount:30000,clientReturnAmount:20000,accountingVersion:2,rowVersion:7,...patch});

test('untouched legacy recoveries cannot be silently converted by a collection save',async()=>{
 let calls=0,refreshed=0;const old=recovery({accountingVersion:1});
 const save=method('setCustomerRecoveries',{recoveries:[old],saveBatch:async()=>{calls++;return {error:null}},refresh:async()=>{refreshed++}});
 await save('c',[{...old,successFeeAmount:50000,installmentAmount:0,clientReturnAmount:0}],{recovery:7});
 assert.equal(calls,0);assert.equal(refreshed,0);
});

test('equivalent recovery fields ignore metadata and object-property ordering',async()=>{
 let calls=0;const old=recovery({createdTime:'2026-10-19T00:00:00Z'});
 const reordered=Object.fromEntries(Object.entries(old).reverse());delete reordered.createdTime;reordered.rowVersion=7;
 const save=method('setCustomerRecoveries',{recoveries:[old],saveBatch:async()=>{calls++;return {error:null}},refresh:async()=>{}});
 await save('c',[reordered],{recovery:7});assert.equal(calls,0);
});

test('saving recoveries sends only new rows and genuinely changed v2 rows',async()=>{
 let sent;const old=recovery(),legacy=recovery({id:'legacy',accountingVersion:1}),unchanged=recovery({id:'unchanged'});
 const save=method('setCustomerRecoveries',{recoveries:[old,legacy,unchanged],saveBatch:async(kind,args)=>{sent={kind,args};return {error:null}},refresh:async()=>{}});
 await save('c',[{...old,memo:'수정'},legacy,{...unchanged},recovery({id:undefined})],{recovery:7,legacy:7,unchanged:7});
 assert.equal(sent.kind,'recovery');assert.equal(sent.args.p_rows.length,2);assert.equal(sent.args.p_rows[0].id,'recovery');assert.equal(sent.args.p_rows[1].id,undefined);assert.equal(sent.args.p_delete_ids.length,0);assert.equal(Object.hasOwn(sent.args,'p_carries'),false);
});

test('recovery deletion retains its modal-open version and never deletes a concurrent new recovery',async()=>{
 let sent;const current=recovery({rowVersion:8}),concurrent=recovery({id:'concurrent',rowVersion:1});
 const save=method('setCustomerRecoveries',{recoveries:[current,concurrent],saveBatch:async(_kind,args)=>{sent=args;return {error:null}},refresh:async()=>{}});
 await save('c',[],{recovery:7});
 assert.deepEqual(Array.from(sent.p_delete_ids),['recovery']);assert.equal(sent.p_versions.recovery,7);assert.equal(Object.hasOwn(sent.p_versions,'concurrent'),false);assert.equal(sent.p_rows.length,0);
});

test('a modal opened with no recoveries cannot delete a recovery inserted by another user',async()=>{
 let calls=0;const save=method('setCustomerRecoveries',{recoveries:[recovery({id:'concurrent'})],saveBatch:async()=>{calls++;return {error:null}},refresh:async()=>{}});
 await save('c',[],{});assert.equal(calls,0);
});

test('a recovery edit keeps its original modal version after realtime updates',async()=>{
 let sent;const save=method('setCustomerRecoveries',{recoveries:[recovery({rowVersion:8,memo:'다른 사용자'})],saveBatch:async(_kind,args)=>{sent=args;return {error:null}},refresh:async()=>{}});
 await save('c',[recovery({memo:'내 수정'})],{recovery:7});assert.equal(sent.p_versions.recovery,7);assert.equal(sent.p_rows[0].memo,'내 수정');
});

test('recovery callers without a modal snapshot retain latest collection replacement semantics',async()=>{
 let sent;const save=method('setCustomerRecoveries',{recoveries:[recovery({rowVersion:8})],saveBatch:async(_kind,args)=>{sent=args;return {error:null}},refresh:async()=>{}});
 await save('c',[]);assert.equal(sent.p_versions.recovery,8);assert.deepEqual(Array.from(sent.p_delete_ids),['recovery']);
});

test('editing only a historical repayment receipt never syncs or recreates lender details',async()=>{
 const original={...repayment,promiseState:'cancelled',rowVersion:7};let sent,synced=0;
 const save=method('saveCustomerRepaymentsAtomic',{repayments:[original],saveBatch:async(kind,args)=>{sent={kind,args};return {error:null}},syncLendersFromRepayments:async()=>{synced++},refresh:async()=>{},fail:message=>{throw Error(message)}});
 await save('c',[{...original,paidAmount:200000}],{},[],{r:7});
 assert.equal(sent.kind,'repayment');assert.equal(sent.args.p_rows[0].promiseState,'cancelled');assert.equal(sent.args.p_rows[0].paidAmount,200000);assert.equal(sent.args.p_rows[0].paidDate,'2026-10-15');assert.equal(sent.args.p_versions.r,7);assert.equal(synced,0);
});
