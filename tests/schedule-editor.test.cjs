const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const vm=require('node:vm');

function parse(file){return ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)}
const ui=parse('components/ui.tsx');
const page=parse('app/(admin)/[section]/page.tsx');
function loadModule(file){const loaded={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:loaded,exports:loaded.exports,Map,Set,Date,Number,Error});return loaded.exports}
const ledgerApi=loadModule('lib/schedule-ledger.ts');
const planApi=loadModule('lib/schedule-plans.ts');
function component(ast,name){const node=ast.statements.find(item=>ts.isFunctionDeclaration(item)&&item.name?.text===name);assert.ok(node,`${name} exists`);return node}
function execute(source,context){return vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS}}).outputText,context)}
function productionValue(name){let initializer;for(const statement of page.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)if(declaration.name.getText(page)===name)initializer=declaration.initializer;assert.ok(initializer,`${name} production value exists`);return execute('const value='+initializer.getText(page)+';value',{})}
const paymentStatuses=productionValue('paymentStatuses'),repaymentStatuses=productionValue('repaymentStatuses');
function nodes(element){if(Array.isArray(element))return element.flatMap(nodes);if(!element||typeof element!=='object')return [];return [element,...(element.props?.children||[]).flatMap(nodes)]}

// Execute the production component with element/hook adapters. The fake DOM
// supplies only the pending-descendant query used by the actual close handler.
function modal({busy=false,inline=false,descendant=false}={}){
 const state={closed:0,prevented:0,stopped:0,descendant};
 const context={React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},InlineModalContext:{},useContext:()=>inline,useRef:()=>({current:{querySelector:()=>state.descendant}}),useEffect:()=>{},cn:(...items)=>items.join(' ')};
 const render=execute(component(ui,'Modal').getText(ui).replace('export ','')+';Modal',context);
 const tree=render({open:true,title:'Schedule editor',children:'fields',onClose:()=>{state.closed++},busy});
 return {tree,state,field:nodes(tree).find(node=>node.type==='fieldset'),header:nodes(tree).find(node=>node.type==='button'),click:()=>tree.props.onClickCapture({preventDefault:()=>state.prevented++,stopPropagation:()=>state.stopped++})};
}

test('pending schedule save disables its form and blocks backdrop and header close',()=>{
 const editor=modal({busy:true});
 assert.equal(editor.field.props.disabled,true);
 assert.equal(editor.field.props['data-admin-save-pending'],'true');
 assert.equal(editor.header.props.disabled,true);
 editor.tree.props.onMouseDown();editor.header.props.onClick();editor.click();
 assert.equal(editor.state.closed,0);
 assert.equal(editor.state.prevented,1);
 assert.equal(editor.state.stopped,1);
});
test('ordinary idle modals retain working backdrop and header close',()=>{
 const editor=modal();
 assert.equal(editor.field.props.disabled,false);
 assert.equal(editor.field.props['data-admin-save-pending'],undefined);
 editor.tree.props.onMouseDown();editor.header.props.onClick();editor.click();
 assert.equal(editor.state.closed,2);
 assert.equal(editor.state.prevented,0);
 assert.equal(editor.state.stopped,0);
});
test('inline schedule save exposes a disabled pending fieldset to its enclosing modal',()=>{
 const editor=modal({inline:true,busy:true});
 assert.equal(editor.field.props.disabled,true);
 assert.equal(editor.field.props['data-admin-save-pending'],'true');
 assert.equal(editor.header,undefined);
});
test('pending inline schedule blocks ancestor backdrop, header, and tab clicks until it settles',()=>{
 const editor=modal({descendant:true});
 editor.tree.props.onMouseDown();editor.header.props.onClick();editor.click();
 assert.equal(editor.state.closed,0);
 assert.equal(editor.state.prevented,1);
 assert.equal(editor.state.stopped,1);
 editor.state.descendant=false;
 editor.header.props.onClick();
 assert.equal(editor.state.closed,1);
});

