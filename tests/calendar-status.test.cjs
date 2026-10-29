const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
function compile(source,context={}){return vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{require,exports:{},...context});}
const mod={exports:{}};
compile(fs.readFileSync('lib/calendar-status.ts','utf8'),{module:mod,exports:mod.exports});
const {calendarItemTone,calendarOverdueHistory,isCompletedRepaymentStatus,calendarPaymentRecord}=mod.exports;
const source=fs.readFileSync('app/(admin)/page.tsx','utf8');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const calendar=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='MonthCalendar');
const sortDay=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='sortPaymentDayItems');
assert.ok(sortDay);
const sortPaymentDayItems=compile(sortDay.getText(ast)+';sortPaymentDayItems');
let visibilityHelper;
function findVisibility(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='isVisibleCalendarItem')visibilityHelper=node;ts.forEachChild(node,findVisibility);}
findVisibility(ast);assert.ok(visibilityHelper);
const isVisibleCalendarItem=compile(visibilityHelper.getText(ast)+';isVisibleCalendarItem');

test('payment month summary visibly subtracts outflows and shows separate half-month inflow, outflow and negative net columns',()=>{
 const Component=compile(calendar.getText(ast)+';MonthCalendar',{calendarItemTone,useState:initial=>[initial,()=>{}],Card:({children})=>React.createElement('section',null,children),CalendarDays:()=>null,today:()=> '2026-10-23',shiftMonth:()=> '2026-10',won:value=>'₩'+Number(value).toLocaleString('ko-KR'),sortPaymentDayItems,isLatePaymentItem:()=>false});
 const summary={paid:-50000,inflow:100000,outflow:150000,expected:20000,total:-30000,overdue:0,periods:[{label:'1~15일',paid:100000,inflow:100000,outflow:0,expected:0,total:100000,overdue:0},{label:'16~31일',paid:-150000,inflow:0,outflow:150000,expected:20000,total:-130000,overdue:0}]};
 const html=renderToStaticMarkup(React.createElement(Component,{title:'분납 캘린더',month:'2026-10',onMonthChange:()=>{},items:[],tone:'blue',summary}));
 const text=html.replace(/<[^>]+>/g,'');
 assert.match(text,/이번 달 입금액₩-50,000/);assert.match(text,/받을 예정 금액₩20,000/);assert.match(text,/합산 금액₩-30,000/);
 assert.match(text,/기간입금출금순입금액받을 예정합산/);
 assert.match(text,/1~15일₩100,000₩0₩100,000₩0₩100,000/);
 assert.match(text,/16~31일₩0₩150,000₩-150,000₩20,000₩-130,000/);
});

test('dashboard supplies the display-only lists to both calendars',()=>{
 const items=[];
 function visit(node){
  if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(ast)==='MonthCalendar'){
   const prop=node.attributes.properties.find(property=>ts.isJsxAttribute(property)&&property.name.getText(ast)==='items');
   items.push(prop?.initializer?.expression?.getText(ast));
  }
  ts.forEachChild(node,visit);
 }
 visit(ast);assert.deepEqual(items,['paymentCalendarItems','repaymentCalendarItems']);
});

test('display hides registered overdue boxes while retaining separate unpaid and completed states',()=>{
 for(const status of ['연체','부분납부 후 연체','연체 이력']){
  assert.equal(isVisibleCalendarItem({done:false,status}),false);
  assert.equal(isVisibleCalendarItem({done:false,status:'금액 확인 필요',registeredStatus:status}),false);
  assert.equal(isVisibleCalendarItem({done:true,status}),true);
 }
 for(const status of ['예정','미납','추심','완료','상환완료','종결','입금 확인 필요',undefined])assert.equal(isVisibleCalendarItem({done:false,status}),true);
 assert.equal(isVisibleCalendarItem({done:false,status:'연체 이력',registeredStatus:'미납'}),true);
 assert.equal(isVisibleCalendarItem({done:false,status:'예정',date:'2000-01-01'}),true);
});

