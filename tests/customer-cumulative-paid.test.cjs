const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const vm=require('node:vm');

const modules=new Map();
function load(file){
 const resolved=path.resolve(file);
 if(modules.has(resolved))return modules.get(resolved);
 const mod={exports:{}};
 modules.set(resolved,mod.exports);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(resolved,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
  {module:mod,exports:mod.exports,require:name=>load(path.resolve(path.dirname(resolved),name+'.ts'))});
 return mod.exports;
}
const metrics=load('lib/payment-metrics.ts');
const ledger=load('lib/schedule-ledger.ts');
const plans=load('lib/schedule-plans.ts');
const bank=load('lib/bank-cash-metrics.ts');
const file='app/(admin)/[section]/page.tsx';
const page=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function declaration(name){
 const result=page.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
 assert.ok(result,`${name} production component exists`);
 return result.getText(page);
}
function execute(source,context){return vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022}}).outputText,context)}
function nodes(node){
 if(Array.isArray(node))return node.flatMap(nodes);
 if(!node||typeof node!=='object')return [];
 return [node,...nodes(node.props?.children)];
}
function text(node){
 if(node==null||typeof node==='boolean')return '';
 if(Array.isArray(node))return node.map(text).join('');
 return typeof node==='object'?text(node.props?.children):String(node);
}
function stat(tree,label){
 const card=nodes(tree).find(node=>node.type==='div'&&node.props.children.length===2&&text(node.props.children[0])===label);
 assert.ok(card,`stat ${label} exists`);
 return {card,value:card.props.children[1]};
}

function fixture(){
 const customer=Object.freeze({id:'customer',name:'검증 고객',createdAt:'2026-10-01',phone:'01000000000',manager:'검증 담당',coordinationManager:'검증 조율',
  contractAmount:1000000,prepaidAmount:0,recoveryCredit:150000,lenderUnitPrice:1000000,lenderCount:1,eformsignStatus:'서명완료'});
 const row=(id,patch)=>Object.freeze({id,customerId:customer.id,dueDate:'2026-10-20',dueAmount:1000000,paidDate:'2026-10-19',paidAmount:0,
  allocatedAmount:0,status:'예정',scheduleType:'일반',promiseState:'active',paymentMethod:'계좌이체',memo:'',rowVersion:1,...patch});
 const payments=Object.freeze([
  row('cash',{paidAmount:200000}),
  row('legacy-credit',{dueAmount:100000,allocatedAmount:100000,status:'완료',paidDate:''}),
  row('recovery-shadow',{scheduleType:'환수',dueAmount:800000,paidAmount:800000,allocatedAmount:250000,status:'완료'}),
  row('refunded',{status:'환불',paidAmount:900000,allocatedAmount:700000}),
  row('other-client',{customerId:'other',paidAmount:600000,allocatedAmount:300000}),
 ]);
 return {customer,payments,store:{customers:[customer],payments,additionalContracts:[],recoveries:[],repayments:[]}};
}

// Run the production TSX components with deterministic React hooks. Child
// components stay as named element nodes, so assertions inspect real JSX values.
function render(name,seed,props={}){
 const cells=[];let cursor=0,dirty=false,effects=[],tree;
 const context={React:{Fragment:'Fragment',createElement:(type,properties,...children)=>({type,props:{...properties,children}})},
  ...metrics,...ledger,...plans,useAdminStore:()=>seed.store,
  useState(initial){const index=cursor++;if(!(index in cells))cells[index]={value:typeof initial==='function'?initial():initial};return [cells[index].value,next=>{const value=typeof next==='function'?next(cells[index].value):next;if(value!==cells[index].value){cells[index].value=value;dirty=true}}]},
  useRef(initial){const index=cursor++;return cells[index]??={current:initial}},
  useEffect(effect,deps){const index=cursor++;if(!cells[index]||deps.some((value,i)=>value!==cells[index].deps[i])){cells[index]={deps};effects.push(effect)}},
  useMemo:fn=>fn(),emptyCustomer:()=>({...seed.customer}),staffManager:value=>value,newestFirst:()=>0,pageRows:rows=>rows,
  isEformSignedStatus:()=>true,eformStatus:()=>({tone:'green',label:'서명완료'}),won:value=>`₩${value.toLocaleString('ko-KR')}`,
  field:'field',paymentMethods:['계좌이체'],paymentStatuses:['예정','완료','미납','환불'],today:()=> '2026-10-23',window:{confirm:()=>false},alert:()=>{throw Error('unexpected alert')}};
 for(const child of ['PageHeader','Button','Badge','Card','SearchBox','Pagination','Calculator','RefreshCw','Plus','Trash2','Modal','InlineModalContent',
  'CustomerFormFields','CustomerModal','PaymentScheduleModal','RepaymentScheduleModal','AdditionalContractsModal','RecoveriesModal','ScheduleNoticeModal',
  'EformsignModal','CustomerDetail','SalesCalculator','ConfirmDelete','FileSignature','ScheduleMoneyPreview','Label','NumberInput'])context[child]=child;
 context.customerOutstanding=execute(declaration('customerOutstanding')+';customerOutstanding',context);
 const component=execute(declaration(name)+';'+name,context);
 function refresh(){let count=0;do{cursor=0;dirty=false;effects=[];tree=component(props);for(const effect of effects)effect();assert.ok(++count<8,'render settles')}while(dirty);return tree}
 refresh();
 return {refresh,get tree(){return tree}};
}

