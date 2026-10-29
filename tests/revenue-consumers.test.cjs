const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
function compile(source,context={}){
 const loaded={exports:{}};
 return vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module:loaded,exports:loaded.exports,require,...context});
}
const revenueApi=compile(fs.readFileSync('lib/revenue-metrics.ts','utf8')+';exports');
const bankApi=compile(fs.readFileSync('lib/bank-cash-metrics.ts','utf8')+';exports');
const cancellationApi=compile(fs.readFileSync('lib/settlement-cancellation.ts','utf8')+';exports');
const buildScheduleLedger=compile(fs.readFileSync('lib/schedule-ledger.ts','utf8')+';buildScheduleLedger');
const metricsApi=compile(fs.readFileSync('lib/payment-metrics.ts','utf8')+';exports',{require:name=>name.endsWith('/schedule-ledger')?{buildScheduleLedger}:require(name)});
const section=()=>ts.createSourceFile('page.tsx',fs.readFileSync('app/(admin)/[section]/page.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const customer=(id,patch={})=>({id,name:'가상 의뢰인 '+id,phone:'010-0000-0000',manager:'담당',createdAt:'2026-10-01',contractDate:'2026-10-01',contractAmount:2000000,eformsignStatus:'완료',...patch});
const payment=(id,patch={})=>({id,customerId:'signed',paidDate:'2026-10-20',paidAmount:100000,dueDate:'2026-10-20',dueAmount:100000,status:'완료',scheduleType:'일반',...patch});
const recovery=(id,patch={})=>({id,customerId:'signed',amount:1000000,recoveryDate:'2026-10-21',accountingVersion:2,installmentAmount:200000,lenderName:'가상 업체',depositorName:'실제 입금자',...patch});
function data(){return {customers:[customer('signed'),customer('unsigned',{eformsignStatus:'진행'})],payments:[payment('cash'),payment('shadow',{scheduleType:'환수',sourceRecoveryId:'r',paidAmount:1000000}),payment('unsigned-cash',{customerId:'unsigned',paidAmount:700000})],recoveries:[recovery('r'),recovery('u',{customerId:'unsigned',amount:600000,installmentAmount:100000})],recoveryAllocations:[],recoverySplits:[],recoveryRefunds:[],settlements:[],additionalContracts:[],metaLeads:[],repayments:[],lenders:[]};}
const common={...revenueApi,...bankApi,...metricsApi,...cancellationApi,useRouter:()=>({push:()=>{}}),buildScheduleLedger,crypto:require('node:crypto'),useMemo:fn=>fn(),useCallback:fn=>fn,useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useRef:initial=>({current:initial}),useEffect:()=>{},
 inRange:(date,start,end)=>date>=start&&date<=end,isEformSignedStatus:status=>status==='완료',monthRange:()=>({start:'2026-10-16',end:'2026-10-31'}),newestFirst:(a,b)=>b.id.localeCompare(a.id)};
function settlements(s){
 const ast=section(),owner=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='Settlements');
 const body=owner.body.statements.filter(node=>!ts.isReturnStatement(node)).map(node=>node.getText(ast)).join('\n');
 let csv='';
  const view=compile(`function run(){${body}\nreturn {contractRealSales,recoverySales,periodRevenue,recoveryRevenueInRange,settlementRows,settlementTotal,settlementInflow,settlementOutflow,downloadSettlement,settlementNote};}run()`,{
  ...common,useAdminStore:()=>s,emptySettlement:()=>({}),Blob:class{constructor(parts){csv=parts.join('')}},URL:{createObjectURL:()=> 'blob:csv',revokeObjectURL:()=>{}},document:{createElement:()=>({click(){}})},
 });
 return {view,csv:()=>csv};
}

test('settlement cards and per-customer source totals use revenue allocation for signed customers only',()=>{
 const result=settlements(data()).view;
 assert.equal(result.contractRealSales,300000);assert.equal(result.recoverySales,500000);
 const customerTotals=revenueApi.summarizeRevenue(result.periodRevenue,'','',new Set(['signed']));
 assert.equal(customerTotals.realSales,result.contractRealSales);assert.equal(customerTotals.recoverySuccessFee,result.recoverySales);
 assert.ok(result.periodRevenue.every(row=>row.customerId==='signed'));
});

test('statement, cash totals and downloaded CSV share the actual one-row gross deposit and preserved manual adjustments',()=>{
 const s=data();s.settlements=[
  {id:'gross',paidDate:'2026-10-21',clientName:'가상 의뢰인',customerId:'signed',amount:1000000,entrySource:'recovery',entryType:'환수',sourceRecoveryId:'r',paymentMethod:'계좌이체',memo:'원본'},
  {id:'cash',paidDate:'2026-10-20',clientName:'가상 의뢰인',customerId:'signed',amount:100000,entrySource:'payment',entryType:'계약',sourcePaymentScheduleId:'cash',paymentMethod:'계좌이체',memo:''},
  {id:'manual',paidDate:'2026-10-22',clientName:'수기 정정',amount:12345,entrySource:'manual',entryType:'계약',paymentMethod:'계좌이체',memo:'수기 "보정"'},
 ];s.recoveryRefunds=[{id:'actual-return',customerId:'signed',recoveryId:'r',refundDate:'2026-10-23',amount:300000,recipientName:'반환 수취인',paymentMethod:'계좌이체',memo:''},
 {id:'hidden-return',customerId:'signed',recoveryId:'r',refundDate:'2026-10-24',amount:20000,settlementHidden:true}];
 const before=JSON.stringify(s),result=settlements(s);result.view.downloadSettlement();
 assert.equal(result.view.settlementRows.length,4);assert.equal(result.view.settlementInflow,1112345);assert.equal(result.view.settlementOutflow,300000);assert.equal(result.view.settlementTotal,812345);
 const csv=result.csv();assert.equal(csv.split('\r\n').length,5);assert.equal((csv.match(/"1000000"/g)||[]).length,1);
 assert.match(csv,/환수 입금 \[가상 업체\] \[예금주:실제 입금자\]/);assert.match(csv,/수기 ""보정""/);assert.match(csv,/"출금"/);assert.doesNotMatch(csv,/환수 성공보수|환수 분납금/);assert.equal(JSON.stringify(s),before);
});

test('dashboard revenue uses the same allocation definition as settlement cards',()=>{
 const s=data(),ast=ts.createSourceFile('dashboard.tsx',fs.readFileSync('app/(admin)/page.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const component=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='Dashboard');
 const declaration=component.body.statements.flatMap(node=>ts.isVariableStatement(node)?[...node.declarationList.declarations]:[]).find(node=>node.name.getText(ast)==='data');
 const result=compile(declaration.initializer.getText(ast),{...common,s,rangeStart:'2026-10-16',rangeEnd:'2026-10-31',revenueEvents:revenueApi.buildRevenueEvents(s.payments,s.recoveries,s.recoveryAllocations)});
 assert.equal(result.realSales,300000);assert.equal(result.realSales,settlements(s).view.contractRealSales);
});

function dashboardCash(s){
 const source=fs.readFileSync('app/(admin)/page.tsx','utf8'),ast=ts.createSourceFile('dashboard.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),owner=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='Dashboard');
 const body=owner.body.statements.filter(node=>!ts.isReturnStatement(node)).map(node=>node.getText(ast)).join('\n');
 const calendarApi=compile(fs.readFileSync('lib/calendar-status.ts','utf8')+';exports');
 return compile(`function run(){${body}\nreturn {data,bankSummary,paymentSummary,bankRows};}run()`,{...common,...calendarApi,useAdminStore:()=>s,today:()=> '2026-10-23',won:String,duplicateCustomerTag:()=>'',groupBy:(rows,key)=>{const result=new Map();for(const row of rows){const id=key(row);result.set(id,[...(result.get(id)||[]),row])}return result}});
}

test('dashboard range and monthly cash summaries equal the law-firm statement including unsigned receipts, refunds and manual corrections',()=>{
 const s=data(),beforeRevenue=dashboardCash(s).data.realSales;s.payments.push(payment('planned',{dueAmount:100000,dueDate:'2026-10-28',paidDate:'',paidAmount:0,status:'예정'}));
 s.settlements=[{id:'cash',customerId:'signed',paidDate:'2026-10-20',amount:100000,entrySource:'payment'},
  {id:'gross',customerId:'signed',paidDate:'2026-10-21',amount:1000000,entrySource:'payment',entryType:'환수'},
  {id:'unsigned-cash',customerId:'unsigned',paidDate:'2026-10-22',amount:700000,entrySource:'payment'},
  {id:'return-remainder',customerId:'signed',paidDate:'2026-10-23',amount:-100000,entrySource:'recovery',entryType:'의뢰인 환수 반환금',sourceRecoveryId:'r',recoveryComponent:'client_return'},
  {id:'manual-adjustment',clientName:'수기',paidDate:'2026-10-24',amount:12345,entrySource:'manual'}];
 s.recoveryRefunds=[{id:'legacy-return',customerId:'signed',recoveryId:'r',refundDate:'2026-10-23',amount:300000,recipientName:'가상 반환 수취인',paymentMethod:'계좌이체',memo:''}];
 const dashboard=dashboardCash(s),statement=settlements(s).view;
 assert.equal(dashboard.bankSummary.inflow,1812345);assert.equal(dashboard.bankSummary.outflow,400000);assert.equal(dashboard.bankSummary.net,1412345);
 assert.equal(dashboard.bankSummary.net,statement.settlementTotal);assert.equal(dashboard.bankSummary.inflow,statement.settlementInflow);assert.equal(dashboard.bankSummary.outflow,statement.settlementOutflow);
 assert.equal(dashboard.paymentSummary.paid,statement.settlementTotal);assert.equal(dashboard.paymentSummary.outflow,400000);assert.equal(dashboard.paymentSummary.periods[1].paid,1412345);assert.equal(dashboard.paymentSummary.expected,100000);assert.equal(dashboard.paymentSummary.total,1512345);assert.equal(dashboard.data.realSales,beforeRevenue);
});

test('dashboard month and half-month cash totals retain negative balances and never recover an explicitly hidden receipt from payment shadows',()=>{
 const s=data();s.settlements=[{id:'cash-first-half',paidDate:'2026-10-15',amount:100000,entrySource:'manual'},{id:'cash-second-half-out',paidDate:'2026-10-16',amount:-150000,entrySource:'manual'}];
 const dashboard=dashboardCash(s);assert.equal(dashboard.bankSummary.net,-150000);assert.equal(dashboard.paymentSummary.paid,-50000);assert.equal(dashboard.paymentSummary.periods[0].paid,100000);assert.equal(dashboard.paymentSummary.periods[1].paid,-150000);assert.equal(dashboard.paymentSummary.total,-50000);
 s.settlements=[];assert.equal(dashboardCash(s).paymentSummary.paid,0);assert.equal(s.payments.find(row=>row.id==='shadow').paidAmount,1000000);
});

test('dashboard actual cash summary keeps three horizontal boxes with a clearly labelled negative net amount',()=>{
 const ast=ts.createSourceFile('dashboard.tsx',fs.readFileSync('app/(admin)/page.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let card;
 function visit(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(ast)==='Card'&&node.getText(ast).includes('실제 입출금 ·'))card=node;ts.forEachChild(node,visit)}visit(ast);assert.ok(card);
 const html=renderToStaticMarkup(compile(card.getText(ast),{rangeStart:'2026-10-16',rangeEnd:'2026-10-31',bankSummary:{inflow:100000,outflow:150000,net:-50000},won:value=>'₩'+Number(value).toLocaleString('ko-KR'),Card:({children})=>React.createElement('section',null,children)}));
 assert.match(html,/grid-cols-3/);assert.match(html,/순입금 \(입금 − 출금\)/);assert.match(html,/₩-50,000/);assert.doesNotMatch(html,/로펌 정산표·CSV와 같은 실제 입출금 내역/);
});

test('internal allocation breakdowns show both detailed and legacy amounts without adding bank receipt lines',()=>{
 const s=data();s.recoveries=[recovery('r'),recovery('old',{accountingVersion:1,amount:200000,installmentAmount:999999,lenderName:'구형 업체'})];
 s.recoveryAllocations=[{recoveryId:'old',amount:80000},{recoveryId:'r',amount:200000}];
 const ast=section(),cards=[];
 function visit(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(ast)==='Card'&&/환수 (성공보수 배분|분납 충당) 내역/.test(node.getText(ast)))cards.push(node);ts.forEachChild(node,visit)}visit(ast);
 assert.equal(cards.length,2);const view=settlements(s).view;
 const html=cards.map(node=>renderToStaticMarkup(compile(node.getText(ast),{s,recoveryRevenueInRange:view.recoveryRevenueInRange,won:value=>Number(value).toLocaleString('ko-KR'),Card:({children})=>React.createElement('section',null,children)})));
 assert.match(html[0],/500,000/);assert.match(html[0],/100,000/);assert.match(html[0],/구형 업체/);
 assert.match(html[1],/200,000/);assert.match(html[1],/80,000/);assert.doesNotMatch(html[1],/999,999|400,000/);
 assert.equal(view.settlementRows.length,0);
});

test('analytics period, manager and monthly revenue match settlement while cumulative cash keeps the gross receipt',()=>{
 const s=data(),source=fs.readFileSync('components/analytics.tsx','utf8'),ast=ts.createSourceFile('analytics.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const helpers=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&!['Analytics','Stat','today','currentMonth'].includes(node.name?.text)).map(node=>node.getText(ast)).join('\n');
 const owner=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='Analytics');
 const body=owner.body.statements.filter(node=>!ts.isReturnStatement(node)).map(node=>node.getText(ast)).join('\n');
 const result=compile(`${helpers}\nfunction run(){${body}\nreturn {metrics,team,trends};}run()`,{...common,useAdminStore:()=>s,today:()=> '2026-10-23',currentMonth:()=> '2026-10',activeManagers:['담당']});
 assert.equal(result.metrics.realSales,300000);assert.equal(result.metrics.recoverySales,500000);assert.equal(result.metrics.allPaid,1100000);
 assert.equal(result.team.find(row=>row.manager==='담당').real,300000);assert.equal(result.trends.find(row=>row.month==='2026-10').realSales,300000);
});

test('payment overplanned action opens the editor for the selected customer without requiring a fabricated payment record',()=>{
 const ast=section();let element;function visit(node){if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(ast)==='PaymentOverplanned')element=node;ts.forEachChild(node,visit)}visit(ast);assert.ok(element);
 const customers=[customer('selected')],ledgers=new Map(),selected=[];let props;
 const result=compile(element.getText(ast),{s:{customers},ledgers,setScheduleEditing:value=>selected.push(value),PaymentOverplanned:values=>{props=values;return null}});
 renderToStaticMarkup(result);assert.equal(props.customers,customers);assert.equal(props.ledgers,ledgers);props.onManage(customers[0]);
 assert.deepEqual(JSON.parse(JSON.stringify(selected)),[{id:'',customerId:'selected'}]);
});

function statementEditor(s){
 const ast=section(),owner=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='Settlements');
 const body=owner.body.statements.filter(node=>!ts.isReturnStatement(node)).map(node=>node.getText(ast)).join('\n');
 const cells=[];let cursor=0;
 const render=compile(`function run(){${body}\nreturn {form,setForm,open,saving,saveError,saveSettlement,beginAdd,beginEdit};}run`,{
  ...common,useAdminStore:()=>s,emptySettlement:()=>({paidDate:'2026-10-23',clientName:'',amount:0,paymentMethod:'계좌이체',memo:''}),
  useState(initial){const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return [cells[i],value=>{cells[i]=typeof value==='function'?value(cells[i]):value}]},
  useRef(initial){const i=cursor++;return cells[i]??=( {current:initial} )},
 });
 return ()=>{cursor=0;return render()};
}
for(const mode of ['add','edit'])test('manual statement '+mode+' waits, blocks duplicate submits, preserves a failed draft and closes only after successful retry',async()=>{
 const s=data(),calls=[];let resolve,reject;
 const save=(...args)=>{calls.push(args);return new Promise((done,fail)=>{resolve=done;reject=fail})};
 s.addSettlement=save;s.updateSettlement=save;
 const render=statementEditor(s);let view=render();
 if(mode==='edit')view.beginEdit({id:'manual',paidDate:'2026-10-22',clientName:'수기',amount:100,paymentMethod:'계좌이체',memo:'원본'});else view.beginAdd();
 view=render();view.setForm({...view.form,amount:123456,memo:'보존할 수정 내용'});view=render();
 const pending=view.saveSettlement(),duplicate=view.saveSettlement();await duplicate;view=render();
 assert.equal(calls.length,1);assert.equal(view.saving,true);assert.equal(view.open,true);
 const args=calls[0],payload=args[mode==='edit'?1:0];assert.equal(payload.amount,123456);if(mode==='edit')assert.equal(args[0],'manual');
 if(mode==='add')assert.match(args[1],/^[0-9a-f-]{36}$/);
 reject(Error('DB 거절'));await pending;view=render();
 assert.equal(view.saving,false);assert.equal(view.open,true);assert.equal(view.form.amount,123456);assert.equal(view.form.memo,'보존할 수정 내용');assert.match(view.saveError,/DB 거절/);
 const retry=view.saveSettlement();assert.equal(calls.length,2);if(mode==='add')assert.equal(calls[1][1],calls[0][1]);assert.equal(render().saveError,'');resolve();await retry;view=render();assert.equal(view.open,false);assert.equal(view.saving,false);
 view.beginAdd();assert.equal(render().saveError,'');assert.equal(render().form.amount,0);
});

test('manual statement save modal exposes pending lock, disabled buttons and its visible error',()=>{
 const ast=section();let modal;
 function visit(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(ast)==='Modal'&&node.openingElement.getText(ast).includes('정산 내역 수정'))modal=node;ts.forEachChild(node,visit)}visit(ast);assert.ok(modal);
 let modalProps;const buttons=[];
 const render=saving=>renderToStaticMarkup(compile(modal.getText(ast),{open:true,editing:null,saving,saveError:'정산 저장 실패: DB 거절',form:{paidDate:'2026-10-23',clientName:'가상',amount:1,paymentMethod:'계좌이체',memo:''},field:'field',setOpen:()=>{},setForm:()=>{},saveSettlement:async()=>{},paymentMethods:['계좌이체'],
  Modal:props=>{modalProps=props;return React.createElement('section',null,props.children)},Button:props=>{buttons.push(props);return React.createElement('button',{disabled:props.disabled},props.children)},Label:({children})=>React.createElement('label',null,children),NumberInput:()=>null}));
 const html=render(true);assert.equal(modalProps.busy,true);assert.ok(buttons.every(button=>button.disabled));assert.match(html,/role="alert"/);assert.match(html,/DB 거절/);assert.match(html,/저장 중/);
});

function statementMutation(name,settlements,rpc,refresh,lookup=async()=>({data:null,error:null})){
 const ast=ts.createSourceFile('store.tsx',fs.readFileSync('components/store.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let method;
 function visit(node){if(ts.isMethodDeclaration(node)&&node.name.getText(ast)===name)method=node;ts.forEachChild(node,visit)}visit(ast);assert.ok(method);
 return compile('('+method.getText(ast).replace('async '+name+'(','async function(')+')',{settlements,Error,crypto:require('node:crypto'),supabase:{from:table=>{assert.equal(table,'settlement_entries');return {insert:payload=>rpc(payload),update:payload=>({eq:(_key,id)=>rpc(payload,id)}),select:()=>({eq:(_key,id)=>({maybeSingle:()=>lookup(id)})})}}},refresh});
}
for(const name of ['addSettlement','updateSettlement'])test(name+' returns an observable result and refreshes only after a successful manual write',async()=>{
 const existing={id:'manual',entrySource:'manual',amount:10},payload={paidDate:'2026-10-23',clientName:'가상',amount:25,paymentMethod:'계좌이체',memo:'수기'};let refreshed=0,calls=[];
 const refresh=async()=>{refreshed++};let done;
 const mutate=statementMutation(name,[existing],(...args)=>{calls.push(args);return new Promise(resolve=>{done=resolve})},refresh);
 const pending=name==='addSettlement'?mutate(payload):mutate('manual',payload);assert.equal(typeof pending.then,'function');assert.equal(refreshed,0);done({error:null});await pending;
 assert.equal(refreshed,1);assert.equal(calls.length,1);assert.equal(calls[0][0].amount,25);
 for(const transport of [false,true]){
  const fail=statementMutation(name,[existing],async()=>{if(transport)throw Error('offline');return {error:{message:'DB 거절'}}},refresh);
  await assert.rejects(name==='addSettlement'?fail(payload):fail('manual',payload),transport?/offline/:/DB 거절/);assert.equal(refreshed,1);
 }
});

test('manual settlement editing rejects missing or automatically linked rows before a write',async()=>{
 let writes=0;const mutate=statementMutation('updateSettlement',[{id:'auto',entrySource:'recovery'}],async()=>{writes++;return {error:null}},async()=>{});
 await assert.rejects(mutate('missing',{}),/찾지 못/);await assert.rejects(mutate('auto',{}),/원본 입금·환수/);assert.equal(writes,0);
});

test('a committed manual receipt with a lost response is acknowledged on retry using the same primary key exactly once',async()=>{
 const rows=new Map(),ids=[];let refreshed=0,lost=true;
 const payload={paidDate:'2026-10-23',clientName:'가상',amount:200000,paymentMethod:'계좌이체',memo:'원본 입금'};
 const create=statementMutation('addSettlement',[],async input=>{
  ids.push(input.id);if(rows.has(input.id))return {error:{code:'23505',message:'duplicate primary key'}};
  rows.set(input.id,{...input,deleted_at:null,user_deleted:false,source_payment_schedule_id:null,source_recovery_id:null});
  if(lost){lost=false;throw Error('response lost after commit')};return {error:null};
 },async()=>{refreshed++},async id=>({data:rows.get(id)||null,error:null}));
 const request='11111111-2222-4333-8444-555555555555';
 await assert.rejects(create(payload,request),/response lost/);assert.equal(rows.size,1);assert.equal(refreshed,0);
 await create(payload,request);assert.equal(rows.size,1);assert.equal(refreshed,1);assert.deepEqual(ids,[request,request]);assert.equal(rows.get(request).amount,200000);
});

for(const patch of [{amount:1},{user_deleted:true},{deleted_at:'2026-10-23T00:00:00Z'},{entry_source:'payment'},{entry_source:'recovery'},{source_recovery_id:'recovery'},{source_payment_schedule_id:'payment'}])test('manual duplicate retry never overwrites or revives a different, linked or deleted receipt '+JSON.stringify(patch),async()=>{
 const payload={paidDate:'2026-10-23',clientName:'가상',amount:200000,paymentMethod:'계좌이체',memo:'원본'};
 const saved={id:'request',payment_date:payload.paidDate,client_name:payload.clientName,amount:payload.amount,payment_method:payload.paymentMethod,memo:payload.memo,entry_source:'manual',entry_type:'계약',deleted_at:null,user_deleted:false,...patch};
 const before=JSON.stringify(saved);let refreshed=0;
 const create=statementMutation('addSettlement',[],async()=>({error:{code:'23505',message:'duplicate'}}),async()=>{refreshed++},async()=>({data:saved,error:null}));
 await assert.rejects(create(payload,'request'),/이미 다른 내용|삭제되었습니다/);assert.equal(refreshed,0);assert.equal(JSON.stringify(saved),before);
});

test('a duplicate confirmation lookup failure remains observable instead of claiming the receipt was saved',async()=>{
 const create=statementMutation('addSettlement',[],async()=>({error:{code:'23505',message:'duplicate'}}),async()=>assert.fail('not confirmed'),async()=>({data:null,error:{message:'lookup denied'}}));
 await assert.rejects(create({paidDate:'2026-10-23'},'request'),/lookup denied/);
});

test('a new manual draft gets a new request ID while an initial direct save lazily retains its retry ID',async()=>{
 const s=data(),ids=[];let fail=true;s.addSettlement=async(_form,id)=>{ids.push(id);if(fail){fail=false;throw Error('unknown network result')}};
 const render=statementEditor(s);await render().saveSettlement();assert.match(render().saveError,/unknown network result/);
 await render().saveSettlement();assert.equal(ids[0],ids[1]);assert.equal(render().open,false);
 render().beginAdd();await render().saveSettlement();assert.notEqual(ids[2],ids[1]);
 render().beginAdd();await render().saveSettlement();assert.notEqual(ids[3],ids[2]);
});