test('display hides replaced promise markers while keeping current, confirmation and completed records',()=>{
 for(const status of ['이전 예정','연체 이력'])for(const registeredStatus of ['예정','미납','보류','추심']){
  assert.equal(isVisibleCalendarItem({done:false,history:true,status,registeredStatus}),false);
  assert.equal(isVisibleCalendarItem({done:true,history:true,status,registeredStatus}),true);
 }
 for(const status of ['예정','미납','금액 확인 필요','입금 확인 필요','완료'])assert.equal(isVisibleCalendarItem({done:false,history:true,status,registeredStatus:'예정'}),true);
 assert.equal(isVisibleCalendarItem({done:false,status:'미납',registeredStatus:'미납'}),true);
});

test('registered state controls colors and completed/collection records stay gray',()=>{
 assert.equal(calendarItemTone({done:false,status:'예정',date:'2000-01-01'}),'blue');
 for(const status of ['연체','미납','부분납부 후 연체'])assert.equal(calendarItemTone({done:false,status}),'orange');
 assert.equal(calendarItemTone({done:false,status:'이월',registeredStatus:'연체'}),'orange');
 assert.equal(calendarItemTone({done:true,status:'연체'}),'gray');
 assert.equal(calendarItemTone({done:false,status:'추심'}),'gray');
 assert.equal(calendarItemTone({done:false,status:'이월',registeredStatus:'추심'}),'gray');
});

test('overdue history requires an explicit overdue status and positive original remainder',()=>{
 const position={rootId:'root',state:'rescheduled',remaining:0,rawRemaining:300000,history:true,planned:0,undated:0,unassigned:0};
 for(const status of ['연체','미납','부분납부 후 연체']){
  assert.equal(calendarOverdueHistory({status},position),'rescheduled');
  assert.equal(calendarOverdueHistory({status},{...position,state:'active',history:false}),'unallocated');
 }
 for(const status of ['예정','완료','상환완료','추심','환불',undefined])assert.equal(calendarOverdueHistory({status},position),undefined);
 for(const patch of [{state:'cancelled'},{rawRemaining:0},{remaining:1}])assert.equal(calendarOverdueHistory({status:'연체'},{...position,...patch}),undefined);
 assert.equal(calendarOverdueHistory({status:'연체'}),undefined);
});

test('only explicit completed repayment statuses create completion markers',()=>{
 for(const status of ['상환완료','종결','완료'])assert.equal(isCompletedRepaymentStatus(status),true);
 for(const status of ['예정','연체','미납','부분납부 후 연체','추심','보류','환불','',undefined])assert.equal(isCompletedRepaymentStatus(status),false);
 // Payment confirmation still depends on its actual cash, rather than this repayment-only classifier.
 assert.equal(calendarItemTone({done:false,status:'입금 확인 필요',registeredStatus:'완료'}),'blue');
});

test('payment original records classify missing allocation, empty values, history, settlement, and unverified completion',()=>{
 const row={dueDate:'2026-10-16',dueAmount:500000,paidAmount:200000,allocatedAmount:100000,paidDate:'2026-10-17',status:'예정'},position={state:'active',remaining:0,rawRemaining:200000};
 assert.equal(calendarPaymentRecord(row,position).kind,'unallocated');assert.equal(calendarPaymentRecord(row,position).rawRemaining,200000);
 assert.equal(calendarPaymentRecord(row,{...position,state:'rescheduled'}).kind,'rescheduled');
 assert.equal(calendarPaymentRecord({...row,dueAmount:0,paidAmount:0,allocatedAmount:0},position).kind,'empty');
 assert.equal(calendarPaymentRecord({...row,paidAmount:500000,allocatedAmount:0},position).kind,'settled');
 assert.equal(calendarPaymentRecord({...row,paidAmount:0,allocatedAmount:500000},position).kind,'settled');
 assert.equal(calendarPaymentRecord({...row,status:'완료'},position).kind,'confirmation');
 assert.equal(calendarPaymentRecord(row).kind,'unallocated','a missing customer ledger cannot silently hide a registered date');
 for(const patch of [{dueDate:''},{promiseState:'cancelled'},{status:'환불'},{scheduleType:'환수'},{paidAmount:500000,paidDate:row.dueDate}])assert.equal(calendarPaymentRecord({...row,...patch},position),undefined);
 assert.equal(calendarPaymentRecord(row,{...position,remaining:1}),undefined);assert.equal(calendarPaymentRecord(row,{...position,state:'cancelled'}),undefined);
});

