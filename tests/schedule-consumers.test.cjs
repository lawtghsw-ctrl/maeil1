const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');

function compile(source,context={}){
 const compiledModule={exports:{}};
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 return vm.runInNewContext(code,{require,module:compiledModule,exports:compiledModule.exports,NOTICE_SENDER_NAME:'로파워',BANK_NOTICE:'',...context});
}
const buildScheduleLedger=compile(fs.readFileSync('lib/schedule-ledger.ts','utf8')+';buildScheduleLedger');
const revenueApi=compile(fs.readFileSync('lib/revenue-metrics.ts','utf8')+';exports');
const bankApi=compile(fs.readFileSync('lib/bank-cash-metrics.ts','utf8')+';exports');
const previewScheduleLedger=compile(fs.readFileSync('lib/schedule-ledger.ts','utf8')+';previewScheduleLedger');
const calendarOverdueHistory=compile(fs.readFileSync('lib/calendar-status.ts','utf8')+';calendarOverdueHistory');
const calendarItemTone=compile(fs.readFileSync('lib/calendar-status.ts','utf8')+';calendarItemTone');
const isCompletedRepaymentStatus=compile(fs.readFileSync('lib/calendar-status.ts','utf8')+';isCompletedRepaymentStatus');
const calendarPaymentRecord=compile(fs.readFileSync('lib/calendar-status.ts','utf8')+';calendarPaymentRecord');
const useState=initial=>[typeof initial==='function'?initial():initial,()=>{}];
const useMemo=callback=>callback();
const customer={id:'customer',name:'검증 고객',contractAmount:500000,eformsignStatus:'완료',isAccident:false,createdAt:'2026-10-01',contractDate:'2026-10-01'};
const payment=(id,patch={})=>({id,customerId:customer.id,dueDate:'2026-10-16',dueAmount:500000,paidAmount:0,paidDate:'',allocatedAmount:0,status:'연체',memo:'',scheduleType:'일반',...patch});
function store(payments,repayments=[],contractAmount=500000){return {payments,repayments,customers:[{...customer,contractAmount}],additionalContracts:[],recoveries:[],recoveryAllocations:[],recoveryRefunds:[],get settlements(){return this.payments.filter(row=>row.status!=='환불'&&row.paidAmount>0&&row.paidDate).map(row=>({id:'bank:'+row.id,customerId:row.customerId,sourcePaymentScheduleId:row.id,paidDate:row.paidDate,amount:row.paidAmount,entrySource:'payment',entryType:row.scheduleType==='환수'?'환수':'계약',clientName:'검증 고객',paymentMethod:'계좌이체',memo:''}))}};}
function notice(data){
 const source=fs.readFileSync('components/schedule-notice.tsx','utf8');
 const ast=ts.createSourceFile('notice.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const helpers=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text!=='ScheduleNoticeModal').map(node=>node.getText(ast)).join('\n');
 const component=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='ScheduleNoticeModal');
 const head=component.body.statements.filter(node=>!ts.isReturnStatement(node)).map(node=>node.getText(ast)).join('\n');
 const run=compile(`${helpers}\nfunction run({open,customer,onClose}){${head}\nreturn {buildAllNotice,buildInstallmentNotice,paymentRows,repaymentRows};};run`,{useAdminStore:()=>data,useMemo,useState,useEffect:()=>{},buildScheduleLedger,isCompletedRepaymentStatus});
 const result=run({open:true,customer:data.customers[0],onClose:()=>{}});
 return {...result,text:result.buildAllNotice(result.paymentRows.map(row=>row.id),result.repaymentRows.map(row=>row.id))};
}
function renderNotice(data){
 const source=fs.readFileSync('components/schedule-notice.tsx','utf8');
 const ast=ts.createSourceFile('notice.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const functions=ast.statements.filter(ts.isFunctionDeclaration).map(node=>node.getText(ast)).join('\n');
 const Component=compile(functions+';ScheduleNoticeModal',{
  useAdminStore:()=>data,useMemo,useState,useEffect:()=>{},buildScheduleLedger,isCompletedRepaymentStatus,
  Modal:({children})=>React.createElement('section',null,children),Button:({children})=>React.createElement('button',null,children),
  RefreshCw:()=>null,Copy:()=>null,Check:()=>null,
 });
 return renderToStaticMarkup(React.createElement(Component,{open:true,customer:data.customers[0],onClose:()=>{}}));
}
function dashboard(data,month='2026-10',selectedRepaymentMonth=month){
 const source=fs.readFileSync('app/(admin)/page.tsx','utf8');
 const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const component=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='Dashboard');
 const body=component.body.statements.filter(node=>!ts.isReturnStatement(node)).map(node=>node.getText(ast)).join('\n');
 let stateIndex=0;
 const run=compile(`function run(){${body}\nreturn {paymentItems,repaymentItems,paymentCalendarItems,repaymentCalendarItems,paymentSummary,repaymentSummary,paymentLedgers,repaymentLedger,accidentIds};};run`,{
  ...revenueApi,...bankApi,useAdminStore:()=>data,useMemo,useState:initial=>useState(++stateIndex===4?selectedRepaymentMonth:initial),buildScheduleLedger,calendarOverdueHistory,isCompletedRepaymentStatus,calendarPaymentRecord,
  monthRange:()=>({start:month+'-01',end:month+'-31'}),today:()=> month+'-17',
  groupBy:(rows,key)=>{const out=new Map();for(const row of rows){const id=key(row);out.set(id,[...(out.get(id)||[]),row]);}return out;},
  duplicateCustomerTag:()=>'',won:value=>String(value),hasRepaymentProblem:()=>false,
  inRange:(date,start,end)=>date>=start&&date<=end,isEformSignedStatus:()=>true,
  customerCredit:()=>0,paymentRemaining:p=>Math.max(0,p.dueAmount-p.paidAmount-(p.allocatedAmount||0)),
 });
 const {paymentLedgers,repaymentLedger,accidentIds,...view}=run();
 assert.equal(view.repaymentSummary.periods.length,2);
 for(const key of ['paid','expected','total'])assert.equal(view.repaymentSummary[key],view.repaymentSummary.periods.reduce((sum,period)=>sum+period[key],0),'repayment monthly '+key+' equals the two half-month rows');
 for(const period of view.repaymentSummary.periods)assert.equal(period.total,period.paid+period.expected,'each half-month combines only actual and pending repayment amounts');
 // Test-only diagnostics retain financial assertions after the dashboard notices were removed.
 const activePaymentLedgers=[...paymentLedgers.entries()].filter(([id])=>!accidentIds.has(id)).map(([,ledger])=>ledger);
 const paymentUndated=activePaymentLedgers.reduce((sum,ledger)=>sum+ledger.totals.undated,0);
 const paymentOverplanned=activePaymentLedgers.reduce((sum,ledger)=>sum+ledger.totals.overplanned,0);
 const activeRepaymentLedger=accidentIds.size?buildScheduleLedger(data.repayments.filter(row=>!accidentIds.has(row.customerId))):repaymentLedger;
 return {...view,paymentUndated,paymentOverplanned,activeRepaymentLedger};
}

function paymentCollection(data){
 const source=fs.readFileSync('app/(admin)/[section]/page.tsx','utf8'),ast=ts.createSourceFile('payments.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const owner=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='Payments');
 const body=owner.body.statements.filter(node=>!ts.isReturnStatement(node)).map(node=>node.getText(ast)).join('\n');
 const metrics=ts.createSourceFile('metrics.ts',fs.readFileSync('lib/payment-metrics.ts','utf8'),ts.ScriptTarget.Latest,true);
 const issue=metrics.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='paymentCompletionIssue').getText(metrics);
 const run=compile(`${issue}\nfunction run(){${body}\nreturn {completed:paymentSearchRows.filter(row=>matchesTab(row,'완료')),pending:paymentSearchRows.filter(row=>matchesTab(row,'예정')),completionIssuePayments,paymentCounts,ledgers};};run`,{
  useAdminStore:()=>data,useMemo,useState,buildScheduleLedger,emptyPayment:()=>({}),emptyNewPaymentRow:()=>({}),
  newestFirst:(a,b)=>b.id.localeCompare(a.id),isEformSignedStatus:()=>true,
 });
 return run();
}

for(const state of ['cancelled','rescheduled','legacy-parent'])test(state+' empty completed history is excluded from receipt counts and missing-completion alerts',()=>{
 const empty=payment('empty',{status:'완료',...(state==='legacy-parent'?{}:{promiseState:state})});
 const rows=[empty,payment('cash',{status:'완료',promiseState:'cancelled',paidAmount:120000,paidDate:'2026-10-16'}),
  payment('recovery',{status:'완료',scheduleType:'환수',paidAmount:240000,paidDate:'2026-10-16'}),
  payment('pending',{status:'예정',promiseState:'active',...(state==='legacy-parent'?{rescheduledFromId:'empty'}:{})})];
 const data=store(rows),before=JSON.stringify(data),view=paymentCollection(data);
 assert.deepEqual(Array.from(view.completed,row=>row.id),['recovery','cash']);
 assert.equal(view.paymentCounts.완료,2);assert.equal(view.paymentCounts.예정,1);assert.equal(view.completionIssuePayments.length,0);
 assert.equal(view.pending[0].id,'pending');assert.equal(view.ledgers.get(customer.id).totals.paid,120000);
 assert.equal(JSON.stringify(data),before);assert.equal(data.payments.length,4);
});

test('active completed rows with missing cash remain visible and require correction',()=>{
 const view=paymentCollection(store([payment('active',{status:'완료',promiseState:'active'})]));
 assert.equal(view.completed[0].id,'active');assert.equal(view.completionIssuePayments[0].id,'active');assert.equal(view.paymentCounts.완료,1);
});

test('historical financial evidence is preserved and only genuine missing receipt fields warn',()=>{
 const data=store([
  payment('cash-no-date',{status:'완료',promiseState:'cancelled',paidAmount:100000}),
  payment('date-no-cash',{status:'완료',promiseState:'rescheduled',paidDate:'2026-10-16'}),
  payment('allocated',{status:'완료',promiseState:'cancelled',allocatedAmount:500000}),
  payment('partial-allocation',{status:'완료',promiseState:'rescheduled',allocatedAmount:100000}),
  payment('refund',{status:'환불',paidAmount:100000,paidDate:'2026-10-16'}),
 ]),before=JSON.stringify(data),view=paymentCollection(data);
 assert.deepEqual(Array.from(view.completed,row=>row.id).sort(),['allocated','cash-no-date','date-no-cash','partial-allocation']);
 assert.deepEqual(Array.from(view.completionIssuePayments,row=>row.id).sort(),['cash-no-date','date-no-cash','partial-allocation']);
 assert.equal(view.ledgers.get(customer.id).totals.paid,100000);assert.equal(view.ledgers.get(customer.id).totals.credit,600000);assert.equal(JSON.stringify(data),before);
});

