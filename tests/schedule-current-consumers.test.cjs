const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function compile(source,context={}){
 const loaded={exports:{}};
 return vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module:loaded,exports:loaded.exports,require,...context});
}
const buildScheduleLedger=compile(fs.readFileSync('lib/schedule-ledger.ts','utf8')+';buildScheduleLedger');
const metricsApi=compile(fs.readFileSync('lib/payment-metrics.ts','utf8')+';exports',{require:name=>name.endsWith('/schedule-ledger')?{buildScheduleLedger}:require(name)});
const revenueApi=compile(fs.readFileSync('lib/revenue-metrics.ts','utf8')+';exports');
function runComponent(file,name,data,returns){
 const source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const helpers=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&![name,'Stat','today','currentMonth','isoToday'].includes(node.name?.text)).map(node=>node.getText(ast)).join('\n');
 const component=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
 const body=component.body.statements.filter(node=>!ts.isReturnStatement(node)).map(node=>node.getText(ast)).join('\n');
 return compile(`${helpers}\nfunction run(){${body}\nreturn {${returns}};}run()`,{
  ...metricsApi,...revenueApi,buildScheduleLedger,useAdminStore:()=>data,useRouter:()=>({push:()=>{}}),
  useState:value=>[typeof value==='function'?value():value,()=>{}],useMemo:fn=>fn(),useCallback:fn=>fn,useEffect:()=>{},
  today:()=> '2026-10-17',isoToday:()=> '2026-10-17',currentMonth:()=> '2026-10',
  activeManagers:['신홍규','이중호'],inRange:(date,start,end)=>date>=start&&date<=end,isEformSignedStatus:()=>true,
 });
}
const customer={id:'c',name:'검증 고객',contractAmount:500000,createdAt:'2026-10-01',contractDate:'2026-10-01',manager:'신홍규'};
const payment=(id,patch={})=>({id,customerId:'c',dueDate:'2026-10-16',dueAmount:500000,paidAmount:0,paidDate:'',status:'연체',...patch});
const repayment=(id,patch={})=>({id,customerId:'c',dueDate:'2026-10-16',amount:500000,paidAmount:0,paidDate:'',status:'연체',...patch});
const store=(payments=[],repayments=[])=>({customers:[customer],payments,repayments,additionalContracts:[],metaLeads:[],lenders:[],recoveries:[]});
const analytics=data=>runComponent('components/analytics.tsx','Analytics',data,'metrics,team,trends');
const header=data=>runComponent('components/header.tsx','Header',data,'paymentAlerts,repaymentAlerts,alertCount');

test('header displays only the unpaid balance, including incomplete completed-status receipts',()=>{
 const data=store([payment('p',{status:'완료',paidAmount:200000,paidDate:'2026-10-16'})],[repayment('r',{status:'상환완료',paidAmount:200000,paidDate:'2026-10-16'})]);
 const result=header(data);
 assert.equal(result.alertCount,2);assert.equal(result.paymentAlerts[0].dueAmount,300000);assert.equal(result.repaymentAlerts[0].amount,300000);
});

test('historical promises and fully paid receipts never inflate header alerts',()=>{
 const data=store([payment('old',{promiseState:'rescheduled',paidAmount:200000}),payment('new',{rescheduledFromId:'old',dueAmount:300000,paidAmount:300000,status:'완료'})]);
 assert.equal(header(data).alertCount,0);
});

test('current overdue and upcoming analytics use remaining debt despite a completed label',()=>{
 const overdue=analytics(store([payment('p',{status:'완료',paidAmount:200000,paidDate:'2026-10-16'})]));
 assert.equal(overdue.metrics.overdueAmount,300000);assert.equal(overdue.metrics.overdueCustomers,1);assert.equal(overdue.team.find(row=>row.manager==='신홍규').activeOverdue,1);
 const upcoming=analytics(store([payment('p',{status:'완료',dueDate:'2026-10-20',paidAmount:200000,paidDate:'2026-10-16'})]));
 assert.equal(upcoming.metrics.upcoming7,300000);assert.equal(upcoming.metrics.upcoming30,300000);
});

