const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const React=require('react');const {renderToStaticMarkup}=require('react-dom/server');
function compile(source,context={}){const loaded={exports:{}};return vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module:loaded,exports:loaded.exports,require,Error,...context})}
const api=compile(fs.readFileSync('lib/settlement-cancellation.ts','utf8')+';exports');
const revenueApi=compile(fs.readFileSync('lib/revenue-metrics.ts','utf8')+';exports');
const bankApi=compile(fs.readFileSync('lib/bank-cash-metrics.ts','utf8')+';exports');
const file='app/(admin)/[section]/page.tsx',ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const customer={id:'c',name:'가상 의뢰인',phone:'01000000000',contractAmount:2000000,eformsignStatus:'완료'};
const payment=(patch={})=>({id:'p',customerId:'c',rowVersion:7,paidAmount:100000,paidDate:'2026-10-23',dueDate:'2026-10-23',dueAmount:100000,status:'완료',promiseState:'active',scheduleType:'일반',memo:'입금',paymentMethod:'계좌이체',...patch});
const recovery=(patch={})=>({id:'r',customerId:'c',rowVersion:9,accountingVersion:2,recoveryDate:'2026-10-23',lenderName:'가상 업체',depositorName:'실제 입금자',amount:1000000,paymentMethod:'계좌이체',memo:'환수',installmentAmount:200000,clientReturnAmount:0,successFeeAmount:500000,...patch});
const additional={id:'a',customerId:'c',contractDate:'2026-10-23',contractAmount:500000,prepaidAmount:100000,installmentMonths:4,lenderUnitPrice:500000,lenderCount:1,isRenegotiation:false,memo:'추가계약'};
const row=(patch={})=>({id:'statement',paidDate:'2026-10-23',clientName:'가상 의뢰인',amount:100000,paymentMethod:'계좌이체',memo:'입금',customerId:'c',entrySource:'payment',entryType:'계약',sourcePaymentScheduleId:'p',...patch});
function data(){return {customers:[customer],payments:[payment()],recoveries:[],additionalContracts:[],recoveryRefunds:[],recoveryAllocations:[],settlements:[],recoverySplits:[]};}
function scenario(kind){const s=data();let line=row();if(kind==='manual'){line=row({entrySource:'manual',sourcePaymentScheduleId:''})}
 if(kind==='recovery'){s.recoveries=[recovery()];s.payments=[payment({paidAmount:1000000,dueAmount:1000000,sourceRecoveryId:'r',scheduleType:'환수'})];line=row({amount:1000000,entryType:'환수'})}
 if(kind==='additional'){s.additionalContracts=[additional];s.payments=[payment({sourceAdditionalContractId:'a',scheduleType:'추가계약'})]}
 if(kind==='recovery_return'){s.recoveries=[recovery({clientReturnAmount:300000})];line=row({amount:-300000,entrySource:'recovery',entryType:'의뢰인 환수 반환금',sourcePaymentScheduleId:'',sourceRecoveryId:'r',recoveryComponent:'client_return'})}
 if(kind==='refund'){s.recoveries=[recovery({accountingVersion:1,installmentAmount:0})];s.recoveryRefunds=[{id:'f',recoveryId:'r',customerId:'c',refundDate:'2026-10-23',amount:245000,recipientName:'가상 반환 수취인',paymentMethod:'계좌이체',memo:'실제 반환',settlementHidden:false}];line=row({id:'refund:f',amount:-245000,entrySource:'refund',entryType:'반환',sourcePaymentScheduleId:'',memo:'환수금 고객 반환 [수취인:가상 반환 수취인] · 실제 반환'})}
 s.settlements=[line];return {s,line};}
for(const [kind,label,amount,impact] of [['payment','실제 입금',100000,/계약원금.*유지/],['additional','추가계약 선납 입금',100000,/원금 ₩500,000.*유지/],['recovery','업체 환수 입금',1000000,/성공보수 ₩500,000.*분납 충당 ₩200,000.*함께 취소/],['recovery_return','의뢰인 반환 출금',300000,/환수 입금 ₩1,000,000.*유지/],['refund','의뢰인 반환 출금',245000,/총입금·성공보수·분납 충당액·계약원금은 유지/],['manual','수기 입금',100000,/고객 납부액·계약원금·환수 충당액은 변경되지/]])test(kind+' captures the guarded source and describes the actual amount and financial effect',()=>{
 const {s,line}=scenario(kind),snapshot=api.createSettlementCancellation(line,s,'fixed-request');
 assert.equal(snapshot.expected.kind,kind);assert.match(snapshot.label,new RegExp(label));assert.match(snapshot.label+snapshot.description,new RegExp(Number(amount).toLocaleString('ko-KR')));assert.match(snapshot.description,impact);
 assert.equal(snapshot.expected.settlement.id,line.id);assert.equal(snapshot.expected.settlement.source_recovery_id,line.sourceRecoveryId||null);assert.equal(snapshot.requestKey,'fixed-request');
 if(kind==='manual')assert.equal(snapshot.expected.payment,null);if(kind==='payment')assert.equal(snapshot.expected.payment.row_version,7);
 if(kind==='recovery')assert.equal(snapshot.expected.source.row_version,9);if(kind==='additional')assert.equal(snapshot.expected.source.upfront_amount,100000);
});