test('partial overdue keeps a 200,000 receipt on 16 October and a 300,000 current promise',()=>{
 const data=store([payment('original',{paidAmount:200000,paidDate:'2026-10-16'})]);
 const view=dashboard(data);
 assert.equal(view.paymentItems.find(row=>row.id==='paid-original').amount,200000);
 assert.equal(view.paymentItems.find(row=>row.id==='schedule-original').amount,300000);
 assert.equal(view.paymentItems.find(row=>row.id==='schedule-original').status,'연체');
 assert.equal(view.paymentSummary.paid,200000);assert.equal(view.paymentSummary.overdue,300000);
 const text=notice(data).text;
 assert.match(text,/200,000원 ✅ 입금/);assert.match(text,/300,000원/);
 assert.doesNotMatch(text,/부분납부 후 연체|⚠️ 연체|500,000원|✅ 완료/);
});

test('rescheduling keeps an orange zero-amount history alongside the receipt and current promise',()=>{
 const data=store([
  payment('original',{paidAmount:200000,paidDate:'2026-10-16',promiseState:'rescheduled'}),
  payment('new',{dueDate:'2026-10-20',dueAmount:300000,rescheduledFromId:'original',rootScheduleId:'original',scheduleType:'재약정',promiseState:'active',status:'예정'}),
 ]);
 const view=dashboard(data);
 assert.equal(view.paymentItems.length,3);assert.ok(!view.paymentItems.some(row=>row.id==='schedule-original'));
 const history=view.paymentItems.find(row=>row.id==='history-original');assert.equal(history.amount,0);assert.equal(history.date,'2026-10-16');assert.equal(history.history,true);assert.equal(calendarItemTone(history),'orange');assert.match(history.sub,/합계 제외/);
 assert.equal(view.paymentItems.find(row=>row.id==='paid-original').date,'2026-10-16');
 assert.equal(view.paymentItems.find(row=>row.id==='schedule-new').amount,300000);
 assert.equal(view.paymentSummary.paid,200000);assert.equal(view.paymentSummary.expected,300000);assert.equal(view.paymentSummary.overdue,0);
 const text=notice(data).text;
 assert.match(text,/200,000원 ✅ 입금/);assert.match(text,/10월 20일[^\n]*300,000원/);
 assert.doesNotMatch(text,/500,000원/);
});

test('partial replan exposes its undated remainder without creating an invented calendar date',()=>{
 const data=store([
  payment('original',{paidAmount:200000,paidDate:'2026-10-16',promiseState:'rescheduled'}),
  payment('new',{dueDate:'2026-10-20',dueAmount:100000,rescheduledFromId:'original',promiseState:'active',status:'예정'}),
 ]);
 const view=dashboard(data);
 assert.equal(view.paymentUndated,200000);assert.equal(view.paymentSummary.expected,100000);
 assert.equal(view.paymentItems.filter(row=>!row.done&&!row.history).length,1);assert.equal(view.paymentItems.filter(row=>row.history).length,1);
 assert.match(notice(data).text,/남은 납부 금액: 300,000원\n이 중 납부일 미정: 200,000원/);
});

test('cancelled paid promise preserves its receipt and makes unpaid debt undated',()=>{
 const data=store([payment('cancelled',{paidAmount:200000,paidDate:'2026-10-16',promiseState:'cancelled'})]);
 const view=dashboard(data);
 assert.equal(view.paymentItems.length,1);assert.equal(view.paymentItems[0].amount,200000);
 assert.equal(view.paymentUndated,300000);assert.equal(view.paymentSummary.expected,0);
 const text=notice(data).text;assert.match(text,/200,000원 ✅ 입금/);assert.match(text,/이 중 납부일 미정: 300,000원/);
});

test('completed status alone never creates cash or hides remaining debt',()=>{
 const data=store([payment('unpaid',{status:'완료'})]);
 const view=dashboard(data);assert.equal(view.paymentSummary.paid,0);assert.equal(view.paymentSummary.expected,500000);
 assert.equal(view.paymentItems[0].status,'입금 확인 필요');assert.equal(view.paymentItems[0].done,false);
 const text=notice(data).text;assert.doesNotMatch(text,/✅ 입금|✅ 완료/);assert.match(text,/남은 납부 금액: 500,000원/);
});

test('receipt without date remains real cash and is not assigned to a fabricated calendar day',()=>{
 const data=store([payment('undated-cash',{paidAmount:200000})]);
 const view=dashboard(data);assert.equal(view.paymentItems.filter(row=>row.done).length,0);assert.equal(view.paymentSummary.paid,0);
 assert.match(notice(data).text,/입금일 미등록 — 200,000원 ✅ 입금/);assert.match(notice(data).text,/남은 납부 금액: 300,000원/);
});

test('legacy oversized plans keep their entered amounts while actual customer receivable stays separate',()=>{
 const data=store([payment('a',{dueAmount:550000}),payment('b',{dueAmount:550000,dueDate:'2026-10-20'}),payment('c',{dueAmount:930000,dueDate:'2026-10-30'})],[],1650000);
 const view=dashboard(data);assert.equal(view.paymentOverplanned,380000);assert.equal(view.paymentItems.reduce((sum,row)=>sum+row.amount,0),2030000);
 assert.equal(data.payments.reduce((sum,row)=>sum+row.dueAmount,0),2030000);
 assert.match(notice(data).text,/남은 납부 금액: 1,650,000원/);
});

test('legacy child amount above old parent stays valid when it matches the current contract',()=>{
 const data=store([payment('old',{dueAmount:473000}),payment('current',{dueAmount:693000,rescheduledFromId:'old',dueDate:'2026-10-20',status:'예정'})],[],693000);
 const view=dashboard(data);assert.equal(view.paymentOverplanned,0);assert.equal(view.paymentItems.filter(row=>!row.history).length,1);assert.equal(view.paymentItems.find(row=>!row.history).amount,693000);assert.equal(view.paymentItems.find(row=>row.history).amount,0);
 assert.match(notice(data).text,/남은 납부 금액: 693,000원/);
});

test('repayment replan retains 200,000 actual repayment and only 300,000 current lender promise',()=>{
 const common={customerId:customer.id,lenderName:'검증 업체',memo:'',amount:500000,dueDate:'2026-10-16',paidAmount:200000,paidDate:'2026-10-16',status:'연체'};
 const data=store([], [{...common,id:'original',promiseState:'rescheduled'}, {...common,id:'new',amount:300000,paidAmount:0,paidDate:'',dueDate:'2026-10-20',rescheduledFromId:'original',rootScheduleId:'original',promiseState:'active',status:'예정'}]);
 const view=dashboard(data);assert.equal(view.repaymentItems.length,3);assert.equal(view.repaymentItems.find(row=>row.id==='new').amount,300000);assert.equal(view.repaymentItems.find(row=>row.history).amount,0);
 assert.equal(view.repaymentItems.find(row=>row.id==='actual-repayment-original').amount,200000);
 const text=notice(data).text;assert.match(text,/200,000원 ✅ 상환/);assert.match(text,/남은 상환 금액 합계: 300,000원/);assert.doesNotMatch(text,/부분납부 후 연체/);
});

test('fully paid customer keeps cash and old overdue history without a current debt or reminder',()=>{
 const data=store([payment('original',{paidAmount:200000,paidDate:'2026-10-16',promiseState:'rescheduled'}),payment('new',{dueAmount:300000,paidAmount:300000,paidDate:'2026-10-20',dueDate:'2026-10-20',rescheduledFromId:'original',promiseState:'active'})]);
 const view=dashboard(data);assert.equal(view.paymentItems.length,3);assert.equal(view.paymentItems.filter(row=>row.done).length,2);assert.equal(view.paymentItems.filter(row=>row.history).length,1);assert.equal(view.paymentItems.find(row=>row.history).amount,0);assert.equal(view.paymentSummary.paid,500000);assert.equal(view.paymentSummary.expected,0);assert.equal(view.paymentSummary.overdue,0);assert.equal(view.paymentUndated,0);
 const result=notice(data);assert.match(result.text,/남은 납부 금액: 0원/);assert.match(result.buildInstallmentNotice('d1'),/미완료 분납 일정이 등록되어 있지 않습니다/);
});

for(const frozen of [true,false]){
 test(`${frozen?'frozen':'legacy'} historical receipt reduces actual debt without changing either entered plan`,()=>{
  const baseline=[
   payment('parent-a',{dueAmount:300000,paidAmount:0,promiseState:'rescheduled',obligationAmount:frozen?300000:undefined}),
   payment('child-a',{dueAmount:300000,paidAmount:0,promiseState:'active',rescheduledFromId:'parent-a',rootScheduleId:'parent-a',dueDate:'2026-10-20'}),
   payment('independent-b',{dueAmount:200000,paidAmount:0,promiseState:'active',dueDate:'2026-11-20',obligationAmount:frozen?200000:undefined}),
  ];
  const drafts=baseline.map(row=>row.id==='parent-a'?{...row,paidAmount:100000,paidDate:'2026-10-17'}:{...row});
  const {before,after}=previewScheduleLedger(baseline,drafts,{},[],500000);
  assert.equal(before.totals.remaining,500000);assert.equal(after.totals.remaining,400000);
  assert.equal(after.byId.get('child-a').remaining,300000);assert.equal(after.byId.get('independent-b').remaining,200000);
  assert.equal(after.totals.paid,100000);assert.equal(after.totals.planned,500000);assert.equal(after.totals.overplanned,100000);
  assert.equal(baseline[0].paidAmount,0);
 });
}

test('a saved zero-value promise can use unassigned contract debt without increasing receivable',()=>{
 const baseline=[payment('empty',{dueAmount:0,obligationAmount:0,promiseState:'active',status:'예정'})];
 const {before,after}=previewScheduleLedger(baseline,[{...baseline[0],dueAmount:100000}],{},[],500000);
 assert.equal(before.totals.unassigned,500000);assert.equal(after.totals.remaining,500000);
 assert.equal(after.byId.get('empty').remaining,100000);assert.equal(after.totals.unassigned,400000);assert.equal(after.totals.overplanned,0);
});

const repayment=(id,patch={})=>({id,customerId:customer.id,lenderName:'검증 업체',memo:'',amount:500000,dueDate:'2026-10-16',paidAmount:0,paidDate:'',status:'연체',...patch});
const itemsFor=(view,kind)=>kind==='payment'?view.paymentItems:view.repaymentItems;
const storeFor=(kind,rows)=>kind==='payment'?store(rows):store([],rows);
const moneyTotal=rows=>rows.reduce((sum,row)=>sum+row.amount,0);