function renderCalendar(tone,popup=false){
 const rows=[{id:'pending',date:'2026-10-01',label:'PendingPast',sub:'planned',done:false,status:'예정',amount:100},{id:'late',date:'2026-10-01',label:'RegisteredLate',sub:'연체 이력 · 합계 제외',done:false,history:true,status:'연체 이력',registeredStatus:'연체',amount:0},{id:'paid',date:'2026-10-01',label:'ActualPaid',sub:'cash',done:true,status:'완료',amount:50}];
 let hook=0;
 const component=compile(calendar.getText(ast)+';MonthCalendar',{
  calendarItemTone,useState:initial=>[++hook===2&&popup?{date:'2026-10-01',rows,top:0,left:0}:initial,()=>{}],
  Card:props=>React.createElement('section',props),CalendarDays:()=>null,
  today:()=> '2026-10-17',shiftMonth:()=> '2026-10',won:value=>String(value),
  sortPaymentDayItems,isLatePaymentItem:()=>true,
 });
 return renderToStaticMarkup(React.createElement(component,{title:'Calendar',month:'2026-10',onMonthChange:()=>{},items:rows,tone}));
}
function rowClass(html,label,popup){const end=html.lastIndexOf(label);assert.ok(end>=0);const start=html.lastIndexOf(popup?'class="rounded-lg border':'class="rounded-md',end);assert.ok(start>=0);return html.slice(start,html.indexOf('"',start+7));}
for(const tone of ['blue','amber']){
 test(tone+' calendar cells use blue pending, orange registered overdue, gray actual cash',()=>{
  const html=renderCalendar(tone);assert.match(rowClass(html,'PendingPast',false),/bg-blue-50/);assert.match(rowClass(html,'RegisteredLate',false),/bg-orange-100/);assert.match(rowClass(html,'ActualPaid',false),/bg-slate-200/);
 });
 test(tone+' pinned calendar details use the same colors',()=>{
  const html=renderCalendar(tone,true);assert.match(rowClass(html,'PendingPast',true),/bg-blue-50/);assert.match(rowClass(html,'RegisteredLate',true),/bg-orange-100/);assert.match(rowClass(html,'ActualPaid',true),/bg-slate-100/);
  assert.equal((html.match(/type="checkbox"/g)||[]).length,tone==='amber'?1:0,'only the active repayment can toggle its problem flag');
  const popupRows=html.slice(html.lastIndexOf('max-h-[174px]')).split('class="rounded-lg border').slice(1);
  assert.doesNotMatch(popupRows.find(row=>row.includes('RegisteredLate')),/type="checkbox"/);
  assert.doesNotMatch(popupRows.find(row=>row.includes('ActualPaid')),/type="checkbox"/);
  if(tone==='amber')assert.match(popupRows.find(row=>row.includes('PendingPast')),/type="checkbox"/);
  assert.match(html,/연체 이력 · 합계 제외/);
  if(tone==='amber')assert.match(html.replace(/<[^>]*>/g,''),/상환 총합\s*150/,'history contributes zero to day total');
 });
 test(tone+' calendar cells never expose a problem checkbox for historical events',()=>{
  assert.doesNotMatch(renderCalendar(tone),/type="checkbox"/);
 });
}