test('source projections normalize nullable identifiers and dates while retaining the source version and exact financial metadata',()=>{
 const statement=api.settlementSnapshot(row({paidDate:'',sourceRecoveryId:''})),source=api.paymentSnapshot(payment({paidDate:'',dueDate:'',promiseState:undefined}));
 assert.equal(statement.payment_date,null);assert.equal(statement.source_recovery_id,null);assert.equal(source.paid_date,null);assert.equal(source.due_date,null);assert.equal(source.promise_state,null);assert.equal(source.row_version,7);
});

test('a mismatched or undated payment cannot open an actionable source cancellation confirmation',()=>{
 for(const patch of [{paidDate:'2026-10-22'},{paidDate:''},{paidAmount:200000},{sourceRecoveryId:'r',sourceAdditionalContractId:'a'}]){
  const s=data();s.payments=[payment(patch)];const snapshot=api.createSettlementCancellation(row(),s,'request');assert.equal(snapshot.expected,null);assert.match(snapshot.guidance,/일치하지 않습니다/);
 }
});

for(const patch of [{entrySource:'payment',sourcePaymentScheduleId:'missing'},{entrySource:'recovery',sourcePaymentScheduleId:'',sourceRecoveryId:'missing',recoveryComponent:'success_fee'},{entrySource:'manual',sourcePaymentScheduleId:'p'},{entrySource:'refund',id:'refund:legacy',sourcePaymentScheduleId:''}])test('unresolved or unsupported source cannot silently hide a statement '+JSON.stringify(patch),()=>{
 const snapshot=api.createSettlementCancellation(row(patch),data(),'request');assert.equal(snapshot.expected,null);assert.ok(snapshot.guidance);assert.doesNotMatch(snapshot.guidance,/목록에서만|숨기/);
});

test('gross recovery linked to a return is blocked before cancelling any incoming cash',()=>{
 for(const existingReturn of [false,true]){const {s,line}=scenario('recovery');if(existingReturn)s.recoveryRefunds=[{recoveryId:'r',amount:100000}];else s.recoveries[0].clientReturnAmount=100000;
 const snapshot=api.createSettlementCancellation(line,s,'request');assert.equal(snapshot.expected,null);assert.equal(snapshot.manage,'recovery');assert.match(snapshot.guidance,/반환 출금|반환 내역/);}
});

test('a manual-labelled line never enters recovery or payment cancellation even if linked source records exist',()=>{
 const {s,line}=scenario('recovery');const snapshot=api.createSettlementCancellation({...line,entrySource:'manual'},s,'request');
 assert.equal(snapshot.expected,null);assert.match(snapshot.guidance,/수기 정산에 원본 연결/);
 const legacy=api.createSettlementCancellation(row({entrySource:'refund',id:'refund:old',sourcePaymentScheduleId:''}),s,'request');assert.match(legacy.guidance,/반환 원본과 정산표/);
});

test('a legacy actual refund confirmation identifies its recovery, recipient, date and cash outflow without cancelling gross or credit',()=>{
 const {s,line}=scenario('refund'),snapshot=api.createSettlementCancellation(line,s,'fixed-request');
 assert.equal(snapshot.expected.kind,'refund');assert.equal(snapshot.expected.settlement.id,'refund:f');assert.equal(snapshot.expected.payment,null);assert.equal(snapshot.expected.source.id,'f');assert.equal(snapshot.expected.source.amount,245000);assert.equal(snapshot.expected.recovery.id,'r');assert.equal(snapshot.expected.recovery.row_version,9);
 assert.match(snapshot.description,/가상 업체/);assert.match(snapshot.description,/가상 반환 수취인/);assert.match(snapshot.description,/2026-10-23/);assert.match(snapshot.description,/실제 반환 출금 ₩245,000만 취소/);assert.match(snapshot.description,/취소 이력으로 보존/);
});