// Render the actual TSX editor with deterministic hooks; inspect actual controls,
// invoke their event handlers and run the actual save callback against a spy store.
function textContent(node){if(node==null)return '';if(typeof node!=='object')return String(node);if(Array.isArray(node))return node.map(textContent).join('');return textContent(node.props?.children)}
function scheduleEditor(kind,seedRows,options={}){
 const name=kind==='payment'?'PaymentScheduleModal':'RepaymentScheduleModal';
 const customer={id:'customer',name:'검증 고객',contractAmount:500000,lenderCount:1,...options.customer};
 const calls=[],alerts=[],cells=[];let cursor=0,effects=[],dirty=false,tree,closed=0;
 const store={payments:kind==='payment'?seedRows:[],repayments:kind==='repayment'?seedRows:[],customers:[customer],
  saveCustomerPaymentsAtomic:async(...args)=>{calls.push(args);if(options.failSave)throw new Error('저장 실패');},
  saveCustomerRepaymentsAtomic:async(...args)=>{calls.push(args);if(options.failSave)throw new Error('저장 실패');}};
 const context={React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},useAdminStore:()=>store,
  useState(initial){const i=cursor++;if(!cells[i])cells[i]={value:typeof initial==='function'?initial():initial};return [cells[i].value,value=>{cells[i].value=typeof value==='function'?value(cells[i].value):value;dirty=true}]},
  useRef(initial){const i=cursor++;return cells[i]||(cells[i]={current:initial})},
  useEffect(fn,deps){const i=cursor++;if(!cells[i]||deps.some((value,j)=>value!==cells[i].deps[j])){cells[i]={deps};effects.push(fn)}},
  useMemo:fn=>fn(),...ledgerApi,...planApi,Map,Set,Number,Object,Array,Error,
  Modal:'Modal',Button:'Button',Badge:'Badge',Label:'Label',NumberInput:'NumberInput',Plus:'Plus',ScheduleMoneyPreview:'ScheduleMoneyPreview',
  field:'field',paymentMethods:['계좌이체'],paymentStatuses,repaymentStatuses,contactTypes:['번호'],
  today:()=> '2026-10-17',won:value=>String(value),formatPhone:value=>value,repaymentDisplayStatus:status=>status,
  customerCumulativePaid:()=>0,customerCredit:()=>0,paymentRemaining:row=>Math.max(0,row.dueAmount-row.paidAmount-(row.allocatedAmount||0)),paymentCompletionIssue:()=>'',customerPaid:rows=>rows.reduce((sum,row)=>sum+(row.paidAmount||0),0),customerOutstanding:()=>300000,
  alert:value=>alerts.push(value),window:{confirm:()=>options.confirmRemoval??false}};
 const renderComponent=execute(component(page,name).getText(page)+';'+name,context);
 function render(){let count=0;do{dirty=false;cursor=0;effects=[];tree=renderComponent({open:true,customer,initialScheduleId:options.initialScheduleId,onClose:()=>closed++});for(const effect of effects)effect();assert.ok(++count<8,'editor renders settle')}while(dirty);return tree}
 render();
 return {render,calls,alerts,store,get closed(){return closed},get tree(){return tree},get nodes(){return nodes(tree)},
  button(label){const node=nodes(tree).find(node=>['button','Button'].includes(node.type)&&textContent(node)===label);assert.ok(node,`button ${label} exists`);return node},
  control(label){const node=nodes(tree).find(node=>node.type==='Label'&&node.props.text===label);assert.ok(node,`label ${label} exists`);return nodes(node).find(child=>['input','select','NumberInput'].includes(child.type))},
  get preview(){return nodes(tree).find(node=>node.type==='ScheduleMoneyPreview').props}};
}
function collectionPage(kind,seedRows,options={}){
 const customer={id:'customer',name:'검증 고객',phone:'01000000000',contractAmount:500000,lenderCount:1};
 const calls=[];
 const store={customers:[customer],payments:kind==='payment'?seedRows:[],repayments:kind==='repayment'?seedRows:[]};
 for(const name of ['deletePayment','deleteRepayment','cancelCompletedPayment','cancelCompletedRepayment'])store[name]=async(...args)=>{calls.push({name,args});if(options.failCancel)throw Error('입금 기록이 변경되었습니다.')};
 const cells=[];let cursor=0,tree;
 const context={React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},useAdminStore:()=>store,
  useState(initial){const i=cursor++;if(!(i in cells))cells[i]={value:typeof initial==='function'?initial():initial};return [cells[i].value,next=>{cells[i].value=typeof next==='function'?next(cells[i].value):next}]},
  useRef(initial){const i=cursor++;return cells[i]??={current:initial}},useMemo:fn=>fn(),...ledgerApi,
  emptyPayment:productionValue('emptyPayment'),emptyNewPaymentRow:productionValue('emptyNewPaymentRow'),paymentStatuses,repaymentStatuses,paymentMethods:['계좌이체'],
  isEformSignedStatus:()=>true,newestFirst:()=>0,pageRows:rows=>rows,won:String,paymentCompletionIssue:()=>'',customerPaid:rows=>rows.reduce((sum,row)=>sum+(row.paidAmount||0),0),customerOutstanding:rows=>500000-rows.reduce((sum,row)=>sum+(row.paidAmount||0),0),field:'field',
 };
 for(const name of ['PageHeader','Card','SearchBox','Button','Badge','CustomerNameCell','Pagination','Modal','Label','NumberInput','CustomerPicker','UserRoundSearch','Plus','PaymentScheduleModal','RepaymentScheduleModal','RepaymentEdit','ConfirmDelete','ScheduleMoneyPreview','RecoveriesModal','AdditionalContractsModal','PaymentOverplanned'])context[name]=name;
 const renderComponent=execute(component(page,kind==='payment'?'Payments':'Repayments').getText(page)+';'+(kind==='payment'?'Payments':'Repayments'),context);
 function render(){cursor=0;tree=renderComponent();return tree}
 render();return {store,calls,render,get tree(){return tree}};
}
const paymentSeed=(patch={})=>({id:'root',customerId:'customer',dueDate:'2026-10-16',dueAmount:500000,paidDate:'2026-10-16',paidAmount:200000,status:'연체',memo:'',paymentMethod:'계좌이체',settlementMemo:'',rowVersion:7,dateChangeCount:2,...patch});
const repaymentSeed=(patch={})=>({id:'root',customerId:'customer',dueDate:'2026-10-16',amount:500000,paidDate:'2026-10-16',paidAmount:200000,status:'연체',memo:'',lenderName:'검증업체',contactType:'번호',contactValue:'',account:'',rowVersion:7,dateChangeCount:2,...patch});
const plain=value=>JSON.parse(JSON.stringify(value));
const enabledStatusOptions=select=>nodes(select).filter(node=>node.type==='option'&&!node.props.disabled).map(node=>node.props.value??textContent(node));

test('payment and repayment status choices retain their respective supported states',()=>{
 assert.deepEqual(Array.from(paymentStatuses),['예정','완료','연체','미납','환불']);
 assert.deepEqual(Array.from(repaymentStatuses),['예정','상환완료','연체','보류','추심','종결']);
 for(const status of ['예정','완료','미납']){
  const editor=scheduleEditor('payment',[paymentSeed({status})]);assert.equal(enabledStatusOptions(editor.control('상태')).includes('연체'),true);
 }
 const page=collectionPage('payment',[]);const header=nodes(page.tree).find(node=>node.type==='PageHeader');header.props.action.props.onClick();page.render();
 const modal=nodes(page.tree).find(node=>node.type==='Modal'&&node.props.title==='입금 일정 추가');assert.equal(modal.props.open,true);
 const status=nodes(modal).find(node=>node.type==='Label'&&node.props.text==='상태');const select=nodes(status).find(node=>node.type==='select');assert.equal(select.props.value,'예정');assert.equal(enabledStatusOptions(select).includes('연체'),true);
});

const scheduleTabNames=['예정','연체','추심','완료','상환완료'];
function scheduleTabs(editor){return editor.nodes.filter(node=>node.type==='button'&&scheduleTabNames.includes(node.props.key))}
function selectedScheduleTab(editor){return scheduleTabs(editor).find(node=>node.props.className.includes('text-white'))?.props.key}
function scheduleRowButtons(editor){const aside=editor.nodes.find(node=>node.type==='aside');return nodes(aside).filter(node=>node.type==='button'&&node.props.key&&!scheduleTabNames.includes(node.props.key))}