test('repayment monthly summary counts a partial receipt and its current remaining promise once each',()=>{
 const data=store([], [repayment('partial',{status:'예정',paidAmount:200000,paidDate:'2026-10-17'})]),before=JSON.stringify(data),view=dashboard(data);
 assert.equal(view.repaymentSummary.paid,200000);assert.equal(view.repaymentSummary.expected,300000);assert.equal(view.repaymentSummary.total,500000);
 assert.deepEqual(Array.from(view.repaymentCalendarItems,row=>[row.id,row.amount]),[['partial',300000],['actual-repayment-partial',200000]]);
 assert.equal(view.activeRepaymentLedger.totals.remaining,300000);assert.equal(JSON.stringify(data),before);
});

test('repayment half-month rows split the 15th and 16th using actual cash dates separately from due dates',()=>{
 const data=store([], [
  repayment('first-half-due',{status:'예정',amount:500000,dueDate:'2026-10-15',paidAmount:200000,paidDate:'2026-10-16'}),
  repayment('second-half-due',{status:'예정',amount:700000,dueDate:'2026-10-16',paidAmount:100000,paidDate:'2026-10-15'}),
 ]),before=JSON.stringify(data),view=dashboard(data);
 assert.deepEqual(Array.from(view.repaymentSummary.periods,period=>({...period})),[
  {label:'1~15일',paid:100000,expected:300000,total:400000},
  {label:'16~31일',paid:200000,expected:600000,total:800000},
 ]);
 assert.equal(view.repaymentSummary.paid,300000);assert.equal(view.repaymentSummary.expected,900000);assert.equal(view.repaymentSummary.total,1200000);
 assert.equal(JSON.stringify(data),before);
});

for(const [month,lastDay,nextMonth] of [['2026-02',28,'2026-03'],['2028-02',29,'2028-03'],['2026-04',30,'2026-05'],['2026-10',31,'2026-11']])test('repayment half-month table includes the '+lastDay+'-day month end of '+month+' and excludes the next month',()=>{
 const endDate=month+'-'+lastDay,data=store([], [
  repayment('month-end',{status:'예정',amount:500000,dueDate:endDate,paidAmount:200000,paidDate:endDate}),
  repayment('first-half',{status:'예정',amount:100000,dueDate:month+'-15'}),
  repayment('next-month',{status:'예정',amount:900000,dueDate:nextMonth+'-01',paidAmount:400000,paidDate:nextMonth+'-01'}),
 ]),before=JSON.stringify(data),view=dashboard(data,month);
 assert.deepEqual(Array.from(view.repaymentSummary.periods,period=>({...period})),[
  {label:'1~15일',paid:0,expected:100000,total:100000},
  {label:'16~'+lastDay+'일',paid:200000,expected:300000,total:500000},
 ]);
 assert.equal(view.repaymentSummary.paid,200000);assert.equal(view.repaymentSummary.expected,400000);assert.equal(view.repaymentSummary.total,600000);
 assert.ok(view.repaymentCalendarItems.every(row=>row.date.startsWith(month)));assert.equal(JSON.stringify(data),before);
});

for(const [repaymentMonth,lastDay] of [['2026-02',28],['2028-02',29]])test('separate payment and repayment selections keep October and '+repaymentMonth+' amounts and month-end labels independent',()=>{
 const endDate=repaymentMonth+'-'+lastDay,data=store([
  payment('october-payment',{status:'예정',dueAmount:500000,paidAmount:200000,paidDate:'2026-10-17'}),
 ],[
  repayment('february-repayment',{status:'예정',amount:500000,dueDate:endDate,paidAmount:200000,paidDate:endDate}),
  repayment('october-repayment',{status:'예정',amount:300000,dueDate:'2026-10-16',paidAmount:100000,paidDate:'2026-10-17'}),
 ]),before=JSON.stringify(data),octoberPayments=dashboard(data,'2026-10',repaymentMonth),octoberRepayments=dashboard(data,repaymentMonth,'2026-10');
 assert.equal(octoberPayments.paymentSummary.paid,200000);assert.equal(octoberPayments.paymentSummary.expected,300000);assert.equal(octoberPayments.paymentSummary.periods[1].label,'16~31일');
 assert.equal(octoberPayments.repaymentSummary.paid,200000);assert.equal(octoberPayments.repaymentSummary.expected,300000);assert.equal(octoberPayments.repaymentSummary.periods[1].label,'16~'+lastDay+'일');
 assert.equal(octoberRepayments.paymentSummary.paid,0);assert.equal(octoberRepayments.paymentSummary.expected,0);assert.equal(octoberRepayments.paymentSummary.periods[1].label,'16~'+lastDay+'일');
 assert.equal(octoberRepayments.repaymentSummary.paid,100000);assert.equal(octoberRepayments.repaymentSummary.expected,200000);assert.equal(octoberRepayments.repaymentSummary.periods[1].label,'16~31일');
 assert.equal(JSON.stringify(data),before);
});

for(const [dueDate,paidDate] of [['2026-10-16','2026-11-01'],['2026-11-16','2026-10-17']])test('repayment summary separates the promised month '+dueDate+' from actual cash date '+paidDate,()=>{
 const data=store([], [repayment('cross-month',{status:'예정',dueDate,paidAmount:200000,paidDate})]),before=JSON.stringify(data);
 for(const month of ['2026-10','2026-11']){
  const view=dashboard(data,month),paid=paidDate.startsWith(month)?200000:0,expected=dueDate.startsWith(month)?300000:0;
  assert.equal(view.repaymentSummary.paid,paid);assert.equal(view.repaymentSummary.expected,expected);assert.equal(view.repaymentSummary.total,paid+expected);
  assert.equal(view.repaymentCalendarItems.filter(row=>row.id==='actual-repayment-cross-month').length,paid?1:0);
 }
 assert.equal(JSON.stringify(data),before);
});

for(const status of ['상환완료','종결','완료'])test('registered '+status+' alone contributes neither cash nor a pending repayment to the summary',()=>{
 const data=store([], [repayment('status-only',{status})]),before=JSON.stringify(data),view=dashboard(data);
 assert.equal(view.repaymentSummary.paid,0);assert.equal(view.repaymentSummary.expected,0);assert.equal(view.repaymentSummary.total,0);
 assert.equal(view.repaymentCalendarItems.length,1);assert.equal(view.repaymentCalendarItems[0].amount,0);assert.equal(view.repaymentCalendarItems[0].done,true);
 assert.equal(view.activeRepaymentLedger.totals.remaining,500000);assert.equal(JSON.stringify(data),before);
});

for(const promiseState of ['cancelled','rescheduled',undefined])test('repayment summary preserves '+(promiseState||'legacy replaced')+' cash and excludes the old promise',()=>{
 const data=store([], [
  repayment('old',{status:'연체',paidAmount:200000,paidDate:'2026-10-17',promiseState}),
  repayment('current',{status:'예정',amount:300000,dueDate:'2026-11-20',rescheduledFromId:'old',promiseState:'active'}),
 ]),before=JSON.stringify(data),october=dashboard(data),november=dashboard(data,'2026-11');
 assert.equal(october.repaymentSummary.paid,200000);assert.equal(october.repaymentSummary.expected,0);assert.equal(october.repaymentSummary.total,200000);
 assert.equal(november.repaymentSummary.paid,0);assert.equal(november.repaymentSummary.expected,300000);assert.equal(november.repaymentSummary.total,300000);
 assert.equal(october.activeRepaymentLedger.totals.remaining,300000);assert.equal(JSON.stringify(data),before);
});

for(const paidAmount of [0,200000])test('repayment collection balance stays outside expected cash while its actual receipt '+paidAmount+' remains included',()=>{
 const data=store([], [
  repayment('collection',{status:'추심',paidAmount,paidDate:paidAmount?'2026-10-17':''}),
  repayment('pending',{status:'예정',amount:100000}),
 ]),before=JSON.stringify(data),view=dashboard(data);
 assert.equal(view.repaymentSummary.paid,paidAmount);assert.equal(view.repaymentSummary.expected,100000);assert.equal(view.repaymentSummary.total,paidAmount+100000);
 assert.equal(view.repaymentCalendarItems.find(row=>row.id==='collection').amount,500000-paidAmount,'collections remain visible even though their balances are excluded from the summary');
 assert.equal(view.activeRepaymentLedger.totals.remaining,600000-paidAmount);assert.equal(JSON.stringify(data),before);
});

test('repayment summary uses only visible pending balances while retaining real cash from hidden overdue schedules',()=>{
 const data=store([], [
  repayment('overdue',{status:'연체',paidAmount:200000,paidDate:'2026-10-17'}),
  repayment('legacy-partial',{status:'부분납부 후 연체',amount:80000}),
  repayment('unpaid',{status:'미납',amount:70000}),repayment('pending',{status:'예정',amount:90000}),
 ]),before=JSON.stringify(data),view=dashboard(data);
 assert.equal(view.repaymentSummary.paid,200000);assert.equal(view.repaymentSummary.expected,160000);assert.equal(view.repaymentSummary.total,360000);
 assert.equal(view.repaymentCalendarItems.some(row=>row.id==='overdue'||row.id==='legacy-partial'),false);
 assert.equal(view.activeRepaymentLedger.totals.remaining,540000);assert.equal(JSON.stringify(data),before);
});

test('repayment summary excludes an accident customer cash and promises without dropping other customers',()=>{
 const data=store([], [
  repayment('normal',{status:'예정',paidAmount:200000,paidDate:'2026-10-17'}),
  repayment('accident',{customerId:'accident',status:'예정',paidAmount:100000,paidDate:'2026-10-17'}),
 ]);
 data.customers.push({...customer,id:'accident',name:'사고 검증 고객',isAccident:true});
 const before=JSON.stringify(data),view=dashboard(data);
 assert.equal(view.repaymentSummary.paid,200000);assert.equal(view.repaymentSummary.expected,300000);assert.equal(view.repaymentSummary.total,500000);
 assert.equal(view.repaymentCalendarItems.length,2);assert.ok(view.repaymentCalendarItems.every(row=>!row.id.includes('accident')));assert.equal(JSON.stringify(data),before);
});