for(const change of ['v2','hidden','wrong-amount','wrong-date','missing-parent','wrong-customer'])test('legacy refund cancellation rejects an unsupported or mismatched source: '+change,()=>{
 const {s,line}=scenario('refund');if(change==='v2')s.recoveries[0].accountingVersion=2;if(change==='hidden')s.recoveryRefunds[0].settlementHidden=true;if(change==='wrong-amount')s.recoveryRefunds[0].amount=1;if(change==='wrong-date')s.recoveryRefunds[0].refundDate='2026-10-22';if(change==='missing-parent')s.recoveries=[];if(change==='wrong-customer')s.recoveryRefunds[0].customerId='other';
 const snapshot=api.createSettlementCancellation(line,s,'request');assert.equal(snapshot.expected,null);assert.equal(snapshot.manage,'recovery');assert.ok(snapshot.guidance);if(change==='v2')assert.match(snapshot.guidance,/신형 환수/);
});

test('cancelling payment cash keeps a separate recovery credit in the confirmation explanation',()=>{
 const s=data();s.payments=[payment({allocatedAmount:50000})];const snapshot=api.createSettlementCancellation(row(),s,'request');assert.match(snapshot.description,/환수 분납 충당 ₩50,000.*유지/);
});

function editor(s){const owner=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='Settlements');const body=owner.body.statements.filter(node=>!ts.isReturnStatement(node)).map(node=>node.getText(ast)).join('\n');
 const cells=[],routes=[];let cursor=0;
 const run=compile(`function run(){${body}\nreturn {del,deleting,deleteError,beginDelete,closeDelete,cancelSettlement,manageSettlementSource,sourceEditing};}run`,{...api,...revenueApi,...bankApi,useAdminStore:()=>s,useRouter:()=>({push:path=>routes.push(path)}),crypto:require('node:crypto'),useMemo:fn=>fn(),
 useState(initial){const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return [cells[i],value=>{cells[i]=typeof value==='function'?value(cells[i]):value}]},useRef(initial){const i=cursor++;return cells[i]??={current:initial}},
 monthRange:()=>({start:'2026-10-16',end:'2026-10-31'}),emptySettlement:()=>({}),inRange:(date,start,end)=>!!date&&date>=start&&date<=end,isEformSignedStatus:()=>true,newestFirst:()=>0,customerPaid:()=>0,customerCredit:()=>0});
 return {routes,render(){cursor=0;return run()}};
}

test('pending cancellation blocks duplicates, close and source navigation, then retains its frozen snapshot after a concurrency error',async()=>{
 const {s,line}=scenario('payment'),calls=[];let reject;s.deleteSettlement=(...args)=>{calls.push(args);return new Promise((_,fail)=>{reject=fail})};const page=editor(s);page.render().beginDelete(line);let view=page.render();
 const expected=JSON.stringify(view.del.expected),request=view.del.requestKey;const pending=view.cancelSettlement();await view.cancelSettlement();view=page.render();assert.equal(calls.length,1);assert.equal(view.deleting,true);
 view.closeDelete();view.manageSettlementSource();assert.equal(page.render().del.requestKey,request);assert.equal(page.render().sourceEditing,null);
 s.payments[0].rowVersion=8;s.payments[0].paidAmount=200000;s.settlements=[];reject(Error('동시에 수정된 입금입니다'));await pending;view=page.render();assert.equal(view.deleting,false);assert.match(view.deleteError,/동시에 수정/);assert.equal(JSON.stringify(view.del.expected),expected);assert.equal(view.del.requestKey,request);
});

test('lost-response retry sends the original UUID and expected source even after realtime removed both source and table row',async()=>{
 const {s,line}=scenario('payment'),calls=[];let first=true;s.deleteSettlement=async(...args)=>{calls.push(args);if(first){first=false;throw Error('response lost')}};const page=editor(s);page.render().beginDelete(line);let view=page.render();const expected=JSON.stringify(view.del.expected),request=view.del.requestKey;
 await view.cancelSettlement();s.payments=[];s.settlements=[];view=page.render();assert.equal(view.del.row.amount,100000);assert.match(view.deleteError,/response lost/);
 await view.cancelSettlement();assert.equal(page.render().del,null);assert.equal(calls.length,2);assert.equal(calls[1][2],request);assert.equal(JSON.stringify(calls[1][1]),expected);
});