for(const status of ['예정','상환완료','추심','종결'])test('repayment editor retains the original Ropower supported statuses for '+status,()=>{
 const editor=scheduleEditor('repayment',[repaymentSeed({status})]),select=editor.control('상태');
 assert.equal(select.props.value,status);assert.equal(select.props.disabled,false);
 assert.deepEqual(enabledStatusOptions(select),['예정','상환완료','연체','보류','추심','종결']);
 assert.equal(nodes(select).some(node=>node.type==='option'&&node.props.disabled),false);
});

for(const status of ['연체','보류']){
 test('a legacy repayment '+status+' stays pending and retains its selectable original state',()=>{
  const editor=scheduleEditor('repayment',[repaymentSeed({status})]),select=editor.control('상태');
  const legacy=nodes(select).find(node=>node.type==='option'&&(node.props.value??textContent(node))===status);
  assert.equal(selectedScheduleTab(editor),'예정');assert.equal(select.props.value,status);assert.equal(select.props.disabled,false);
  assert.ok(legacy);assert.notEqual(legacy.props.disabled,true);assert.notEqual(legacy.props.hidden,true);assert.equal(textContent(legacy),status);
  assert.deepEqual(enabledStatusOptions(select),['예정','상환완료','연체','보류','추심','종결']);
  assert.equal(editor.calls.length,0);assert.equal(editor.preview.after.totals.paid,200000);
 });
 for(const field of ['메모','상환 예정금액','상환 예정일'])test('saving '+field+' preserves a legacy repayment '+status+' and its real receipt',async()=>{
  const editor=scheduleEditor('repayment',[repaymentSeed({status})]);
  editor.control(field).props.onChange(field==='상환 예정금액'?600000:{target:{value:field==='메모'?'메모 정정':'2026-10-25'}});editor.render();
  assert.equal(selectedScheduleTab(editor),'예정');await editor.button('일정 저장').props.onClick();
  assert.equal(editor.calls.length,1);const saved=editor.calls[0][1][0];
  assert.equal(saved.status,status);assert.equal(saved.paidAmount,200000);assert.equal(saved.paidDate,'2026-10-16');
  assert.equal(editor.calls[0][4].root,7);assert.equal(editor.preview.after.totals.paid,200000);assert.equal(editor.preview.after.totals.remaining,300000);
 });
}

test('repayment tabs separate active collections and keep historical receipts with completed records',()=>{
 const editor=scheduleEditor('repayment',[
  repaymentSeed({id:'collection',lenderName:'추심 업체',status:'추심'}),
  repaymentSeed({id:'pending',lenderName:'예정 업체',status:'예정'}),
  repaymentSeed({id:'legacy-overdue',status:'연체'}),repaymentSeed({id:'legacy-hold',status:'보류'}),
  repaymentSeed({id:'complete',status:'상환완료'}),repaymentSeed({id:'closed',status:'종결'}),
  repaymentSeed({id:'cancelled-paid',status:'추심',promiseState:'cancelled'}),
  repaymentSeed({id:'rescheduled-paid',status:'추심',promiseState:'rescheduled'}),
  repaymentSeed({id:'cancelled-empty',status:'추심',promiseState:'cancelled',paidAmount:0,paidDate:''}),
  repaymentSeed({id:'rescheduled-empty',status:'추심',promiseState:'rescheduled',paidAmount:0,paidDate:''}),
 ]);
 assert.deepEqual(scheduleTabs(editor).map(textContent),['예정 (3)','추심 (1)','상환완료 (4)']);
 assert.equal(selectedScheduleTab(editor),'예정');assert.deepEqual(scheduleRowButtons(editor).map(node=>node.props.key),['legacy-hold','legacy-overdue','pending']);
 editor.button('추심 (1)').props.onClick();editor.render();
 assert.equal(selectedScheduleTab(editor),'추심');assert.deepEqual(scheduleRowButtons(editor).map(node=>node.props.key),['collection']);assert.equal(editor.control('업체명').props.value,'추심 업체');
 editor.button('상환완료 (4)').props.onClick();editor.render();
 assert.deepEqual(scheduleRowButtons(editor).map(node=>node.props.key),['cancelled-paid','closed','complete','rescheduled-paid']);
 assert.equal(editor.control('상태').props.disabled,true);assert.equal(editor.control('실제 상환액').props.value,200000);
 assert.equal(editor.preview.after.totals.paid,1600000);
});

test('initial repayment selection prefers a pending promise over an earlier collection',()=>{
 const editor=scheduleEditor('repayment',[
  repaymentSeed({id:'collection',dueDate:'2026-10-15',lenderName:'먼저 등록된 추심',status:'추심'}),
  repaymentSeed({id:'pending',dueDate:'2026-10-20',lenderName:'현재 예정',status:'예정'}),
 ]);
 assert.equal(selectedScheduleTab(editor),'예정');assert.equal(editor.control('업체명').props.value,'현재 예정');
 assert.deepEqual(scheduleRowButtons(editor).map(node=>node.props.key),['pending']);
});

test('initial repayment selection prefers active collections over older completed and historical receipts',()=>{
 const editor=scheduleEditor('repayment',[
  repaymentSeed({id:'historical',dueDate:'2026-10-10',status:'추심',promiseState:'cancelled'}),
  repaymentSeed({id:'completed',dueDate:'2026-10-12',status:'상환완료'}),
  repaymentSeed({id:'collection',dueDate:'2026-10-20',lenderName:'현재 추심',status:'추심'}),
 ]);
 assert.equal(selectedScheduleTab(editor),'추심');assert.equal(editor.control('업체명').props.value,'현재 추심');
 assert.deepEqual(scheduleRowButtons(editor).map(node=>node.props.key),['collection']);assert.ok(editor.button('상환완료 (2)'));
});