test('day order groups unpaid before completed and sorts both by descending displayed amount without changing source rows',()=>{
 const rows=[
  {id:'paid-high',label:'PaidHigh',done:true,amount:1000,status:'완료'},
  {id:'unpaid-low',label:'UnpaidLow',done:false,amount:100,status:'예정'},
  {id:'paid-low',label:'PaidLow',done:true,amount:50,status:'상환완료'},
  {id:'unpaid-high',label:'UnpaidHigh',done:false,amount:500,status:'미납'},
  {id:'completed-marker',label:'CompletedMarker',done:true,amount:0,status:'종결',history:true},
  {id:'unpaid-mid',label:'UnpaidMid',done:false,amount:300,status:'입금 확인 필요'},
 ];
 const snapshot=JSON.stringify(rows);
 assert.deepEqual(Array.from(sortPaymentDayItems(rows),row=>row.id),['unpaid-high','unpaid-mid','unpaid-low','paid-high','paid-low','completed-marker']);
 assert.equal(JSON.stringify(rows),snapshot);
 const ties=[{id:'na',label:'나',done:false,amount:200},{id:'ga',label:'가',done:false,amount:200}];
 assert.deepEqual(Array.from(sortPaymentDayItems(ties),row=>row.id),['ga','na']);
});

test('repayment sorting puts checked and registered collections after all normal rows while retaining each group order',()=>{
 const rows=[
  {id:'collection',label:'Collection',done:false,amount:900,status:'추심'},
  {id:'checked-complete',label:'CheckedComplete',done:true,amount:2000,status:'상환완료',problem:true},
  {id:'unpaid',label:'Unpaid',done:false,amount:100,status:'예정'},
  {id:'checked',label:'Checked',done:false,amount:500,status:'예정',problem:true},
  {id:'completed',label:'Completed',done:true,amount:1000,status:'상환완료'},
  {id:'registered-collection',label:'RegisteredCollection',done:false,amount:700,status:'금액 확인 필요',registeredStatus:'추심'},
  {id:'closed',label:'Closed',done:true,amount:0,status:'종결'},
 ];
 const snapshot=JSON.stringify(rows);
 assert.deepEqual(Array.from(sortPaymentDayItems(rows,true),row=>row.id),['unpaid','completed','closed','collection','registered-collection','checked','checked-complete']);
 assert.deepEqual(Array.from(sortPaymentDayItems(rows),row=>row.id),['collection','registered-collection','checked','unpaid','checked-complete','completed','closed'],'the payment calendar keeps its existing sort');
 assert.deepEqual(Array.from(sortPaymentDayItems([{id:'na',label:'나',done:false,amount:1,problem:true},{id:'ga',label:'가',done:false,amount:1,status:'추심'}],true),row=>row.id),['ga','na']);
 assert.equal(JSON.stringify(rows),snapshot);
});