test('a legacy refund retry preserves its original parent version, recipient and request after realtime removes the cancelled outflow',async()=>{
 const {s,line}=scenario('refund'),calls=[];let first=true;s.deleteSettlement=async(...args)=>{calls.push(args);if(first){first=false;throw Error('response lost')}};const page=editor(s);page.render().beginDelete(line);let view=page.render();const captured=JSON.stringify(view.del.expected),key=view.del.requestKey;
 await view.cancelSettlement();s.recoveryRefunds=[];s.recoveries=[];s.settlements=[];view=page.render();assert.equal(view.del.expected.source.recipient_name,'가상 반환 수취인');assert.equal(view.del.expected.recovery.row_version,9);
 await view.cancelSettlement();assert.equal(page.render().del,null);assert.equal(calls[1][0],'refund:f');assert.equal(calls[1][2],key);assert.equal(JSON.stringify(calls[1][1]),captured);
});

test('refund loading filters cancelled cash facts without treating the historical hidden flag as cash cancellation',()=>{
 const storeAst=ts.createSourceFile('store.tsx',fs.readFileSync('components/store.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let loader;
 function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(storeAst)==='loadTable'&&node.arguments[0]?.getText(storeAst)==='"recovery_refunds"')loader=node.arguments[2];ts.forEachChild(node,visit)}visit(storeAst);assert.ok(loader);
 const filters=[];const query={select:()=>query,is:(column,value)=>{filters.push([column,value]);return query},order:()=>query};
 const load=compile(loader.getText(storeAst),{fetchAllRows:factory=>factory(true),supabase:{from:table=>{assert.equal(table,'recovery_refunds');return query}}});load();assert.deepEqual(filters,[['cancelled_at',null]]);
});

test('unsupported cancellation makes no server call and offers the identifiable source editor or customer management',async()=>{
 const s=data(),calls=[];s.deleteSettlement=async()=>calls.push('unexpected');const page=editor(s);page.render().beginDelete(row({sourcePaymentScheduleId:'missing'}));await page.render().cancelSettlement();assert.equal(calls.length,0);page.render().manageSettlementSource();assert.deepEqual(page.routes,['/customers']);
 const {s:linked,line}=scenario('recovery');linked.recoveries[0].clientReturnAmount=100000;const linkedPage=editor(linked);linkedPage.render().beginDelete(line);linkedPage.render().manageSettlementSource();assert.equal(linkedPage.render().sourceEditing.kind,'recovery');assert.equal(linkedPage.render().sourceEditing.customer.id,'c');
});

test('each new selection has a fresh request key and source management opens the selected customer without cancelling it',()=>{
 const {s,line}=scenario('additional'),page=editor(s);page.render().beginDelete(line);const key=page.render().del.requestKey;page.render().closeDelete();page.render().beginDelete(line);assert.notEqual(page.render().del.requestKey,key);page.render().manageSettlementSource();assert.equal(page.render().sourceEditing.kind,'additional');assert.equal(page.render().sourceEditing.customer.id,'c');assert.equal(page.render().del,null);
});

test('production cancellation dialog exposes source effects, pending locks, inline errors and no hide-only action',()=>{
 const owner=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='SettlementCancellationDialog');let modal;const buttons=[];
 const Dialog=compile(owner.getText(ast)+';SettlementCancellationDialog',{Modal:props=>{modal=props;return React.createElement('section',null,props.children)},Button:props=>{buttons.push(props);return React.createElement('button',{disabled:props.disabled},props.children)}});
 const {s,line}=scenario('recovery'),snapshot=api.createSettlementCancellation(line,s,'request');const html=renderToStaticMarkup(React.createElement(Dialog,{snapshot,pending:true,error:'원본 버전 변경',onClose(){},onConfirm(){},onManage(){}}));
 assert.equal(modal.busy,true);assert.ok(buttons.every(button=>button.disabled));assert.match(html,/실제 거래|업체 환수 입금/);assert.match(html,/원본 버전 변경/);assert.match(html,/role="alert"/);assert.doesNotMatch(html,/목록에서만|원래 입금·환수 기록은 보존/);
 buttons.length=0;renderToStaticMarkup(React.createElement(Dialog,{snapshot:{...snapshot,expected:null,guidance:'환수 관리에서 확인'},pending:false,error:'',onClose(){},onConfirm(){},onManage(){}}));assert.equal(buttons.find(button=>button.children==='실제 기록 취소').disabled,true);
});

test('the production table disables the actual trash button while a cancellation is pending',()=>{
 let button;function visit(node){if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(ast)==='Button'&&node.getText(ast).includes('beginDelete(x)'))button=node;ts.forEachChild(node,visit)}visit(ast);assert.ok(button);
 let props;const node=compile(button.getText(ast),{deleting:true,saving:false,x:row(),beginDelete:()=>{},Button:value=>{props=value;return null}});renderToStaticMarkup(node);assert.equal(props.disabled,true);
});