test('repayment summary does not invent dates or money for zero amounts and undated records',()=>{
 const data=store([], [
  repayment('zero',{status:'예정',amount:0}),
  repayment('undated-promise',{status:'예정',dueDate:'',paidAmount:100000,paidDate:'2026-10-17'}),
  repayment('undated-cash',{status:'예정',paidAmount:200000,paidDate:''}),
  repayment('fully-undated',{status:'예정',dueDate:'',paidAmount:50000,paidDate:''}),
 ]),before=JSON.stringify(data),view=dashboard(data);
 assert.equal(view.repaymentSummary.paid,100000);assert.equal(view.repaymentSummary.expected,300000);assert.equal(view.repaymentSummary.total,400000);
 assert.equal(view.repaymentCalendarItems.filter(row=>row.done&&!row.history).length,1);assert.equal(view.repaymentCalendarItems.find(row=>row.id==='actual-repayment-undated-promise').date,'2026-10-17');
 assert.equal(view.activeRepaymentLedger.totals.paid,350000);assert.equal(JSON.stringify(data),before);
});

for(const kind of ['payment','repayment']){
 const create=kind==='payment'?payment:repayment,amountKey=kind==='payment'?'dueAmount':'amount';
 test(kind+' cross-month replan keeps overdue history on the original date and cash on its receipt date',()=>{
  const rows=[create('original',{paidAmount:200000,paidDate:'2026-10-17',promiseState:'rescheduled'}),create('future',{[amountKey]:300000,paidAmount:0,paidDate:'',dueDate:'2026-11-20',rescheduledFromId:'original',promiseState:'active',status:'예정'})];
  const data=storeFor(kind,rows),october=dashboard(data),november=dashboard(data,'2026-11');
  const old=itemsFor(october,kind),future=itemsFor(november,kind);
  assert.equal(old.length,2);assert.equal(old.find(row=>row.history).date,'2026-10-16');assert.equal(old.find(row=>row.done).date,'2026-10-17');
  assert.equal(calendarItemTone(old.find(row=>row.history)),'orange');assert.equal(calendarItemTone(old.find(row=>row.done)),'gray');assert.equal(moneyTotal(old),200000);
  assert.equal(future.length,1);assert.equal(future[0].date,'2026-11-20');assert.equal(future[0].amount,300000);assert.equal(calendarItemTone(future[0]),'blue');
  if(kind==='payment'){assert.equal(october.paymentSummary.paid,200000);assert.equal(october.paymentSummary.expected,0);assert.equal(october.paymentSummary.overdue,0);assert.equal(november.paymentSummary.expected,300000);assert.equal(november.paymentSummary.paid,0);}
  const text=notice(data).text;assert.match(text,/11월 20일[^\n]*300,000원/);assert.doesNotMatch(text,/연체 이력|금액 확인 필요|합계 제외/);
 });
 test(kind+' multiple legacy generations keep distinct zero-money overdue history without repeating debt',()=>{
  const rows=[create('first',{dueDate:'2026-10-01',status:'미납',promiseState:null}),create('second',{dueDate:'2026-10-16',status:'부분납부 후 연체',rescheduledFromId:'first',promiseState:null}),create('last',{dueDate:'2026-11-01',status:'예정',rescheduledFromId:'second',rootScheduleId:'first',promiseState:null})];
  const data=storeFor(kind,rows),view=dashboard(data),items=itemsFor(view,kind);
  assert.deepEqual(Array.from(items,row=>row.date).sort(),['2026-10-01','2026-10-16']);
  assert.ok(items.every(row=>row.history&&row.amount===0&&calendarItemTone(row)==='orange'));assert.equal(moneyTotal(items),0);
  assert.equal(itemsFor(dashboard(data,'2026-11'),kind)[0].amount,500000);
  if(kind==='payment'){assert.equal(view.paymentSummary.expected,0);assert.equal(view.paymentSummary.overdue,0);assert.equal(view.paymentUndated,0);}
  else assert.equal(view.activeRepaymentLedger.totals.remaining,500000);
  const text=notice(data).text;assert.match(text,/11월 0?1일[^\n]*500,000원/);assert.doesNotMatch(text,/10월 0?1일|10월 16일|연체 이력/);
 });
 test(kind+' settled descendants preserve the old registered overdue history but no current promise',()=>{
  const rows=[create('original',{paidAmount:200000,paidDate:'2026-10-16',promiseState:'rescheduled'}),create('settled',{[amountKey]:300000,paidAmount:300000,paidDate:'2026-11-01',dueDate:'2026-11-01',rescheduledFromId:'original',promiseState:'active'})];
  const data=storeFor(kind,rows),october=dashboard(data),november=dashboard(data,'2026-11'),old=itemsFor(october,kind),current=itemsFor(november,kind);
  assert.equal(old.filter(row=>row.history).length,1);assert.equal(old.find(row=>row.history).amount,0);assert.equal(calendarItemTone(old.find(row=>row.history)),'orange');
  assert.equal(current.length,1);assert.equal(current[0].done,true);assert.equal(current[0].amount,300000);assert.equal(calendarItemTone(current[0]),'gray');
  if(kind==='payment'){assert.equal(october.paymentSummary.overdue,0);assert.equal(october.paymentSummary.expected,0);assert.equal(november.paymentSummary.expected,0);assert.equal(november.paymentUndated,0);}
  else assert.equal(november.activeRepaymentLedger.totals.remaining,0);
  assert.match(notice(data).text,kind==='payment'?/남은 납부 금액: 0원/:/남은 상환 금액 합계: 0원/);
 });
 for(const exclusion of ['cancelled','pending','no-date','accident'])test(kind+' '+exclusion+' does not produce a false overdue-history calendar item',()=>{
  const original=create('original',{promiseState:'rescheduled',...(exclusion==='cancelled'?{promiseState:'cancelled'}:exclusion==='pending'?{status:'예정'}:exclusion==='no-date'?{dueDate:''}:{})});
  const data=storeFor(kind,[original,create('child',{status:'예정',rescheduledFromId:'original',dueDate:'2026-11-01'})]);if(exclusion==='accident')data.customers[0].isAccident=true;
  const items=itemsFor(dashboard(data),kind);
  if(kind==='payment'&&exclusion==='pending'){assert.equal(items.length,1);assert.equal(items[0].amount,0);assert.equal(items[0].history,true);assert.equal(calendarItemTone(items[0]),'blue');}
  else assert.equal(items.length,0);
 });
 test(kind+' a paid-in-full row never becomes unpaid history even if its registered status is overdue',()=>{
  const data=storeFor(kind,[create('paid',{paidAmount:500000,paidDate:'2026-10-16',status:'연체'})]),view=dashboard(data),items=itemsFor(view,kind);
  assert.equal(items.length,1);assert.equal(items[0].done,true);assert.equal(items[0].amount,500000);assert.equal(calendarItemTone(items[0]),'gray');
 });
}

for(const promiseState of ['rescheduled',null])test('replaced pending records '+String(promiseState)+' hide on 19 October while both new entered promises stay visible',()=>{
 const rows=[
  payment('old-a',{customerId:'a',dueDate:'2026-10-19',dueAmount:352000,status:'예정',promiseState}),
  payment('next-a',{customerId:'a',dueDate:'2026-10-20',dueAmount:352000,status:'예정',rescheduledFromId:'old-a'}),
  payment('old-b',{customerId:'b',dueDate:'2026-10-19',dueAmount:815000,status:'예정',promiseState}),
  payment('next-b',{customerId:'b',dueDate:'2026-10-22',dueAmount:815000,status:'예정',rescheduledFromId:'old-b'}),
 ];
 const data=store(rows,[],1167000);data.customers=[{...customer,id:'a',name:'테스트 고객 가',contractAmount:352000},{...customer,id:'b',name:'테스트 고객 나',contractAmount:815000}];
 const before=JSON.stringify(data),view=dashboard(data),items=view.paymentCalendarItems;
 const originals=view.paymentItems.filter(row=>row.history);assert.equal(originals.length,2);
 for(const row of originals){assert.equal(row.status,'이전 예정');assert.equal(row.registeredStatus,'예정');assert.equal(row.amount,0);}
 assert.equal(items.length,2);assert.ok(items.every(row=>!row.history&&row.registeredStatus==='예정'));
 assert.deepEqual(Array.from(items,row=>[row.date,row.amount]),[['2026-10-20',352000],['2026-10-22',815000]]);
 for(const pinned of [false,true]){
  const html=renderRepaymentDay(items,'2026-10-20',pinned,'blue');assert.doesNotMatch(html,/이전 예정|재약정 전 이력|등록 잔액|합계 제외/);assert.match(html,/남은 금액 352000/);assert.match(html,/남은 금액 815000/);
 }
 assert.equal(view.paymentSummary.expected,1167000);assert.equal(view.paymentSummary.paid,0);assert.equal(view.paymentSummary.overdue,0);assert.equal(view.paymentUndated,0);
 assert.equal(buildScheduleLedger(rows,1167000).totals.remaining,1167000);assert.equal(JSON.stringify(data),before);
});

for(const kind of ['payment','repayment'])for(const retiredStatus of ['예정','미납'])test(kind+' hides replaced '+retiredStatus+' markers while keeping current unpaid, actual cash and gray completion',()=>{
 const create=kind==='payment'?payment:repayment,amountKey=kind==='payment'?'dueAmount':'amount',tone=kind==='payment'?'blue':'amber';
 const rows=[
  create('old',{status:retiredStatus,[amountKey]:352000,dueDate:'2026-10-19',paidAmount:52000,paidDate:'2026-10-19',promiseState:'rescheduled'}),
  create('next',{status:'예정',[amountKey]:300000,dueDate:'2026-10-20',rescheduledFromId:'old'}),
  create('current-unpaid',{status:'미납',[amountKey]:17000,dueDate:'2026-10-21'}),
  create('settled',{status:kind==='payment'?'완료':'상환완료',[amountKey]:815000,dueDate:'2026-10-19',paidAmount:815000,paidDate:'2026-10-22'}),
 ];
 const data=kind==='payment'?store(rows,[],1184000):store([],rows),before=JSON.stringify(data),view=dashboard(data),items=kind==='payment'?view.paymentCalendarItems:view.repaymentCalendarItems;
 const raw=itemsFor(view,kind);if(kind==='payment'||retiredStatus==='미납')assert.ok(raw.some(row=>row.id==='history-old'));
 assert.ok(!items.some(row=>row.id==='history-old'));assert.equal(items.find(row=>row.registeredStatus==='예정'&&!row.done).amount,300000);assert.equal(items.find(row=>row.registeredStatus==='미납').amount,17000);
 const cashPrefix=kind==='payment'?'paid-':'actual-repayment-';assert.equal(items.find(row=>row.id===cashPrefix+'old').amount,52000);assert.equal(items.find(row=>row.id===cashPrefix+'settled').amount,815000);
 assert.ok(items.some(row=>row.done&&row.history&&row.amount===0&&calendarItemTone(row)==='gray'));
 for(const pinned of [false,true]){
  const html=renderRepaymentDay(items,'2026-10-19',pinned,tone);assert.doesNotMatch(html,/이전 예정|연체 이력|재약정 전 이력/);assert.match(html,/남은 금액 300000/);assert.match(html,/남은 금액 17000/);assert.match(html,kind==='payment'?/실입금 52000/:/실상환 52000/);assert.match(html,kind==='payment'?/실입금 815000/:/실상환 815000/);
 }
 if(kind==='payment'){assert.equal(view.paymentSummary.expected,300000);assert.equal(view.paymentSummary.overdue,17000);assert.equal(view.paymentSummary.paid,867000);assert.equal(view.paymentUndated,0);}
 else assert.equal(view.activeRepaymentLedger.totals.remaining,317000);
 assert.equal(buildScheduleLedger(rows,kind==='payment'?1184000:undefined).totals.remaining,317000);assert.equal(JSON.stringify(data),before);
});