function collectionCalendarInteraction(tone,interaction){
 const date='2026-10-01';
 const rows=[
  {id:'collection',date,label:'CollectionStatus',sub:'collection',done:false,status:'추심',amount:300},
  {id:'unpaid',date,label:'NormalUnpaid',sub:'unpaid',done:false,status:'예정',amount:100},
  {id:'registered',date,label:'RegisteredCollection',sub:'registered',done:false,status:'금액 확인 필요',registeredStatus:'추심',amount:400},
  {id:'paid',date,label:'NormalPaid',sub:'paid',done:true,status:'완료',amount:50},
  {id:'checked',date,label:'CheckedProblem',sub:'checked',done:false,status:'예정',problem:true,amount:500},
  {id:'other',date:'2026-10-02',label:'OtherDay',sub:'other',done:false,status:'예정',amount:9999},
 ];
 const snapshot=JSON.stringify(rows),states=[],changes=[];let hook=0;
 const component=compile(calendar.getText(ast)+';MonthCalendar',{
  calendarItemTone,sortPaymentDayItems,isLatePaymentItem:()=>false,
  useState:initial=>{const index=hook++;if(!(index in states))states[index]=initial;return[states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value}];},
  Card:props=>React.createElement('section',props),CalendarDays:()=>null,
  today:()=>date,shiftMonth:()=>date.slice(0,7),won:String,window:{innerWidth:1600,innerHeight:1000},
 });
 const props={title:'Calendar',month:date.slice(0,7),onMonthChange:()=>{},items:rows,tone,onProblemChange:(id,checked)=>changes.push({id,checked})};
 function render(){hook=0;return component(props);}
 function find(tree,predicate){if(!React.isValidElement(tree))return undefined;if(predicate(tree))return tree;let found;React.Children.forEach(tree.props.children,child=>{found ||= find(child,predicate);});return found;}
 const dayCell=find(render(),element=>element.props.onMouseEnter&&renderToStaticMarkup(element).includes('CheckedProblem'));assert.ok(dayCell);
 const expected=tone==='amber'?['unpaid','paid','checked','registered','collection']:['checked','registered','collection','unpaid','paid'];
 const labels=Object.fromEntries(rows.map(row=>[row.id,row.label]));
 const cell=renderToStaticMarkup(dayCell);
 for(let index=0;index<3;index++)assert.match(cell,new RegExp(labels[expected[index]]));
 for(let index=3;index<expected.length;index++)assert.doesNotMatch(cell,new RegExp(labels[expected[index]]));
 dayCell.props[interaction]({currentTarget:{getBoundingClientRect:()=>({right:100,left:0,top:100})},stopPropagation:()=>{}});
 const active=()=>states[interaction==='onClick'?1:0];
 const ids=()=>Array.from(active().rows,row=>row.id);
 assert.deepEqual(ids(),expected);
 function assertPopupOrder(order){const html=renderToStaticMarkup(render()),popup=html.slice(html.lastIndexOf('max-h-[174px]'));for(let index=1;index<order.length;index++)assert.ok(popup.indexOf(labels[order[index-1]])<popup.indexOf(labels[order[index]]));assert.doesNotMatch(popup,/OtherDay/);}
 assertPopupOrder(expected);
 if(tone==='amber'&&interaction==='onClick'){
  function toggle(id,checked){const row=find(render(),element=>typeof element.props.className==='string'&&element.props.className.startsWith('rounded-lg border')&&renderToStaticMarkup(element).includes(labels[id]));assert.ok(row);const checkbox=find(row,element=>element.type==='input'&&element.props.type==='checkbox');assert.ok(checkbox);checkbox.props.onChange({target:{checked}});}
  toggle('unpaid',true);assert.deepEqual(ids(),['paid','checked','registered','collection','unpaid']);assertPopupOrder(ids());
  toggle('unpaid',false);assert.deepEqual(ids(),expected);assertPopupOrder(expected);
  toggle('checked',false);assert.deepEqual(ids(),['checked','unpaid','paid','registered','collection']);assertPopupOrder(ids());
  assert.deepEqual(changes,[{id:'unpaid',checked:true},{id:'unpaid',checked:false},{id:'checked',checked:false}]);
  for(const row of active().rows){const original=rows.find(item=>item.id===row.id);assert.equal(row.amount,original.amount);assert.equal(row.status,original.status);assert.equal(row.done,original.done);}
 }
 assert.equal(JSON.stringify(rows),snapshot);
}

for(const tone of ['blue','amber'])for(const interaction of ['onMouseEnter','onClick'])test(tone+' calendar cells and '+interaction+' details apply collections last only to repayments and immediately resort checkbox changes',()=>collectionCalendarInteraction(tone,interaction));