test('cumulative paid counts cash and both credit forms once without accepting gross recovery or other clients',()=>{
 const {customer,payments}=fixture(),snapshot=JSON.stringify(payments);
 assert.equal(metrics.customerCumulativePaid(payments,customer.id,customer.recoveryCredit),450000);
 assert.equal(metrics.customerPaid(payments,customer.id),200000);
 assert.equal(metrics.customerCredit(payments,customer.id,customer.recoveryCredit),250000);
 assert.equal(metrics.customerCumulativePaid([],customer.id,150000),150000);
 assert.equal(metrics.customerCumulativePaid([],customer.id),0);
 assert.equal(JSON.stringify(payments),snapshot);
});

test('customer list displays cumulative paid, the unchanged receivable and the cash-credit breakdown in aligned columns',()=>{
 const seed=fixture(),screen=render('Customers',seed);
 const table=nodes(screen.tree).find(node=>node.type==='table');
 const headers=nodes(table).filter(node=>node.type==='th').map(text);
 const row=nodes(table).find(node=>node.type==='tr'&&nodes(node).some(child=>child.type==='td'));
 const cells=nodes(row).filter(node=>node.type==='td'),paid=cells[headers.indexOf('누적 납부액')];
 assert.equal(text(paid),'₩450,000');
 assert.equal(text(cells[headers.indexOf('미수금')]),'₩550,000');
 assert.equal(paid.props.title,'계약대금 실입금 ₩200,000 · 환수 분납 충당 ₩250,000');
 assert.equal(headers.length,cells.length);
 assert.match(table.props.className,/admin-responsive-table.*min-w-/);
});

test('opening the customer workspace shows the same cumulative paid and receivable in its existing four boxes',()=>{
 const seed=fixture(),screen=render('Customers',seed);
 const open=nodes(screen.tree).find(node=>node.type==='Button'&&text(node)==='고객정보');
 assert.ok(open);open.props.onClick({stopPropagation(){}});screen.refresh();
 const modal=nodes(screen.tree).find(node=>node.type==='Modal'&&node.props.open&&node.props.title.endsWith('고객 통합 관리'));
 assert.ok(modal);assert.equal(text(stat(modal,'누적 납부액').value),'₩450,000');
 assert.equal(text(stat(modal,'현재 미수금').value),'₩550,000');
 const boxes=nodes(modal).find(node=>node.type==='div'&&node.props.className==='grid grid-cols-2 gap-2 lg:grid-cols-4');
 assert.ok(boxes);assert.equal(boxes.props.children.flat().length,4);
});

test('customer detail shows cumulative paid while retaining separate cash and recovery credit amounts',()=>{
 const seed=fixture(),screen=render('CustomerDetail',seed,{customer:seed.customer});
 assert.equal(text(stat(screen.tree,'누적 납부액').value),'₩450,000');
 assert.equal(text(stat(screen.tree,'계약대금 실입금').value),'₩200,000');
 assert.equal(text(stat(screen.tree,'환수 분납 충당').value),'₩250,000');
 assert.equal(text(stat(screen.tree,'미수금').value),'₩550,000');
 assert.ok(nodes(screen.tree).some(node=>node.type==='div'&&/grid.*xl:grid-cols-5/.test(node.props.className||'')));
});

test('payment editor includes recovery credit in cumulative paid without altering its cash and debt preview',()=>{
 const seed=fixture(),snapshot=JSON.stringify(seed),screen=render('PaymentScheduleModal',seed,{open:true,customer:seed.customer,onClose(){}});
 const paid=stat(screen.tree,'누적 납부액');
 assert.equal(text(paid.value),'₩450,000');
 assert.equal(paid.value.props.title,'계약대금 실입금 ₩200,000 · 환수 분납 충당 ₩250,000');
 assert.equal(text(stat(screen.tree,'현재 미수금').value),'₩550,000');
 const preview=nodes(screen.tree).find(node=>node.type==='ScheduleMoneyPreview');
 assert.ok(preview);assert.equal(preview.props.before.totals.paid,200000);assert.equal(preview.props.after.totals.paid,200000);
 assert.equal(preview.props.after.totals.credit,250000);assert.equal(preview.props.after.totals.remaining,550000);
 assert.equal(JSON.stringify(seed),snapshot);
 assert.ok(nodes(screen.tree).some(node=>node.type==='div'&&node.props.className==='mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4'));
});

test('cumulative paid follows active credit totals while keeping a retired promise receipt and bank cash separate',()=>{
 const {customer,payments}=fixture();
 const rows=payments.filter(row=>row.id!=='legacy-credit').map(row=>row.id==='cash'?{...row,promiseState:'cancelled'}:row);
 assert.equal(metrics.customerCumulativePaid(rows,customer.id,0),200000);
 assert.equal(metrics.customerPaid(rows,customer.id),200000);
 const statements=[{id:'ordinary',paidDate:'2026-10-19',amount:200000},{id:'recovery',paidDate:'2026-10-19',amount:800000}];
 const refunds=[{id:'refund',customerId:customer.id,refundDate:'2026-10-19',amount:150000,recipientName:'검증 수취인',paymentMethod:'계좌이체',memo:''}];
 const totals=bank.summarizeBankCash(bank.buildBankCashRows(statements,refunds,[customer]));
 assert.equal(totals.inflow,1000000);assert.equal(totals.outflow,150000);assert.equal(totals.net,850000);
});