test('overdue promises retain entered amounts while zero-value records contribute no money',()=>{
 const data=store([payment('covered',{dueDate:'2026-10-01',status:'예정'}),payment('capped',{dueAmount:200000}),payment('empty',{dueAmount:0})]),view=dashboard(data);
 assert.equal(view.paymentItems.length,3);const marker=view.paymentItems.find(row=>row.id==='schedule-capped');
 assert.equal(marker.status,'연체');assert.equal(marker.amount,200000);assert.equal(calendarItemTone(marker),'orange');
 assert.equal(view.paymentItems.find(row=>row.id==='history-empty').amount,0);
 assert.equal(view.paymentOverplanned,200000);assert.equal(view.paymentSummary.expected,500000);assert.equal(view.paymentSummary.overdue,200000);assert.equal(moneyTotal(view.paymentItems),700000);
 assert.equal(buildScheduleLedger(data.payments,500000).totals.remaining,500000);
 assert.doesNotMatch(notice(data).text,/금액 확인 필요|연체 이력/);
});

test('an entered overdue promise remains visible even when the actual customer contract is zero',()=>{
 const data=store([payment('unallocated')],[],0),view=dashboard(data);assert.equal(view.paymentItems.length,1);
 assert.equal(view.paymentItems[0].status,'연체');assert.equal(view.paymentItems[0].amount,500000);assert.equal(calendarItemTone(view.paymentItems[0]),'orange');
 assert.equal(view.paymentSummary.expected,0);assert.equal(view.paymentSummary.overdue,500000);assert.equal(view.paymentUndated,0);assert.match(notice(data).text,/남은 납부 금액: 0원/);
 assert.equal(buildScheduleLedger(data.payments,0).totals.remaining,0);
});

test('repayment amounts are never capped by a historical family while actual lender debt stays fixed',()=>{
 const data=store([], [repayment('root',{promiseState:'rescheduled',status:'예정'}),repayment('covered',{rescheduledFromId:'root',dueDate:'2026-10-01',status:'예정'}),repayment('capped',{rescheduledFromId:'root',amount:200000}),repayment('empty',{rescheduledFromId:'root',amount:0})]);
 const view=dashboard(data);assert.equal(view.repaymentItems.length,2);const marker=view.repaymentItems.find(row=>row.id==='capped');
 assert.equal(marker.status,'연체');assert.equal(marker.amount,200000);assert.equal(calendarItemTone(marker),'orange');assert.equal(moneyTotal(view.repaymentItems),700000);assert.equal(view.activeRepaymentLedger.totals.remaining,500000);
 assert.doesNotMatch(notice(data).text,/금액 확인 필요|연체 이력/);
});

test('refund and recovery records do not acquire overdue-history markers',()=>{
 const data=store([payment('refunded',{status:'환불',promiseState:'rescheduled',paidAmount:200000,paidDate:'2026-10-16'}),payment('recovery',{scheduleType:'환수',promiseState:'rescheduled',dueAmount:200000})]);
 const items=dashboard(data).paymentItems;assert.ok(items.every(row=>!row.history));assert.ok(!items.some(row=>row.id.includes('refunded')));
});

function renderRepaymentDay(items,day,pinned=false,tone='amber',summary){
 const source=fs.readFileSync('app/(admin)/page.tsx','utf8'),ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const calendar=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='MonthCalendar');let hook=0;
 const component=compile(calendar.getText(ast)+';MonthCalendar',{
  calendarItemTone,useState:initial=>[++hook===2&&pinned?{date:day,rows:items.filter(row=>row.date===day),top:0,left:0}:initial,()=>{}],
  Card:props=>React.createElement('section',props),CalendarDays:()=>null,
  today:()=>day,shiftMonth:()=>day.slice(0,7),won:String,sortPaymentDayItems:rows=>rows,isLatePaymentItem:row=>!row.done&&(row.status==='연체'||row.status==='미납'),
 });
 return renderToStaticMarkup(React.createElement(component,{title:tone==='amber'?'상환 캘린더':'분납 캘린더',month:day.slice(0,7),onMonthChange:()=>{},items,tone,summary}));
}

for(const [tone,paidLabel,expectedLabel] of [['blue','이번 달 입금액','받을 예정 금액'],['amber','이번 달 상환액','상환 예정 금액']])test('the '+tone+' calendar renders its three summary amounts with the matching financial labels',()=>{
 const html=renderRepaymentDay([],'2026-10-17',false,tone,{paid:120001,expected:300002,total:420003}),text=html.replace(/<[^>]*>/g,'');
 assert.match(text,new RegExp(paidLabel+'120001'));assert.match(text,new RegExp(expectedLabel+'300002'));assert.match(text,/합산 금액420003/);
 assert.doesNotMatch(html,/<table\b/,'a monthly summary without periods does not create an invented period breakdown');
});

for(const [tone,headers,periods,expectedRows] of [
 ['blue',['기간','입금','출금','순입금액','받을 예정','합산'],[
  {label:'1~15일',inflow:100,outflow:150,paid:-50,expected:20,total:-30},
  {label:'16~31일',inflow:200,outflow:0,paid:200,expected:70,total:270},
 ],[['1~15일','100','150','-50','20','-30'],['16~31일','200','0','200','70','270']]],
 ['amber',['기간','상환액','상환예정','합산'],[
  {label:'1~15일',paid:70,expected:300,total:370},
  {label:'16~31일',paid:120,expected:400,total:520},
 ],[['1~15일','70','300','370'],['16~31일','120','400','520']]],
])test('the '+tone+' calendar renders two half-month rows with '+headers.length+' aligned financial columns',()=>{
 const summary={paid:periods.reduce((sum,period)=>sum+period.paid,0),expected:periods.reduce((sum,period)=>sum+period.expected,0),total:periods.reduce((sum,period)=>sum+period.total,0),periods};
 const html=renderRepaymentDay([],'2026-10-17',false,tone,summary);
 const table=Array.from(html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g),match=>match[0]).find(table=>table.includes('기간'));
 assert.ok(table);const head=table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/)[1],body=table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/)[1];
 const cells=row=>Array.from(row.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/g),match=>match[1].replace(/<[^>]*>/g,''));
 assert.deepEqual(cells(head),headers);
 const rows=Array.from(body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g),match=>cells(match[1]));
 assert.equal(rows.length,2);assert.deepEqual(rows,expectedRows);assert.ok(rows.every(row=>row.length===headers.length));
 assert.doesNotMatch(table,/연체·미납/);
});

for(const status of ['상환완료','종결','완료'])test(status+' repayment with no recorded cash remains gray on its original date without inventing cash',()=>{
 const data=store([], [repayment('done',{status,paidAmount:0,paidDate:''})]),before=JSON.stringify(data),view=dashboard(data),items=view.repaymentItems;
 assert.equal(items.length,1);const marker=items[0];assert.equal(marker.id,'completion-done');assert.equal(marker.date,'2026-10-16');assert.equal(marker.done,true);assert.equal(marker.history,true);assert.equal(marker.amount,0);assert.equal(calendarItemTone(marker),'gray');
 assert.equal(marker.status,status==='완료'?'상환완료':status);assert.equal(marker.registeredStatus,status);assert.match(marker.sub,/합계 제외/);assert.doesNotMatch(marker.status,/확인 필요/);
 assert.equal(view.activeRepaymentLedger.totals.paid,0);assert.equal(view.activeRepaymentLedger.totals.remaining,500000);assert.equal(JSON.stringify(data),before);
 const text=notice(data).text;assert.doesNotMatch(text,/500,000원 ✅ 상환|잔액 확인 필요/);assert.match(text,new RegExp('✅ '+(status==='종결'?'종결':'상환완료')));assert.match(text,/남은 상환 금액 합계: 0원/);
 const cell=renderRepaymentDay(items,'2026-10-16'),popup=renderRepaymentDay(items,'2026-10-16',true);
 assert.match(cell,/bg-slate-200 text-slate-500/);assert.match(popup,/border-slate-200 bg-slate-100 text-slate-500/);assert.doesNotMatch(popup,/type="checkbox"/);
 assert.match(popup.replace(/<[^>]*>/g,''),/상환 총합\s*0/);assert.doesNotMatch(popup.replace(/<[^>]*>/g,''),/상환 총합\s*500000/);
});

test('completed partial repayment keeps the actual 200,000 receipt but no blue 300,000 current item',()=>{
 const data=store([], [repayment('partial-done',{status:'상환완료',paidAmount:200000,paidDate:'2026-10-16'})]),before=JSON.stringify(data),view=dashboard(data),items=view.repaymentItems;
 assert.equal(items.length,2);assert.equal(items.find(row=>row.id==='completion-partial-done').amount,0);assert.equal(items.find(row=>row.id==='actual-repayment-partial-done').amount,200000);assert.ok(items.every(row=>row.done&&calendarItemTone(row)==='gray'));
 assert.equal(moneyTotal(items),200000);assert.equal(view.activeRepaymentLedger.totals.remaining,300000);assert.equal(JSON.stringify(data),before);
 const popup=renderRepaymentDay(items,'2026-10-16',true);assert.match(popup.replace(/<[^>]*>/g,''),/상환 총합\s*200000/);assert.doesNotMatch(popup,/type="checkbox"/);
});

for(const paidAmount of [500000,600000])test('same-day completed cash '+paidAmount+' suppresses only its redundant original-date marker',()=>{
 const data=store([], [repayment('done',{status:'상환완료',paidAmount,paidDate:'2026-10-16'})]),view=dashboard(data);
 assert.equal(view.repaymentItems.length,1);assert.equal(view.repaymentItems[0].id,'actual-repayment-done');assert.equal(view.repaymentItems[0].amount,paidAmount);assert.equal(view.repaymentItems[0].date,'2026-10-16');assert.equal(calendarItemTone(view.repaymentItems[0]),'gray');
});

