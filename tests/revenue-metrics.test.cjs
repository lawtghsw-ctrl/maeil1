const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const loaded={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/revenue-metrics.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:loaded,exports:loaded.exports});
const {buildRevenueEvents,summarizeRevenue}=loaded.exports;
const payment=(id,patch={})=>({id,customerId:'c',paidAmount:100000,paidDate:'2026-10-16',status:'완료',scheduleType:'일반',...patch});
const recovery=(id,patch={})=>({id,customerId:'c',amount:1000000,recoveryDate:'2026-10-20',accountingVersion:2,successFeeAmount:500000,installmentAmount:200000,clientReturnAmount:300000,...patch});

test('contract cash and recovery installments are revenue while gross recovery is one bank receipt',()=>{
 const payments=[payment('upfront'),payment('installment',{paidAmount:150000}),payment('shadow',{scheduleType:'환수',sourceRecoveryId:'r',paidAmount:1000000})];
 const recoveries=[recovery('r')],before=JSON.stringify({payments,recoveries});
 const events=buildRevenueEvents(payments,recoveries),totals=summarizeRevenue(events);
 assert.equal(events.length,3);assert.equal(totals.contractCash,250000);assert.equal(totals.recoveryInstallment,200000);
 assert.equal(totals.realSales,450000);assert.equal(totals.recoverySuccessFee,500000);assert.equal(totals.recoveryGross,1000000);assert.equal(totals.cashInflow,1250000);
 assert.equal(JSON.stringify({payments,recoveries}),before);
});

test('legacy active allocations and detailed installments are each recognized once',()=>{
 const rows=[recovery('legacy',{accountingVersion:1,installmentAmount:999999,successFeeAmount:0}),recovery('detailed')];
 const allocations=[{recoveryId:'legacy',amount:60000},{recoveryId:'legacy',amount:40000},{recoveryId:'detailed',amount:200000}];
 const totals=summarizeRevenue(buildRevenueEvents([],rows,allocations));
 assert.equal(totals.recoveryInstallment,300000);assert.equal(totals.realSales,300000);assert.equal(totals.recoverySuccessFee,1000000);assert.equal(totals.cashInflow,2000000);
});

test('a changed or cancelled payment promise retains its dated cash without inventing receipts',()=>{
 const rows=[payment('cancelled',{promiseState:'cancelled'}),payment('changed',{promiseState:'rescheduled',paidAmount:50000}),
  payment('forecast',{paidAmount:0,status:'예정'}),payment('refund',{status:'환불'}),payment('undated',{paidDate:''})];
 const events=buildRevenueEvents(rows,[]);
 assert.deepEqual(Array.from(events,row=>row.id),['cancelled','changed','undated']);assert.equal(summarizeRevenue(events,'2026-10-01','2026-10-31').realSales,150000);
 assert.equal(summarizeRevenue(events).cashInflow,250000);assert.equal(events.find(row=>row.id==='undated').date,'');
});

test('source-linked recovery shadow is excluded even with an imported ordinary schedule type',()=>{
 const totals=summarizeRevenue(buildRevenueEvents([payment('shadow',{sourceRecoveryId:'r',paidAmount:1000000})],[recovery('r')]));
 assert.equal(totals.contractCash,0);assert.equal(totals.cashInflow,1000000);assert.equal(totals.realSales,200000);
});

test('ordinary manual receipts are never excluded by memo, name, date or matching recovery amount',()=>{
 const totals=summarizeRevenue(buildRevenueEvents([payment('manual',{paidAmount:200000,memo:'환수 분납금 수기 수정'})],[recovery('r')]));
 assert.equal(totals.contractCash,200000);assert.equal(totals.realSales,400000);assert.equal(totals.cashInflow,1200000);
});

test('success fee uses integer 50 percent for old and new recovery versions including odd amounts',()=>{
 const events=buildRevenueEvents([],[recovery('old',{accountingVersion:1,amount:100001,successFeeAmount:0}),recovery('new',{amount:100001,successFeeAmount:1,installmentAmount:0})]);
 assert.equal(events[0].recoverySuccessFee,50000);assert.equal(events[1].recoverySuccessFee,50000);assert.equal(summarizeRevenue(events).recoverySuccessFee,100000);
});

test('range and customer filters use the actual source receipt date with inclusive boundaries',()=>{
 const events=buildRevenueEvents([payment('first'),payment('last',{paidDate:'2026-10-31'}),payment('before',{paidDate:'2026-10-15'}),payment('other',{customerId:'other'})],
  [recovery('r'),recovery('old',{recoveryDate:'2026-09-30'}),recovery('next',{recoveryDate:'2026-11-01'})]);
 const totals=summarizeRevenue(events,'2026-10-16','2026-10-31',new Set(['c']));
 assert.equal(totals.contractCash,200000);assert.equal(totals.realSales,400000);assert.equal(totals.recoverySuccessFee,500000);
});

test('zero and nonfinite amounts do not contaminate positive source totals',()=>{
 const events=buildRevenueEvents([payment('bad',{paidAmount:NaN})],[recovery('zero',{amount:0}),recovery('bad',{amount:NaN}),recovery('valid',{amount:200000,installmentAmount:NaN})]);
 assert.equal(events.length,1);const totals=summarizeRevenue(events);assert.equal(totals.realSales,0);assert.equal(totals.recoverySuccessFee,100000);assert.equal(totals.cashInflow,200000);
});

test('undated real cash stays cumulative and never inherits a creation or planned date for any period filter',()=>{
 const events=buildRevenueEvents([payment('undated',{paidDate:''})],[recovery('legacy',{accountingVersion:1,recoveryDate:'',createdTime:'2026-10-19T01:02:03Z'})]);
 assert.ok(events.every(event=>event.date===''));assert.equal(summarizeRevenue(events).cashInflow,1100000);
 assert.equal(summarizeRevenue(events).recoverySuccessFee,500000);
 for(const [start,end] of [['2026-10-01','2026-10-31'],['','2026-10-31'],['2026-10-01','']]){
  const totals=summarizeRevenue(events,start,end);assert.equal(totals.cashInflow,0);assert.equal(totals.realSales,0);assert.equal(totals.recoverySuccessFee,0);
 }
});