test('a collections-only repayment customer opens the collections tab and can select each row',()=>{
 const editor=scheduleEditor('repayment',[
  repaymentSeed({id:'second',dueDate:'2026-10-20',lenderName:'두 번째 추심',status:'추심'}),
  repaymentSeed({id:'first',dueDate:'2026-10-15',lenderName:'첫 추심',status:'추심'}),
 ]);
 assert.equal(selectedScheduleTab(editor),'추심');assert.equal(editor.control('업체명').props.value,'첫 추심');assert.ok(editor.button('예정 (0)'));
 const second=scheduleRowButtons(editor).find(node=>node.props.key==='second');second.props.onClick();editor.render();
 assert.equal(editor.control('업체명').props.value,'두 번째 추심');assert.equal(selectedScheduleTab(editor),'추심');
 editor.button('예정 (0)').props.onClick();editor.render();
 assert.equal(editor.nodes.some(node=>node.type==='Label'&&node.props.text==='상태'),false);assert.match(textContent(editor.tree),/해당 일정이 없습니다/);
 editor.button('추심 (2)').props.onClick();editor.render();assert.equal(editor.control('업체명').props.value,'첫 추심');
});

for(const history of [undefined,'cancelled','rescheduled'])test('an explicit repayment id opens its exact '+(history||'active collection')+' record instead of the pending default',()=>{
 const editor=scheduleEditor('repayment',[
  repaymentSeed({id:'pending',lenderName:'기본 예정',status:'예정',dueDate:'2026-10-15'}),
  repaymentSeed({id:'requested',lenderName:'지정 업체',status:'추심',promiseState:history,dueDate:'2026-10-20'}),
 ],{initialScheduleId:'requested'});
 assert.equal(editor.control('업체명').props.value,'지정 업체');assert.equal(editor.control('상태').props.value,'추심');
 assert.equal(selectedScheduleTab(editor),history?'상환완료':'추심');assert.equal(editor.control('상태').props.disabled,Boolean(history));
 assert.deepEqual(scheduleRowButtons(editor).map(node=>node.props.key),['requested']);assert.equal(editor.preview.after.totals.paid,400000);
});

for(const complete of ['상환완료','종결'])test('repayment status changes move the selected row between tabs without inferring cash: '+complete,async()=>{
 const editor=scheduleEditor('repayment',[repaymentSeed({status:'예정',paidAmount:0,paidDate:''})]);
 editor.control('상태').props.onChange({target:{value:'추심'}});editor.render();
 assert.equal(selectedScheduleTab(editor),'추심');assert.deepEqual(scheduleTabs(editor).map(textContent),['예정 (0)','추심 (1)','상환완료 (0)']);
 assert.equal(editor.control('실제 상환액').props.value,0);assert.equal(editor.control('실제 상환일').props.value,'');
 editor.control('상태').props.onChange({target:{value:complete}});editor.render();
 assert.equal(selectedScheduleTab(editor),'상환완료');assert.deepEqual(scheduleTabs(editor).map(textContent),['예정 (0)','추심 (0)','상환완료 (1)']);
 await editor.button('일정 저장').props.onClick();const saved=editor.calls[0][1][0];
 assert.equal(saved.status,complete);assert.equal(saved.paidAmount,0);assert.equal(saved.paidDate,'');assert.equal(editor.calls[0][4].root,7);
});

test('a repayment collection can explicitly return to pending without changing its receipt',async()=>{
 const editor=scheduleEditor('repayment',[repaymentSeed({status:'추심'})]);
 editor.control('상태').props.onChange({target:{value:'예정'}});editor.render();
 assert.equal(selectedScheduleTab(editor),'예정');assert.deepEqual(scheduleTabs(editor).map(textContent),['예정 (1)','추심 (0)','상환완료 (0)']);
 await editor.button('일정 저장').props.onClick();const saved=editor.calls[0][1][0];
 assert.equal(saved.status,'예정');assert.equal(saved.paidAmount,200000);assert.equal(saved.paidDate,'2026-10-16');
});

test('adding a repayment from collections selects a separate pending row and preserves the collection receipt',async()=>{
 const original=repaymentSeed({status:'추심'}),editor=scheduleEditor('repayment',[original]);
 assert.equal(selectedScheduleTab(editor),'추심');editor.button('일정 추가').props.onClick();editor.render();
 assert.equal(selectedScheduleTab(editor),'예정');assert.deepEqual(scheduleTabs(editor).map(textContent),['예정 (1)','추심 (1)','상환완료 (0)']);
 assert.equal(editor.control('상태').props.value,'예정');assert.equal(editor.control('업체명').props.value,'');
 assert.equal(editor.control('실제 상환액').props.value,0);assert.equal(editor.control('실제 상환일').props.value,'');
 editor.control('업체명').props.onChange({target:{value:'새 예정 업체'}});editor.render();
 editor.control('상환 예정일').props.onChange({target:{value:'2026-10-25'}});editor.render();
 editor.control('상환 예정금액').props.onChange(300000);editor.render();
 await editor.button('일정 저장').props.onClick();const saved=editor.calls[0][1];
 assert.deepEqual(plain(saved.find(row=>row.id==='root')),original);
 const added=saved.find(row=>!row.id);assert.equal(added.status,'예정');assert.equal(added.paidAmount,0);assert.equal(added.promiseState,'active');assert.equal(added.rescheduledFromId,undefined);
});

test('payment editor keeps its original overdue tab while repayment uses collections',()=>{
 const editor=scheduleEditor('payment',[paymentSeed()]);
 assert.deepEqual(scheduleTabs(editor).map(textContent),['예정 (0)','연체 (1)','완료 (0)']);assert.equal(selectedScheduleTab(editor),'연체');
 assert.equal(enabledStatusOptions(editor.control('상태')).includes('추심'),false);assert.equal(editor.control('상태').props.value,'연체');
});

test('an existing overdue payment retains its selectable original status',()=>{
 const editor=scheduleEditor('payment',[paymentSeed()]),select=editor.control('상태'),legacy=nodes(select).find(node=>node.type==='option'&&(node.props.value??textContent(node))==='연체');
 assert.equal(select.props.value,'연체');assert.ok(legacy);assert.notEqual(legacy.props.disabled,true);assert.notEqual(legacy.props.hidden,true);assert.equal(textContent(legacy),'연체');assert.equal(enabledStatusOptions(select).includes('연체'),true);
});