test('period repayment forecast counts the current 300k promise once while retaining 200k cash history',()=>{
 const rows=[repayment('old',{paidAmount:200000,paidDate:'2026-10-16',promiseState:'rescheduled'}),repayment('new',{amount:300000,dueDate:'2026-10-20',rescheduledFromId:'old',rootScheduleId:'old',status:'예정'})];
 const result=analytics(store([],rows));
 assert.equal(result.metrics.periodRepaymentAmount,300000);assert.equal(result.metrics.periodRepayments.length,2);
 assert.equal(rows[0].paidAmount,200000);
});

test('cancelled repayment retains undated debt without adding a dated forecast',()=>{
 const result=analytics(store([],[repayment('cancelled',{paidAmount:200000,promiseState:'cancelled'})]));
 assert.equal(result.metrics.periodRepaymentAmount,0);
});

test('legacy late statuses and late receipt dates never fabricate post-renewal date-change counts',()=>{
 const rows=[payment('legacy-late'),payment('late-cash',{dueDate:'2026-10-15',dueAmount:100000,paidAmount:100000,paidDate:'2026-10-17',status:'완료',scheduleType:'재약정'})];
 const result=analytics(store(rows));
 assert.equal(result.metrics.periodDateChangeCount,0);assert.equal(result.metrics.totalDateChangeCount,0);
 assert.equal(result.metrics.changedSchedules.length,0);assert.equal(result.metrics.repeatCustomers.size,0);
 assert.equal(result.metrics.overdueAmount,500000);assert.equal(result.metrics.receivable,400000);
 assert.equal(result.metrics.allPaid,100000);
 assert.equal(result.trends.find(row=>row.month==='2026-10').dateChangeCount,0);
});

test('period changes follow current scheduled dates while repeated late customers use their total saved change counts',()=>{
 const rows=[payment('first',{dateChangeCount:1,dueAmount:100000}),payment('independent',{dateChangeCount:1,dueDate:'2026-10-20',dueAmount:100000,status:'예정'}),
  payment('older-month',{customerId:'other',dateChangeCount:3,dueDate:'2026-09-15',dueAmount:100000}),
  payment('recovery',{dateChangeCount:7,scheduleType:'환수'}),payment('refunded',{dateChangeCount:4,status:'환불'}),
  payment('accident',{customerId:'accident',dateChangeCount:8})];
 const data=store(rows);data.customers.push({...customer,id:'other'},{...customer,id:'accident',isAccident:true});
 const result=analytics(data);
 assert.equal(result.metrics.periodScheduled.length,2);assert.equal(result.metrics.changedSchedules.length,2);
 assert.equal(result.metrics.periodDateChangeCount,2);assert.equal(result.metrics.totalDateChangeCount,5);
 assert.equal(result.metrics.repeatCustomers.size,2);assert.equal(result.metrics.repeatCustomers.has('c'),true);
 assert.equal(result.metrics.repeatCustomers.has('other'),true);assert.equal(result.metrics.repeatCustomers.has('accident'),false);
 assert.equal(result.trends.find(row=>row.month==='2026-10').dateChangeCount,2);
 assert.equal(result.trends.find(row=>row.month==='2026-09').dateChangeCount,3);
 assert.equal(result.trends.find(row=>row.month==='2026-09').changedSchedules,1);
});

test('current unpaid schedules depend on due dates and remaining amounts rather than legacy status labels',()=>{
 const result=analytics(store([payment('future',{dueDate:'2026-10-20',dueAmount:100000,status:'연체'}),payment('past',{dueAmount:200000,status:'예정'})]));
 assert.equal(result.metrics.overdueAmount,200000);assert.equal(result.metrics.currentOverdue.length,1);
 assert.equal(result.metrics.currentOverdue[0].id,'past');assert.equal(result.metrics.upcoming7,100000);
 assert.equal(result.team.find(row=>row.manager==='신홍규').activeOverdue,1);
});

test('analytics subtracts detailed recovery credit and legacy allocations without adding either to cash',()=>{
 const data=store([payment('p',{dueAmount:500000,paidAmount:100000,paidDate:'2026-10-16',allocatedAmount:50000})]);
 data.customers=[{...customer,recoveryCredit:100000}];
 const result=analytics(data);
 assert.equal(result.metrics.receivable,250000);assert.equal(result.metrics.allContractPaid,100000);
 assert.equal(result.metrics.allPaid,100000);assert.equal(result.metrics.realSales,100000);
 assert.equal(result.team.find(row=>row.manager==='신홍규').receivable,250000);
});