function calendarInteraction(tone,interaction){
 const date='2026-10-01';
 const rows=[
  {id:'paid-high',date,label:'PaidHigh',sub:'paid-high',done:true,status:'완료',amount:1000},
  {id:'unpaid-low',date,label:'UnpaidLow',sub:'unpaid-low',done:false,status:'예정',amount:100},
  {id:'paid-low',date,label:'PaidLow',sub:'paid-low',done:true,status:'완료',amount:50},
  {id:'unpaid-high',date,label:'UnpaidHigh',sub:'unpaid-high',done:false,status:'미납',amount:500},
  {id:'completed-marker',date,label:'CompletedMarker',sub:'completed-marker',done:true,status:'종결',amount:0,history:true},
  {id:'unpaid-mid',date,label:'UnpaidMid',sub:'unpaid-mid',done:false,status:'예정',amount:300},
  {id:'other-day',date:'2026-10-02',label:'OtherDay',sub:'other-day',done:false,status:'예정',amount:9999},
 ];
 const states=[];let hook=0;
 const component=compile(calendar.getText(ast)+';MonthCalendar',{
  calendarItemTone,sortPaymentDayItems,isLatePaymentItem:row=>!row.done&&(row.status==='연체'||row.status==='미납'),
  useState:initial=>{const index=hook++;if(!(index in states))states[index]=initial;return[states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value}];},
  Card:props=>React.createElement('section',props),CalendarDays:()=>null,
  today:()=>date,shiftMonth:()=>date.slice(0,7),won:String,window:{innerWidth:1600,innerHeight:1000},
 });
 const props={title:'Calendar',month:date.slice(0,7),onMonthChange:()=>{},items:rows,tone};
 function render(){hook=0;return component(props);}
 const tree=render();let dayCell;
 function visit(element){if(!React.isValidElement(element))return;if(element.props.onMouseEnter&&!dayCell&&renderToStaticMarkup(element).includes('UnpaidHigh'))dayCell=element;React.Children.forEach(element.props.children,visit);}
 visit(tree);assert.ok(dayCell);
 const cell=renderToStaticMarkup(dayCell);
 assert.ok(cell.indexOf('UnpaidHigh')<cell.indexOf('UnpaidMid'));
 assert.ok(cell.indexOf('UnpaidMid')<cell.indexOf('UnpaidLow'));
 assert.doesNotMatch(cell,/PaidHigh|PaidLow|CompletedMarker|OtherDay/);
 let stopped=false;
 dayCell.props[interaction]({currentTarget:{getBoundingClientRect:()=>({right:100,left:0,top:100})},stopPropagation:()=>{stopped=true;}});
 const active=states[interaction==='onClick'?1:0];assert.ok(active);
 assert.equal(stopped,interaction==='onClick');
 assert.deepEqual(Array.from(active.rows,row=>row.id),['unpaid-high','unpaid-mid','unpaid-low','paid-high','paid-low','completed-marker']);
 const html=renderToStaticMarkup(render());
 const popup=html.slice(html.lastIndexOf('max-h-[174px]'));
 const expected=['UnpaidHigh','UnpaidMid','UnpaidLow','PaidHigh','PaidLow','CompletedMarker'];
 for(let index=1;index<expected.length;index++)assert.ok(popup.indexOf(expected[index-1])<popup.indexOf(expected[index]));
 assert.doesNotMatch(popup,/OtherDay/);
}

for(const tone of ['blue','amber'])for(const interaction of ['onMouseEnter','onClick'])test(tone+' calendar day cells and '+interaction+' popup share unpaid-first amount-descending order',()=>calendarInteraction(tone,interaction));

test('current schedule mapping uses the shared ledger balance and preserves registered overdue state',()=>{
 let expression;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='paymentScheduleItems')expression=node.initializer;ts.forEachChild(node,visit);}visit(ast);assert.ok(expression);
 const parent={id:'p',customerId:'c',status:'연체',dueDate:'2026-10-01',dueAmount:100,paidAmount:0};
 const items=compile('const result='+expression.getText(ast)+';result',{
  paymentMonthSchedules:[parent],s:{customers:[],payments:[parent]},
  duplicateCustomerTag:()=>'',won:String,remaining:()=>30,paymentRemaining:p=>Math.max(0,p.dueAmount-p.paidAmount-(p.allocatedAmount||0)),
 });
 assert.equal(items[0].status,'연체');assert.equal(items[0].registeredStatus,'연체');assert.equal(calendarItemTone(items[0]),'orange');assert.equal(items[0].amount,30);
 assert.match(items[0].sub,/30/);assert.match(items[0].sub,/100/,'registered and effective amounts are both visible when capped');
});