for(const field of ['메모','납부 예정금액','납부 예정일'])test('saving '+field+' on an overdue payment preserves its status and cash facts',async()=>{
 const editor=scheduleEditor('payment',[paymentSeed()]);
 editor.control(field).props.onChange(field==='납부 예정금액'?600000:{target:{value:field==='메모'?'메모 정정':'2026-10-25'}});editor.render();
 await editor.button('전체 일정 저장').props.onClick();const saved=editor.calls[0][1][0];
 assert.equal(saved.status,'연체');assert.equal(saved.paidAmount,200000);assert.equal(saved.paidDate,'2026-10-16');assert.equal(editor.calls[0][4].root,7);assert.equal(editor.preview.after.totals.paid,200000);assert.equal(editor.preview.after.totals.remaining,300000);
});

test('an overdue payment changes to pending only after an explicit selection',async()=>{
 const editor=scheduleEditor('payment',[paymentSeed()]);editor.control('상태').props.onChange({target:{value:'예정'}});editor.render();
 assert.equal(editor.control('상태').props.value,'예정');assert.equal(enabledStatusOptions(editor.control('상태')).includes('연체'),true);
 await editor.button('전체 일정 저장').props.onClick();assert.equal(editor.calls[0][1][0].status,'예정');assert.equal(editor.calls[0][1][0].paidAmount,200000);assert.equal(editor.calls[0][1][0].paidDate,'2026-10-16');
});