for(const paidDate of ['2026-10-17','2026-11-01'])test('completed repayment retains distinct original and actual dates when paid on '+paidDate,()=>{
 const data=store([], [repayment('dated-done',{status:'상환완료',paidAmount:500000,paidDate})]),before=JSON.stringify(data),october=dashboard(data),cashMonth=dashboard(data,paidDate.slice(0,7));
 const marker=october.repaymentItems.find(row=>row.id==='completion-dated-done'),actual=cashMonth.repaymentItems.find(row=>row.id==='actual-repayment-dated-done');
 assert.ok(marker);assert.equal(marker.date,'2026-10-16');assert.equal(marker.amount,0);assert.equal(calendarItemTone(marker),'gray');assert.equal(actual.date,paidDate);assert.equal(actual.amount,500000);assert.equal(calendarItemTone(actual),'gray');
 assert.equal(october.repaymentItems.length,paidDate.startsWith('2026-10')?2:1);assert.equal(cashMonth.repaymentItems.filter(row=>row.id.startsWith('actual-')).length,1);assert.equal(JSON.stringify(data),before);
});

for(const paidAmount of [0,200000,500000])test('completed repayment with missing paid date and cash '+paidAmount+' keeps its gray original-date marker',()=>{
 const data=store([], [repayment('undated-done',{status:'상환완료',paidAmount,paidDate:''})]),view=dashboard(data);
 assert.equal(view.repaymentItems.length,1);assert.equal(view.repaymentItems[0].id,'completion-undated-done');assert.equal(view.repaymentItems[0].date,'2026-10-16');assert.equal(view.repaymentItems[0].amount,0);assert.equal(calendarItemTone(view.repaymentItems[0]),'gray');
 assert.equal(view.activeRepaymentLedger.totals.paid,paidAmount);assert.equal(view.activeRepaymentLedger.totals.remaining,500000-paidAmount);assert.equal(data.repayments[0].paidDate,'');
});

test('zero-amount closed repayment is visible as a gray marker with no cash event or debt',()=>{
 const data=store([], [repayment('closed',{status:'종결',amount:0,paidAmount:0,paidDate:'2026-10-16'})]),view=dashboard(data);
 assert.equal(view.repaymentItems.length,1);assert.equal(view.repaymentItems[0].id,'completion-closed');assert.equal(view.repaymentItems[0].status,'종결');assert.equal(view.repaymentItems[0].amount,0);assert.equal(calendarItemTone(view.repaymentItems[0]),'gray');assert.equal(view.activeRepaymentLedger.totals.remaining,0);
});

for(const promiseState of ['rescheduled',null])test('completed '+String(promiseState)+' parent stays gray while its new promise remains blue',()=>{
 const data=store([], [repayment('parent',{status:'상환완료',paidAmount:200000,paidDate:'2026-10-16',promiseState}),repayment('next',{amount:300000,status:'예정',dueDate:'2026-10-20',rescheduledFromId:'parent',promiseState:'active'})]),view=dashboard(data),items=view.repaymentItems;
 assert.equal(items.length,3);assert.equal(items.find(row=>row.id==='completion-parent').amount,0);assert.equal(calendarItemTone(items.find(row=>row.id==='completion-parent')),'gray');assert.equal(items.find(row=>row.id==='next').amount,300000);assert.equal(calendarItemTone(items.find(row=>row.id==='next')),'blue');assert.equal(items.find(row=>row.id==='actual-repayment-parent').amount,200000);assert.ok(items.every(row=>row.status!=='상환 확인 필요'));assert.equal(view.activeRepaymentLedger.totals.remaining,300000);
});

for(const excluded of ['cancelled','no-due-date','accident'])test('completed '+excluded+' repayment does not create a completion marker or alter existing cash',()=>{
 const data=store([], [repayment('excluded',{status:'상환완료',paidAmount:200000,paidDate:'2026-10-17',...(excluded==='cancelled'?{promiseState:'cancelled'}:excluded==='no-due-date'?{dueDate:''}:{})})]);if(excluded==='accident')data.customers[0].isAccident=true;
 const before=JSON.stringify(data),view=dashboard(data);assert.ok(!view.repaymentItems.some(row=>row.id.startsWith('completion-')));assert.equal(JSON.stringify(data),before);
 assert.equal(view.repaymentItems.length,excluded==='accident'?0:1);if(excluded!=='accident'){assert.equal(view.repaymentItems[0].id,'actual-repayment-excluded');assert.equal(view.repaymentItems[0].amount,200000);assert.equal(view.repaymentItems[0].date,'2026-10-17');}
});

test('all three registered future installment dates retain their amounts beside an oversized old overdue plan',()=>{
 const data=store([
  payment('august-paid',{status:'완료',dueDate:'2026-08-31',dueAmount:780000,paidAmount:780000,paidDate:'2026-08-31'}),
  payment('overdue',{dueDate:'2026-10-12',dueAmount:5000000}),
  payment('first-future',{status:'예정',dueDate:'2026-10-20',dueAmount:2500000}),
  payment('second-future',{status:'예정',dueDate:'2026-10-22',dueAmount:1800000}),
  payment('third-future',{status:'예정',dueDate:'2026-11-30',dueAmount:325000}),
 ],[],6105000),before=JSON.stringify(data),october=dashboard(data),november=dashboard(data,'2026-11'),august=dashboard(data,'2026-08');
 const first=october.paymentItems.find(row=>row.date==='2026-10-20'),second=october.paymentItems.find(row=>row.date==='2026-10-22'),third=november.paymentItems.find(row=>row.date==='2026-11-30');
 assert.ok(first);assert.ok(second);assert.ok(third);assert.equal(october.paymentItems.length,3);assert.equal(november.paymentItems.length,1);
 for(const [row,registered] of [[first,2500000],[second,1800000],[third,325000]]){
  assert.equal(calendarItemTone(row),'blue');assert.equal(row.done,false);assert.equal(row.amount,registered);assert.match(row.sub,new RegExp(String(registered)));
  const cell=renderRepaymentDay(row.date.startsWith('2026-10')?october.paymentItems:november.paymentItems,row.date,false,'blue');assert.match(cell,/bg-blue-50 text-blue-800/);assert.match(cell,new RegExp(String(registered)));
 }
 assert.equal(october.paymentSummary.expected,4300000);assert.equal(october.paymentSummary.overdue,5000000);assert.equal(october.paymentSummary.paid,0);assert.equal(moneyTotal(october.paymentItems),9300000);
 assert.equal(november.paymentSummary.expected,325000);assert.equal(november.paymentSummary.overdue,0);assert.equal(moneyTotal(november.paymentItems),325000);
 assert.equal(august.paymentItems.length,1);assert.equal(august.paymentItems[0].amount,780000);assert.equal(august.paymentSummary.paid,780000);assert.equal(calendarItemTone(august.paymentItems[0]),'gray');
 const popup=renderRepaymentDay(october.paymentItems,'2026-10-22',true,'blue');assert.match(popup,/1800000/);assert.match(popup.replace(/<[^>]*>/g,''),/분납 총합\s*1800000/);
 assert.equal(buildScheduleLedger(data.payments,6105000).totals.remaining,5325000);assert.equal(JSON.stringify(data),before);
});

for(const promiseState of ['rescheduled',null])test('rescheduled pending payment '+String(promiseState)+' remains a blue original record without double counting its child',()=>{
 const data=store([payment('parent',{status:'예정',promiseState,paidAmount:200000,paidDate:'2026-10-16'}),payment('next',{status:'예정',dueAmount:300000,dueDate:'2026-11-20',rescheduledFromId:'parent'})]),before=JSON.stringify(data),view=dashboard(data);
 const marker=view.paymentItems.find(row=>!row.id.startsWith('paid-'));assert.equal(view.paymentItems.length,2);assert.equal(marker.amount,0);assert.equal(marker.done,false);assert.equal(marker.history,true);assert.equal(calendarItemTone(marker),'blue');assert.match(marker.sub,/500000/);
 assert.equal(view.paymentSummary.expected,0);assert.equal(view.paymentSummary.paid,200000);assert.equal(dashboard(data,'2026-11').paymentItems[0].amount,300000);assert.equal(JSON.stringify(data),before);
});

test('a zero-value pending payment stays visible as a blue record without inventing debt or completion',()=>{
 const data=store([payment('empty',{status:'예정',dueAmount:0,promiseState:'active',obligationAmount:0})]),view=dashboard(data);
 assert.equal(view.paymentItems.length,1);assert.equal(view.paymentItems[0].amount,0);assert.equal(view.paymentItems[0].done,false);assert.equal(calendarItemTone(view.paymentItems[0]),'blue');assert.equal(view.paymentSummary.expected,0);assert.equal(view.paymentSummary.paid,0);assert.equal(view.paymentUndated,500000);
});

test('pending installments preserve both registered amounts and leave only the true unassigned difference',()=>{
 const data=store([payment('root',{status:'예정',promiseState:'rescheduled',obligationAmount:500000}),payment('first',{status:'예정',rescheduledFromId:'root',dueDate:'2026-10-18'}),payment('capped',{status:'예정',dueAmount:200000,rescheduledFromId:'root',dueDate:'2026-10-20'})],[],800000),before=JSON.stringify(data),view=dashboard(data);
 assert.equal(view.paymentItems.length,3);const capped=view.paymentItems.find(row=>row.date==='2026-10-20');assert.equal(capped.amount,200000);assert.equal(calendarItemTone(capped),'blue');assert.match(capped.sub,/200000/);assert.equal(view.paymentSummary.expected,700000);assert.equal(view.paymentUndated,100000);assert.equal(JSON.stringify(data),before);
});

test('partial payment subtitle preserves the full registered remainder after actual cash and legacy credit',()=>{
 const data=store([payment('earlier',{status:'예정',dueDate:'2026-10-01',dueAmount:250000}),payment('partial',{status:'예정',paidAmount:200000,paidDate:'2026-10-16',allocatedAmount:100000})],[],600000),before=JSON.stringify(data),view=dashboard(data),item=view.paymentItems.find(row=>row.id==='schedule-partial');
 assert.equal(item.amount,200000);assert.match(item.sub,/200000/);assert.equal(calendarItemTone(item),'blue');assert.equal(view.paymentSummary.expected,450000);assert.equal(view.paymentSummary.paid,200000);assert.equal(view.paymentItems.find(row=>row.id==='paid-partial').amount,200000);assert.equal(JSON.stringify(data),before);
 assert.equal(buildScheduleLedger(data.payments,600000).totals.remaining,300000);
});

for(const paidDate of ['', '2026-10-17','2026-11-01'])test('fully paid installment with paid date '+(paidDate||'missing')+' retains its gray original record and only real dated cash',()=>{
 const data=store([payment('paid-record',{status:'완료',paidAmount:500000,paidDate})]),before=JSON.stringify(data),october=dashboard(data),marker=october.paymentItems.find(row=>!row.id.startsWith('paid-'));
 assert.ok(marker);assert.equal(marker.date,'2026-10-16');assert.equal(marker.amount,0);assert.equal(marker.done,true);assert.equal(calendarItemTone(marker),'gray');assert.match(marker.sub,/500000/);assert.equal(october.paymentSummary.expected,0);
 const cashItems=paidDate?dashboard(data,paidDate.slice(0,7)).paymentItems.filter(row=>row.id.startsWith('paid-')):october.paymentItems.filter(row=>row.id.startsWith('paid-'));
 assert.equal(cashItems.length,paidDate?1:0);if(paidDate){assert.equal(cashItems[0].date,paidDate);assert.equal(cashItems[0].amount,500000);}
 assert.equal(october.paymentSummary.paid,paidDate.startsWith('2026-10')?500000:0);assert.equal(JSON.stringify(data),before);
});

for(const paidAmount of [500000,600000])test('same-day fully paid installment '+paidAmount+' is represented once by the actual receipt',()=>{
 const data=store([payment('same-day',{status:'완료',paidAmount,paidDate:'2026-10-16'})]),view=dashboard(data);
 assert.equal(view.paymentItems.length,1);assert.equal(view.paymentItems[0].id,'paid-same-day');assert.equal(view.paymentItems[0].amount,paidAmount);assert.equal(view.paymentSummary.paid,paidAmount);assert.equal(calendarItemTone(view.paymentItems[0]),'gray');
});

test('fully allocated payment remains a gray original record without turning credit into cash',()=>{
 const data=store([payment('allocated',{status:'완료',allocatedAmount:500000})]),before=JSON.stringify(data),view=dashboard(data);
 assert.equal(view.paymentItems.length,1);assert.equal(view.paymentItems[0].amount,0);assert.equal(view.paymentItems[0].done,true);assert.equal(calendarItemTone(view.paymentItems[0]),'gray');assert.equal(view.paymentSummary.paid,0);assert.equal(view.paymentSummary.expected,0);assert.equal(view.paymentUndated,0);assert.equal(JSON.stringify(data),before);
 assert.doesNotMatch(notice(data).text,/✅ 입금/);
});

test('mixed credit and same-day cash preserve the settled original record and count only actual cash',()=>{
 const data=store([payment('mixed',{status:'완료',paidAmount:100000,paidDate:'2026-10-16',allocatedAmount:400000})]),view=dashboard(data),marker=view.paymentItems.find(row=>!row.id.startsWith('paid-'));
 assert.equal(view.paymentItems.length,2);assert.ok(marker);assert.equal(marker.amount,0);assert.equal(marker.done,true);assert.equal(calendarItemTone(marker),'gray');assert.equal(view.paymentItems.find(row=>row.id==='paid-mixed').amount,100000);assert.equal(view.paymentSummary.paid,100000);assert.equal(view.paymentSummary.expected,0);
});

test('completed payment without cash stays blue at its entered amount and asks for confirmation',()=>{
 const data=store([payment('consuming',{dueDate:'2026-10-01',status:'예정'}),payment('unverified',{status:'완료',dueAmount:200000})]),view=dashboard(data),marker=view.paymentItems.find(row=>row.date==='2026-10-16');
 assert.ok(marker);assert.equal(marker.amount,200000);assert.equal(marker.done,false);assert.equal(marker.status,'입금 확인 필요');assert.equal(calendarItemTone(marker),'blue');assert.match(marker.sub,/200000/);assert.equal(view.paymentSummary.paid,0);assert.equal(view.paymentSummary.expected,700000);
});

test('a payment whose customer is unavailable keeps its dated registered record with no fabricated allocation',()=>{
 const data=store([payment('orphan',{customerId:'missing-customer',status:'예정'})]),before=JSON.stringify(data),view=dashboard(data);
 assert.equal(view.paymentItems.length,1);assert.equal(view.paymentItems[0].label,'고객없음');assert.equal(view.paymentItems[0].amount,0);assert.equal(calendarItemTone(view.paymentItems[0]),'blue');assert.match(view.paymentItems[0].sub,/500000/);assert.equal(view.paymentSummary.expected,0);assert.equal(JSON.stringify(data),before);
});

test('a missing customer ledger never revives an explicitly cancelled payment',()=>{
 const data=store([payment('orphan-cancelled',{customerId:'missing-customer',status:'예정',promiseState:'cancelled'})]);assert.equal(dashboard(data).paymentItems.length,0);
});

for(const excluded of ['cancelled','no-date','accident','refund'])test(excluded+' payment does not regain a generic original-record marker',()=>{
 const patch=excluded==='cancelled'?{promiseState:'cancelled'}:excluded==='no-date'?{dueDate:''}:excluded==='refund'?{status:'환불'}:{};
 const data=store([payment('excluded',{status:'예정',paidAmount:200000,paidDate:'2026-10-17',...patch})]);if(excluded==='accident')data.customers[0].isAccident=true;
 const before=JSON.stringify(data),items=dashboard(data).paymentItems;assert.ok(items.every(row=>row.id.startsWith('paid-')));assert.equal(items.length,['cancelled','no-date'].includes(excluded)?1:0);assert.equal(JSON.stringify(data),before);
});

for(const status of ['종결','상환완료','완료'])test('notice retains zero-amount registered '+status+' without inventing cash',()=>{
 const data=store([], [repayment('closed',{status,amount:0})]),before=JSON.stringify(data),result=notice(data);
 assert.equal(result.repaymentRows.length,1);
 assert.match(result.text,new RegExp('검증 업체 — ✅ '+(status==='종결'?'종결':'상환완료')));
 assert.doesNotMatch(result.text,/등록된 상환 일정이 없습니다|원 예정\n|0원 ✅ 상환|실상환/);
 assert.match(result.text,/남은 상환 금액 합계: 0원/);
 assert.equal(JSON.stringify(data),before);
 const deselected=result.buildAllNotice([],[]);assert.doesNotMatch(deselected,/✅ 종결|✅ 상환완료/);
});

for(const status of ['종결','상환완료'])for(const paidAmount of [0,200000,500000])test('notice shows '+status+' once while preserving recorded cash '+paidAmount+' outside the message',()=>{
 const data=store([], [repayment('done',{status,paidAmount,paidDate:paidAmount?'2026-10-17':''})]),before=JSON.stringify(data),text=notice(data).text;
 assert.match(text,new RegExp('검증 업체 — ✅ '+status));
 assert.doesNotMatch(text,/원 예정\n|등록된 상환 일정이 없습니다/);
 assert.equal((text.match(/— 검증 업체 —/g)||[]).length,1);
 assert.doesNotMatch(text,/원 ✅ 상환|잔액 확인 필요/);assert.match(text,/남은 상환 금액 합계: 0원/);
 const ledger=buildScheduleLedger(data.repayments);assert.equal(ledger.totals.paid,paidAmount);assert.equal(ledger.totals.remaining,500000-paidAmount);
 assert.equal(JSON.stringify(data),before);
});

test('notice distinguishes a historical completion from the new pending repayment',()=>{
 const data=store([], [repayment('old',{status:'상환완료',paidAmount:200000,paidDate:'2026-10-16'}),repayment('new',{status:'예정',amount:300000,dueDate:'2026-10-20',rescheduledFromId:'old'})]),text=notice(data).text;
 assert.match(text,/10월 16일[^\n]*✅ 상환완료/);assert.match(text,/10월 20일[^\n]*300,000원 예정/);
 assert.match(text,/남은 상환 금액 합계: 300,000원/);assert.doesNotMatch(text,/200,000원 ✅ 상환|이전 약속|잔액 확인 필요/);
 const ledger=buildScheduleLedger(data.repayments);assert.equal(ledger.totals.paid,200000);assert.equal(ledger.totals.remaining,300000);
});

for(const kind of ['cancelled','accident'])test('notice excludes '+kind+' zero-amount completion',()=>{
 const data=store([], [repayment('excluded',{status:'종결',amount:0,...(kind==='cancelled'?{promiseState:'cancelled'}:{})})]);
 if(kind==='accident')data.customers[0].isAccident=true;
 assert.equal(notice(data).repaymentRows.length,0);assert.doesNotMatch(notice(data).text,/✅ 종결/);
});

test('notice totals pending and overdue repayments while listing collection separately beside a closed lender',()=>{
 const data=store([], [repayment('closed',{status:'종결',amount:0}),repayment('pending',{status:'예정',amount:100000}),repayment('overdue',{status:'연체',amount:200000}),repayment('collection',{status:'추심',amount:300000})]),text=notice(data).text;
 assert.match(text,/✅ 종결/);assert.match(text,/100,000원 예정/);assert.match(text,/200,000원/);assert.match(text,/■ 추심 중인 업체/);assert.match(text,/남은 상환 금액 합계: 300,000원/);
 assert.equal((text.match(/🚨 추심/g)||[]).length,1);assert.equal(buildScheduleLedger(data.repayments).totals.remaining,600000);
});

for(const paidAmount of [0,200000])test('changing a repayment from pending to collection removes only its notice total and retains recorded cash '+paidAmount,()=>{
 const pending=store([], [repayment('switch',{lenderName:'상태 전환 테스트 업체',status:'예정',amount:500000,paidAmount,paidDate:paidAmount?'2026-10-17':''})]),pendingBefore=JSON.stringify(pending);
 const changed={...pending,repayments:pending.repayments.map(row=>({...row,status:'추심'}))},changedBefore=JSON.stringify(changed);
 const prior=notice(pending),result=notice(changed),lines=result.text.split('\n').filter(line=>line.includes(' — 상태 전환 테스트 업체 — '));
 assert.match(prior.text,new RegExp('남은 상환 금액 합계: '+(500000-paidAmount).toLocaleString('ko-KR')+'원'));
 assert.match(result.text,/남은 상환 금액 합계: 0원/);assert.match(result.text,/■ 추심 중인 업체/);assert.match(result.text,/추심 외 등록된 상환 일정이 없습니다/);
 assert.equal(lines.length,1);assert.match(lines[0],/— 🚨 추심$/);assert.doesNotMatch(lines[0],/500,000원|300,000원|200,000원|확인 필요|✅ 상환/);
 assert.equal(result.repaymentRows.length,1);assert.equal(result.repaymentRows[0].amount,500000);assert.equal(result.repaymentRows[0].paidAmount,paidAmount);assert.equal(result.repaymentRows[0].paidDate,paidAmount?'2026-10-17':'');
 const beforeLedger=buildScheduleLedger(pending.repayments),afterLedger=buildScheduleLedger(changed.repayments);
 assert.deepEqual(afterLedger.totals,beforeLedger.totals);assert.equal(afterLedger.totals.paid,paidAmount);assert.equal(afterLedger.totals.remaining,500000-paidAmount);
 assert.equal(JSON.stringify(pending),pendingBefore);assert.equal(JSON.stringify(changed),changedBefore);
});