test('the horizontal payment table removes only its promise-balance column and keeps aligned financial cells',()=>{
 const row=paymentSeed(),screen=collectionPage('payment',[row]);
 const table=nodes(screen.tree).find(node=>node.type==='table'&&nodes(node).some(child=>child.type==='th'&&textContent(child)==='예정일'));
 const headers=nodes(table).filter(node=>node.type==='th').map(textContent),body=nodes(table).find(node=>node.type==='tr'&&nodes(node).some(child=>child.type==='td'));
 assert.equal(headers.includes('현재 약속 잔액'),false);for(const label of ['미수금','입금일','실입금액','연체 횟수'])assert.equal(headers.includes(label),true);
 assert.equal(headers.length,15);assert.equal(nodes(body).filter(node=>node.type==='td').length,headers.length);assert.match(table.props.className,/admin-responsive-table.*w-full/);assert.match(textContent(body),/300000/);assert.match(textContent(body),/200000/);assert.equal(screen.store.payments[0],row);
 const repaymentTable=nodes(collectionPage('repayment',[repaymentSeed()]).tree).find(node=>node.type==='table'&&nodes(node).some(child=>child.type==='th'&&textContent(child)==='상환일'));
 assert.equal(nodes(repaymentTable).some(node=>node.type==='th'&&textContent(node)==='현재 약속 잔액'),true);
});
for(const [componentName,complete,statusKey] of [['Payments','완료','status'],['Repayments','상환완료','status']]){
 test(componentName+' places cancelled cash records in its completed list without showing them as pending plans',()=>{
  const owner=component(page,componentName);let initializer;
  for(const statement of owner.body.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)if(declaration.name.getText(page)==='matchesTab')initializer=declaration.initializer;
  assert.ok(initializer);const matches=execute('const matches='+initializer.getText(page)+';matches',{history:row=>row.promiseState==='cancelled'||row.promiseState==='rescheduled'});
  const old={promiseState:'cancelled',paidAmount:200000,[statusKey]:'연체'};
  assert.equal(matches(old,complete),true);assert.equal(matches(old,'예정'),false);assert.equal(matches({...old,paidAmount:0},complete),false);
  assert.equal(matches({promiseState:'active',paidAmount:0,[statusKey]:'예정'},'예정'),true);
 });
}
for(const kind of ['payment','repayment']){
 const seed=kind==='payment'?paymentSeed:repaymentSeed,complete=kind==='payment'?'완료':'상환완료';
 const button=(screen,label)=>{const found=nodes(screen.tree).find(node=>node.type==='Button'&&textContent(node)===label);assert.ok(found,`${kind} ${label} exists`);return found};
 function completed(screen){const tab=nodes(screen.tree).find(node=>node.type==='Button'&&textContent(node).startsWith(complete+' ('));assert.ok(tab);tab.props.onClick();screen.render()}
 for(const patch of [{status:complete},{status:'연체',promiseState:'cancelled'},{status:'연체',promiseState:'rescheduled'},{status:complete,paidAmount:0,paidDate:''}]){
  test(kind+' completed record cancellation confirms its exact amount and version '+JSON.stringify(patch),async()=>{
   const row=seed(patch),screen=collectionPage(kind,[row]);completed(screen);
   assert.equal(nodes(screen.tree).some(node=>node.type==='Button'&&textContent(node)==='일정 삭제'),false);
   button(screen,'기록 삭제').props.onClick();screen.render();assert.equal(screen.calls.length,0);
   const confirmation=nodes(screen.tree).find(node=>node.type==='ConfirmDelete'&&node.props.open);
   assert.ok(confirmation);assert.match(confirmation.props.label,kind==='payment'?/실제 입금 기록/:/실제 상환 기록/);
   assert.match(confirmation.props.description,new RegExp(String(row.paidAmount)));assert.match(confirmation.props.description,/다시 계산/);assert.match(confirmation.props.description,/약속도 취소/);
   await confirmation.props.onConfirm();assert.deepEqual(plain(screen.calls),[{name:kind==='payment'?'cancelCompletedPayment':'cancelCompletedRepayment',args:[row.id,7]}]);
   assert.equal(screen.store[kind==='payment'?'payments':'repayments'][0],row);
  });
 }
 test(kind+' pending schedule deletion still preserves its cash through the original promise API',async()=>{
  const row=seed({status:'예정'}),screen=collectionPage(kind,[row]);button(screen,'일정 삭제').props.onClick();screen.render();
  const confirmation=nodes(screen.tree).find(node=>node.type==='ConfirmDelete'&&node.props.open);assert.match(confirmation.props.label,/보존/);
  await confirmation.props.onConfirm();assert.deepEqual(plain(screen.calls),[{name:kind==='payment'?'deletePayment':'deleteRepayment',args:[row.id]}]);
 });
 test(kind+' failed record cancellation leaves the same selected record available for retry',async()=>{
  const screen=collectionPage(kind,[seed({status:complete})],{failCancel:true});completed(screen);button(screen,'기록 삭제').props.onClick();screen.render();
  const confirmation=nodes(screen.tree).find(node=>node.type==='ConfirmDelete'&&node.props.open);
  await assert.rejects(confirmation.props.onConfirm(),/변경되었습니다/);screen.render();
  assert.equal(nodes(screen.tree).find(node=>node.type==='ConfirmDelete'&&node.props.open).props.name,confirmation.props.name);
 });
 test(kind+' customer completed editor stages actual record cancellation together with a sibling draft change',async()=>{
  const sibling=seed({id:'sibling',dueDate:'2026-10-24',status:'예정',paidAmount:0,paidDate:'',obligationAmount:250000,...(kind==='payment'?{dueAmount:250000}:{amount:250000})});
  const editor=scheduleEditor(kind,[seed({status:complete,obligationAmount:500000}),sibling],{initialScheduleId:'sibling',confirmRemoval:true});
  editor.control('메모').props.onChange({target:{value:'보존할 수정'}});editor.render();
  editor.button(complete+' (1)').props.onClick();editor.render();
  assert.equal(editor.nodes.some(node=>node.type==='Button'&&textContent(node)==='일정 삭제'),false);
  editor.button('기록 삭제').props.onClick();editor.render();
  assert.equal(editor.calls.length,0);assert.equal(editor.closed,0);assert.match(textContent(editor.tree),/기록 삭제 예정/);
  assert.equal(editor.button('기록 삭제').props.disabled,true);assert.equal(editor.preview.after.totals.paid,0);
  assert.equal(editor.preview.after.totals.owed,kind==='payment'?500000:750000);
  await editor.button(kind==='payment'?'전체 일정 저장':'일정 저장').props.onClick();
  const saved=editor.calls[0][1],cancelled=saved.find(row=>row.id==='root');
  assert.equal(cancelled.paidAmount,0);assert.equal(cancelled.paidDate,'');assert.equal(cancelled.status,'예정');assert.equal(cancelled.promiseState,'cancelled');
  assert.equal(cancelled.obligationAmount,500000);assert.equal(cancelled.rowVersion,7);assert.equal(saved.find(row=>row.id==='sibling').memo,'보존할 수정');
 });
 test(kind+' declining customer completed record cancellation keeps the original cash and draft unchanged',()=>{
  const editor=scheduleEditor(kind,[seed({status:complete})],{confirmRemoval:false});editor.button('기록 삭제').props.onClick();editor.render();
  assert.equal(editor.preview.after.totals.paid,200000);assert.equal(editor.calls.length,0);assert.equal(editor.closed,0);
 });
 test(kind+' customer editor cancels a historical receipt while preserving its successor and obligation',async()=>{
  const original=seed({promiseState:'rescheduled',obligationAmount:500000}),child=seed({id:'child',rescheduledFromId:'root',rootScheduleId:'root',dueDate:'2026-10-24',status:'예정',paidAmount:0,paidDate:'',...(kind==='payment'?{dueAmount:300000}:{amount:300000})});
  const editor=scheduleEditor(kind,[original,child],{initialScheduleId:'root',confirmRemoval:true});editor.button('기록 삭제').props.onClick();editor.render();
  assert.equal(editor.preview.after.totals.paid,0);assert.equal(editor.preview.after.totals.owed,500000);assert.equal(editor.preview.after.totals.planned,300000);
  await editor.button(kind==='payment'?'전체 일정 저장':'일정 저장').props.onClick();
  assert.deepEqual(plain(editor.calls[0][1].find(row=>row.id==='child')),kind==='payment'?{...child,settlementMemo:''}:child);
  assert.equal(editor.calls[0][1].find(row=>row.id==='root').promiseState,'cancelled');
 });
}
for(const [patch,label,modalName] of [
 [{scheduleType:'환수'},'환수 관리','RecoveriesModal'],
 [{scheduleType:'일반',sourceRecoveryId:'recovery-source'},'환수 관리','RecoveriesModal'],
 [{scheduleType:'추가계약'},'추가계약 관리','AdditionalContractsModal'],
 [{scheduleType:'일반',sourceAdditionalContractId:'additional-source'},'추가계약 관리','AdditionalContractsModal'],
 [{scheduleType:'일반',paidAmount:0,paidDate:'',allocatedAmount:500000},'환수 충당 관리','RecoveriesModal'],
])test('completed payment '+label+' opens its source editor and does not cancel a generated child '+JSON.stringify(patch),()=>{
 const screen=collectionPage('payment',[paymentSeed({status:'완료',...patch})]);
 const complete=nodes(screen.tree).find(node=>node.type==='Button'&&textContent(node).startsWith('완료 ('));complete.props.onClick();screen.render();
 assert.equal(nodes(screen.tree).some(node=>node.type==='Button'&&textContent(node)==='기록 삭제'),false);
 const manage=nodes(screen.tree).find(node=>node.type==='Button'&&textContent(node)===label);assert.ok(manage);manage.props.onClick();screen.render();
 const editor=nodes(screen.tree).find(node=>node.type===modalName);assert.ok(editor);assert.equal(editor.props.open,true);assert.equal(editor.props.customer.id,'customer');assert.equal(screen.calls.length,0);
});
test('a completed payment with both cash and recovery credit cancels only its displayed cash',async()=>{
 const screen=collectionPage('payment',[paymentSeed({status:'완료',allocatedAmount:300000})]);
 nodes(screen.tree).find(node=>node.type==='Button'&&textContent(node).startsWith('완료 (')).props.onClick();screen.render();
 nodes(screen.tree).find(node=>node.type==='Button'&&textContent(node)==='기록 삭제').props.onClick();screen.render();
 const confirmation=nodes(screen.tree).find(node=>node.type==='ConfirmDelete'&&node.props.open);
 assert.match(confirmation.props.description,/실제 입금 200000/);assert.match(confirmation.props.description,/환수 충당액 300000은 유지/);
 await confirmation.props.onConfirm();assert.deepEqual(plain(screen.calls),[{name:'cancelCompletedPayment',args:['root',7]}]);
});
test('customer editor keeps recovery credit when its completed cash receipt is staged for cancellation',async()=>{
 const editor=scheduleEditor('payment',[paymentSeed({status:'완료',allocatedAmount:300000})],{confirmRemoval:true});editor.button('기록 삭제').props.onClick();editor.render();
 assert.equal(editor.preview.after.totals.paid,0);assert.equal(editor.preview.after.totals.credit,300000);assert.equal(editor.preview.after.totals.remaining,200000);
 await editor.button('전체 일정 저장').props.onClick();assert.equal(editor.calls[0][1][0].allocatedAmount,300000);
});
test('customer editor directs allocation-only completion to recovery management without cancelling the credit',()=>{
 const editor=scheduleEditor('payment',[paymentSeed({status:'완료',paidAmount:0,paidDate:'',allocatedAmount:500000})],{confirmRemoval:true});
 assert.equal(editor.nodes.some(node=>node.type==='Button'&&textContent(node)==='기록 삭제'),false);assert.match(textContent(editor.tree),/환수 충당 관리/);
 assert.equal(editor.preview.after.totals.credit,500000);assert.equal(editor.calls.length,0);
});
for(const sourceKey of ['sourceRecoveryId','sourceAdditionalContractId'])test('customer editor protects a legacy ordinary-type generated record via '+sourceKey,async()=>{
 const managed=paymentSeed({id:'managed',status:'완료',scheduleType:'일반',[sourceKey]:'source-record'}),manual=paymentSeed({id:'manual',status:'예정'});
 const editor=scheduleEditor('payment',[managed,manual],{initialScheduleId:'managed',confirmRemoval:true});
 assert.equal(editor.nodes.some(node=>node.type==='Button'&&textContent(node)==='기록 삭제'),false);
 editor.control('메모').props.onChange({target:{value:'일반 일정만 수정'}});editor.render();await editor.button('전체 일정 저장').props.onClick();
 assert.equal(editor.calls[0][1].length,1);assert.equal(editor.calls[0][1][0].id,'manual');assert.equal(editor.calls[0][4].managed,7);assert.equal(editor.calls[0][4].manual,7);
});
for(const kind of ['payment','repayment']){
 const seed=kind==='payment'?paymentSeed:repaymentSeed,amountKey=kind==='payment'?'dueAmount':'amount',saveLabel=kind==='payment'?'전체 일정 저장':'일정 저장',dateLabel=kind==='payment'?'납부 예정일':'상환 예정일',amountLabel=kind==='payment'?'납부 예정금액':'상환 예정금액',paidLabel=kind==='payment'?'실입금액':'실제 상환액';
 test(kind+' exposes direct editing without replanning actions or history tabs',()=>{
  const editor=scheduleEditor(kind,[seed()]);
  for(const removed of ['통합 재조율','연체 후 재약정','재약정 만들기','날짜 분할','이력 ('])assert.equal(textContent(editor.tree).includes(removed),false,removed);
  assert.equal(editor.control(dateLabel).props.disabled,false);
  assert.equal(editor.control(amountLabel).props.disabled,false);
  assert.ok(editor.button('일정 추가'));
 });
 test(kind+' changing the due date preserves existing receipts and submits no child plans',async()=>{
  const editor=scheduleEditor(kind,[seed()]);
  editor.control(dateLabel).props.onChange({target:{value:'2026-10-20'}});editor.render();
  assert.match(textContent(editor.tree),/연체 횟수 3회/);assert.match(textContent(editor.tree),/저장 시 \+1회/);
  assert.equal(editor.preview.after.totals.paid,200000);
  await editor.button(saveLabel).props.onClick();
  const saved=editor.calls[0][1][0];assert.equal(saved.dueDate,'2026-10-20');assert.equal(saved.paidDate,'2026-10-16');assert.equal(saved.paidAmount,200000);assert.equal(saved.dateChangeCount,2);
  assert.deepEqual(plain(editor.calls[0][2]),{});assert.deepEqual(plain(editor.calls[0][3]),[]);assert.equal(editor.calls[0][4].root,7);assert.equal(editor.closed,1);
 });
 test(kind+' multiple draft date changes count once and reverting the date counts zero',()=>{
  const editor=scheduleEditor(kind,[seed()]);
  for(const date of ['2026-10-20','2026-10-25']){editor.control(dateLabel).props.onChange({target:{value:date}});editor.render();assert.match(textContent(editor.tree),/연체 횟수 3회/);}
  editor.control(dateLabel).props.onChange({target:{value:'2026-10-16'}});editor.render();
  assert.match(textContent(editor.tree),/연체 횟수 2회/);assert.equal(textContent(editor.tree).includes('저장 시 +1회'),false);
 });
 test(kind+' amount-only changes are unrestricted and never move or infer cash',async()=>{
  const editor=scheduleEditor(kind,[seed()]);
  editor.control(amountLabel).props.onChange(900000);editor.render();
  assert.equal(editor.control(paidLabel).props.value,200000);assert.match(textContent(editor.tree),/연체 횟수 2회/);
  await editor.button(saveLabel).props.onClick();
  assert.equal(editor.calls.length,1);assert.equal(editor.calls[0][1][0][amountKey],900000);assert.equal(editor.calls[0][1][0].paidAmount,200000);
 });
 test(kind+' adding a row creates an independent schedule with zero date changes',async()=>{
  const editor=scheduleEditor(kind,[seed()]);editor.button('일정 추가').props.onClick();editor.render();
  editor.control(dateLabel).props.onChange({target:{value:'2026-11-01'}});editor.render();editor.control(amountLabel).props.onChange(300000);editor.render();
  assert.match(textContent(editor.tree),/연체 횟수 0회/);
  await editor.button(saveLabel).props.onClick();
  const added=editor.calls[0][1].find(row=>!row.id);assert.equal(added[amountKey],300000);assert.equal(added.paidAmount,0);assert.equal(added.rescheduledFromId,undefined);assert.equal(added.rootScheduleId,undefined);assert.equal(added.promiseState,'active');
  assert.equal(editor.calls[0][1].find(row=>row.id==='root').paidAmount,200000);
 });
 test(kind+' deleting a saved schedule keeps its receipt and hides it from the editor',async()=>{
  const editor=scheduleEditor(kind,[seed()]);editor.control(paidLabel).props.onChange(250000);editor.render();editor.button('일정 삭제').props.onClick();editor.render();
  assert.equal(editor.preview.after.totals.paid,250000);assert.equal(editor.nodes.some(node=>node.type==='Label'&&node.props.text===dateLabel),false);assert.equal(textContent(editor.tree).includes('이력 ('),false);
  await editor.button(saveLabel).props.onClick();
  const saved=editor.calls[0][1][0];assert.equal(saved.promiseState,'cancelled');assert.equal(saved.paidAmount,250000);assert.equal(saved.paidDate,'2026-10-16');assert.deepEqual(plain(editor.calls[0][3]),[]);
 });
 test(kind+' a legacy receipt is editable without reactivating its old plan or changing its successor',async()=>{
  const root=seed({promiseState:'rescheduled'}),child=seed({id:'child',rescheduledFromId:'root',rootScheduleId:'root',promiseState:'active',dueDate:'2026-10-20',[amountKey]:300000,paidAmount:0,paidDate:'',status:'예정',dateChangeCount:0});
  const editor=scheduleEditor(kind,[root,child],{initialScheduleId:'root'});
  assert.equal(editor.control(dateLabel).props.value,'2026-10-16');assert.equal(editor.control(dateLabel).props.disabled,true);assert.equal(editor.control(amountLabel).props.disabled,true);assert.equal(editor.control('상태').props.disabled,true);assert.equal(editor.control(paidLabel).props.value,200000);assert.equal(editor.preview.after.totals.paid,200000);assert.equal(editor.preview.after.totals.planned,300000);
  assert.equal(editor.nodes.some(node=>['button','Button'].includes(node.type)&&textContent(node)==='일정 삭제'),false);
  if(kind==='repayment')assert.equal(editor.control('업체명').props.disabled,true);
  await editor.button(saveLabel).props.onClick();
  assert.deepEqual(plain(editor.calls[0][1].find(row=>row.id==='root')),plain(root));
 });
 test(kind+' a customer with only unpaid hidden schedules can add a fresh schedule without exposing history',()=>{
  const editor=scheduleEditor(kind,[seed({promiseState:'cancelled',paidAmount:0,paidDate:''})]);
  assert.equal(editor.nodes.some(node=>node.type==='Label'&&node.props.text===dateLabel),false);assert.equal(editor.preview.after.totals.paid,0);
  editor.button('일정 추가').props.onClick();editor.render();assert.equal(editor.control(dateLabel).props.value,'');
 });
 test(kind+' a cancelled receipt remains editable when its cash is corrected to zero',async()=>{
  const editor=scheduleEditor(kind,[seed({promiseState:'cancelled'})],{initialScheduleId:'root'});
  editor.control(paidLabel).props.onChange(0);editor.render();assert.equal(editor.control(paidLabel).props.value,0);assert.equal(editor.control(dateLabel).props.disabled,true);
  await editor.button(saveLabel).props.onClick();assert.equal(editor.calls[0][1][0].paidAmount,0);assert.equal(editor.calls[0][1][0].promiseState,'cancelled');
 });
 test(kind+' assigning an initially unknown date does not count as overdue',async()=>{
  const editor=scheduleEditor(kind,[seed({dueDate:'',dateChangeCount:0})]);editor.control(dateLabel).props.onChange({target:{value:'2026-10-20'}});editor.render();
  assert.match(textContent(editor.tree),/연체 횟수 0회/);assert.equal(textContent(editor.tree).includes('저장 시 +1회'),false);
  await editor.button(saveLabel).props.onClick();assert.equal(editor.calls.length,1);
 });
 test(kind+' clearing a stored due date requires an explicit schedule deletion',async()=>{
  const editor=scheduleEditor(kind,[seed()]);editor.control(dateLabel).props.onChange({target:{value:''}});editor.render();await editor.button(saveLabel).props.onClick();
  assert.equal(editor.calls.length,0);assert.equal(editor.closed,0);assert.match(editor.alerts[0],/예정일을 입력/);
 });
 test(kind+' unsaved receipts require confirmation before deletion',()=>{
  const editor=scheduleEditor(kind,[]);editor.button('일정 추가').props.onClick();editor.render();editor.control(paidLabel).props.onChange(10000);editor.render();editor.button('일정 삭제').props.onClick();editor.render();
  assert.equal(editor.control(paidLabel).props.value,10000);
 });
 test(kind+' save errors retain the editor and its original concurrency snapshot',async()=>{
  const editor=scheduleEditor(kind,[seed()],{failSave:true});editor.control(dateLabel).props.onChange({target:{value:'2026-10-20'}});editor.render();await editor.button(saveLabel).props.onClick();editor.render();
  assert.equal(editor.closed,0);assert.match(editor.alerts[0],/저장 실패/);assert.equal(editor.calls[0][4].root,7);assert.equal(editor.control(dateLabel).props.value,'2026-10-20');assert.equal(editor.control(paidLabel).props.value,200000);
 });
 test(kind+' realtime refresh preserves in-progress inputs and the original concurrency version',async()=>{
  const editor=scheduleEditor(kind,[seed()]);editor.control(paidLabel).props.onChange(250000);editor.render();editor.store[kind==='payment'?'payments':'repayments']=[seed({paidAmount:210000,rowVersion:8})];editor.render();
  assert.equal(editor.control(paidLabel).props.value,250000);await editor.button(saveLabel).props.onClick();assert.equal(editor.calls[0][4].root,7);assert.equal(editor.calls[0][1][0].paidAmount,250000);
 });
 test(kind+' legacy overdue statuses do not infer a date or an additional cash amount',async()=>{
  const editor=scheduleEditor(kind,[seed({paidDate:'',paidAmount:0,dateChangeCount:0})]);
  editor.control('상태').props.onChange({target:{value:kind==='payment'?'완료':'상환완료'}});editor.render();
  assert.match(textContent(editor.tree),/연체 횟수 0회/);await editor.button(saveLabel).props.onClick();assert.equal(editor.calls[0][1][0].paidAmount,0);assert.equal(editor.calls[0][1][0].paidDate,'');
 });
}