test('collection selection changes its single status line without adding its balance to the customer notice total',()=>{
 const data=store([], [repayment('collection',{lenderName:'추심 선택 테스트 업체',status:'추심',amount:500000,paidAmount:200000,paidDate:'2026-10-17'}),repayment('pending',{lenderName:'정상 예정 테스트 업체',status:'예정',amount:100000})]),before=JSON.stringify(data),result=notice(data);
 const withoutCollection=result.buildAllNotice([],['pending']),onlyCollection=result.buildAllNotice([],['collection']),none=result.buildAllNotice([],[]);
 assert.match(result.text,/남은 상환 금액 합계: 100,000원/);assert.equal((result.text.match(/🚨 추심/g)||[]).length,1);
 assert.doesNotMatch(withoutCollection,/■ 추심 중인 업체|🚨 추심|추심 선택 테스트 업체/);assert.match(withoutCollection,/100,000원 예정/);
 assert.equal((onlyCollection.match(/🚨 추심/g)||[]).length,1);assert.doesNotMatch(none,/🚨 추심|■ 추심 중인 업체/);
 for(const text of [withoutCollection,onlyCollection,none])assert.match(text,/남은 상환 금액 합계: 100,000원/,'the existing total remains customer-wide rather than dependent on selected lines');
 assert.equal(buildScheduleLedger(data.repayments).totals.remaining,400000);assert.equal(buildScheduleLedger(data.repayments).totals.paid,200000);assert.equal(JSON.stringify(data),before);
});

test('a zero-amount collection remains a selectable status without adding scheduled money',()=>{
 const data=store([], [repayment('zero-collection',{lenderName:'금액 없는 추심 테스트 업체',status:'추심',amount:0})]),before=JSON.stringify(data),result=notice(data);
 assert.equal(result.repaymentRows.length,1);assert.match(result.text,/남은 상환 금액 합계: 0원/);assert.equal((result.text.match(/🚨 추심/g)||[]).length,1);
 assert.equal(buildScheduleLedger(data.repayments).totals.remaining,0);assert.equal(JSON.stringify(data),before);
});

for(const status of ['종결','상환완료'])for(const amount of [0,500000])test('notice selection renders registered '+status+' for amount '+amount,()=>{
 const html=renderNotice(store([], [repayment('done',{status,amount,paidAmount:amount})]));
 assert.match(html,new RegExp('✅ '+status));assert.match(html,/type="checkbox"/);
 assert.doesNotMatch(html,/등록된 상환 일정이 없습니다/);
});

test('photo 1 completion notice prints each of the three lenders once without duplicate amount-check lines',()=>{
 const rows=[['최이사',300000],['김실장',500000],['박부장',500000]].map(([lenderName,amount],index)=>repayment('photo-'+index,{lenderName,amount,dueDate:'2026-09-30',status:'상환완료'}));
 const data=store([],rows),before=JSON.stringify(data),text=notice(data).text;
 const lenderLines=text.split('\n').filter(line=>rows.some(row=>line.includes(' — '+row.lenderName+' — ')));
 assert.deepEqual(lenderLines,['09월 30일(수) — 최이사 — ✅ 상환완료','09월 30일(수) — 김실장 — ✅ 상환완료','09월 30일(수) — 박부장 — ✅ 상환완료']);
 assert.doesNotMatch(text,/잔액 확인 필요|실상환|원 ✅ 상환/);
 assert.match(text,/남은 상환 금액 합계: 0원/);
 const ledger=buildScheduleLedger(rows);assert.equal(ledger.totals.paid,0);assert.equal(ledger.totals.owed,1300000);assert.equal(ledger.totals.remaining,1300000);
 assert.equal(JSON.stringify(data),before);
});

test('closed, completed and collection notices each show only their registered status',()=>{
 const rows=[repayment('closed',{lenderName:'종결 업체',status:'종결'}),repayment('done',{lenderName:'완료 업체',status:'상환완료',paidAmount:200000,paidDate:'2026-10-17'}),repayment('collection',{lenderName:'추심 업체',status:'추심'})];
 const data=store([],rows),before=JSON.stringify(data),text=notice(data).text;
 for(const [name,label] of [['종결 업체','✅ 종결'],['완료 업체','✅ 상환완료'],['추심 업체','🚨 추심']]){
  const lines=text.split('\n').filter(line=>line.includes(' — '+name+' — '));
  assert.equal(lines.length,1);assert.ok(lines[0].endsWith(label));assert.doesNotMatch(lines[0],/원|확인 필요/);
 }
 assert.equal(buildScheduleLedger(rows).totals.paid,200000);assert.equal(JSON.stringify(data),before);
});

test('retired partial repayment is announced once on its actual cash date beside its new pending schedule',()=>{
 const rows=[repayment('past',{paidAmount:200000,paidDate:'2026-10-17',promiseState:'rescheduled'}),repayment('future',{amount:300000,paidAmount:0,dueDate:'2026-10-20',rescheduledFromId:'past',status:'예정'})];
 const data=store([],rows),before=JSON.stringify(data),text=notice(data).text;
 assert.match(text,/10월 17일[^\n]*200,000원 ✅ 상환/);assert.match(text,/10월 20일[^\n]*300,000원 예정/);
 assert.doesNotMatch(text,/10월 16일|잔액 확인 필요/);assert.equal((text.match(/200,000원 ✅ 상환/g)||[]).length,1);
 const ledger=buildScheduleLedger(rows);assert.equal(ledger.totals.paid,200000);assert.equal(ledger.totals.remaining,300000);assert.equal(JSON.stringify(data),before);
});

for(const kind of ['payment','repayment']){
 const create=kind==='payment'?payment:repayment,amountKey=kind==='payment'?'dueAmount':'amount',tone=kind==='payment'?'blue':'amber';
 const displayItems=view=>kind==='payment'?view.paymentCalendarItems:view.repaymentCalendarItems;
 for(const status of ['연체','부분납부 후 연체'])test(kind+' hides '+status+' boxes in cells and details while preserving unpaid, pending, cash and debt',()=>{
  const rows=[create('overdue',{status,paidAmount:200000,paidDate:'2026-10-16'}),create('unpaid',{status:'미납',[amountKey]:70000}),create('pending',{status:'예정',[amountKey]:90000})];
  const data=kind==='payment'?store(rows,[],1000000):store([],rows),before=JSON.stringify(data),ledgerBefore=buildScheduleLedger(rows,kind==='payment'?1000000:undefined),view=dashboard(data),items=displayItems(view);
  assert.equal(itemsFor(view,kind).length,4,'raw records remain available to existing calculations');
  assert.equal(items.length,3);assert.ok(items.some(row=>row.registeredStatus==='미납'));assert.ok(items.some(row=>row.registeredStatus==='예정'));
  assert.equal(items.find(row=>row.done).amount,200000);assert.equal(items.find(row=>row.done).date,'2026-10-16');
  assert.ok(!items.some(row=>!row.done&&row.registeredStatus===status));
  if(kind==='payment'){
   // Preserve the existing accounting classification, including this legacy-only status.
   assert.equal(view.paymentSummary.overdue,status==='연체'?370000:70000);assert.equal(view.paymentSummary.expected,status==='연체'?90000:390000);assert.equal(view.paymentSummary.paid,200000);
  }else assert.equal(view.activeRepaymentLedger.totals.remaining,460000);
  for(const pinned of [false,true]){
   const html=renderRepaymentDay(items,'2026-10-16',pinned,tone);
   assert.doesNotMatch(html,/남은 금액 300000/);assert.match(html,/남은 금액 70000/);assert.match(html,/남은 금액 90000/);assert.match(html,kind==='payment'?/실입금 200000/:/실상환 200000/);
   assert.doesNotMatch(html,/● 연체/);assert.match(html,/● 미납/);
  }
  assert.deepEqual(buildScheduleLedger(rows,kind==='payment'?1000000:undefined).totals,ledgerBefore.totals);assert.equal(JSON.stringify(data),before);
 });
 test(kind+' hides overdue history across months without hiding actual cash or the new pending promise',()=>{
  const rows=[create('old',{status:'연체',paidAmount:200000,paidDate:'2026-10-17',promiseState:'rescheduled'}),create('next',{status:'예정',[amountKey]:300000,dueDate:'2026-11-20',rescheduledFromId:'old',promiseState:'active'})];
  const data=storeFor(kind,rows),before=JSON.stringify(data),october=dashboard(data),november=dashboard(data,'2026-11'),old=displayItems(october),future=displayItems(november);
  assert.equal(itemsFor(october,kind).length,2);assert.equal(itemsFor(october,kind).find(row=>row.history).registeredStatus,'연체');
  assert.equal(old.length,1);assert.equal(old[0].done,true);assert.equal(old[0].amount,200000);assert.equal(old[0].date,'2026-10-17');
  assert.equal(future.length,1);assert.equal(future[0].registeredStatus,'예정');assert.equal(future[0].amount,300000);
  for(const pinned of [false,true]){
   const html=renderRepaymentDay(old,'2026-10-17',pinned,tone);assert.doesNotMatch(html,/재약정 전 연체 이력|합계 제외/);assert.match(html,kind==='payment'?/실입금 200000/:/실상환 200000/);
  }
  if(kind==='payment'){assert.equal(october.paymentSummary.paid,200000);assert.equal(october.paymentSummary.overdue,0);assert.equal(november.paymentSummary.expected,300000);}
  else assert.equal(october.activeRepaymentLedger.totals.remaining,300000);
  assert.equal(JSON.stringify(data),before);
 });
 test(kind+' retains gray settled records and cash even when their original status is overdue',()=>{
  const data=storeFor(kind,[create('paid',{status:'연체',paidAmount:500000,paidDate:'2026-10-17'})]),before=JSON.stringify(data),view=dashboard(data),items=displayItems(view);
  assert.equal(items.length,kind==='payment'?2:1);assert.ok(items.every(row=>row.done&&calendarItemTone(row)==='gray'));
  const cash=items.find(row=>row.id===(kind==='payment'?'paid-paid':'actual-repayment-paid'));assert.equal(cash.amount,500000);assert.equal(cash.date,'2026-10-17');
  if(kind==='payment'){assert.equal(items.find(row=>row.id==='history-paid').amount,0);assert.equal(view.paymentSummary.paid,500000);}
  else assert.equal(view.activeRepaymentLedger.totals.remaining,0);
  assert.equal(JSON.stringify(data),before);
 });
}
