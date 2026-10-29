const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const vm=require('node:vm');

const storeSource=fs.readFileSync('components/store.tsx','utf8');
const storeAst=ts.createSourceFile('store.tsx',storeSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const pageSource=fs.readFileSync('app/(admin)/[section]/page.tsx','utf8');
const pageAst=ts.createSourceFile('page.tsx',pageSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const plain=value=>JSON.parse(JSON.stringify(value));
function execute(source,context){return vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,{Error,...context})}
function findNode(root,predicate){let found;function visit(node){if(!found&&predicate(node))found=node;ts.forEachChild(node,visit)}visit(root);assert.ok(found,'production node exists');return found}
const methodNode=findNode(storeAst,node=>ts.isMethodDeclaration(node)&&node.name.getText(storeAst)==='hideMissingRepayment');
const methodSource=methodNode.getText(storeAst).replace('async hideMissingRepayment(','async function(');
const repaymentNode=findNode(pageAst,node=>ts.isFunctionDeclaration(node)&&node.name?.text==='Repayments');

function database(results){
 const calls=[];
 return {calls,client:{from(table){const call={table,filters:[]};calls.push(call);const query={
  update(patch){call.patch=patch;return query},eq(key,value){call.filters.push(['eq',key,value]);return query},
  is(key,value){call.filters.push(['is',key,value]);return query},select(columns){call.columns=columns;return query},
  async single(){const result=results.shift();if(result instanceof Error)throw result;return typeof result==='function'?result():result},
 };return query}}};
}
const customer=(patch={})=>({id:'customer',name:'검증 고객',phone:'01000000000',createdAt:'2026-10-19',createdTime:'2026-10-19',lenderCount:1,contractAmount:100000,manager:'담당',coordinationManager:'담당',isAccident:false,hideMissingRepayment:false,...patch});
const success=id=>({data:{id,hide_missing_repayment:true},error:null});
function statefulStore(db,customers=[customer()],onRefresh){
 const state={customers,repayments:[],refreshes:0,refreshTables:[],updates:0};
 const method=execute('const method='+methodSource+';method',{
  supabase:db.client,customers:state.customers,
  setCustomers(update){state.updates++;state.customers=typeof update==='function'?update(state.customers):update},
  refresh:async tables=>{state.refreshes++;state.refreshTables.push(tables?Array.from(tables):null);await onRefresh?.(tables,state)},
 });
 const store={get customers(){return state.customers},get repayments(){return state.repayments},hideMissingRepayment:method};
 return {store,state};
}
function nodes(element){if(Array.isArray(element))return element.flatMap(nodes);if(!element||typeof element!=='object')return [];return [element,...(element.props?.children||[]).flatMap(nodes)]}
function text(element){if(element==null||typeof element==='boolean')return '';if(Array.isArray(element))return element.map(text).join('');if(typeof element!=='object')return String(element);return text(element.props?.children)}
function screen(model){
 const cells=[];let cursor=0,tree;
 const context={React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},useAdminStore:()=>model.store,
  useState(initial){const i=cursor++;if(!(i in cells))cells[i]={value:typeof initial==='function'?initial():initial};return [cells[i].value,next=>{cells[i].value=typeof next==='function'?next(cells[i].value):next}]},
  useRef(initial){const i=cursor++;return cells[i]??={current:initial}},useMemo:fn=>fn(),
  buildScheduleLedger:()=>({byId:new Map(),totals:{}}),newestFirst:(a,b)=>a.id.localeCompare(b.id),won:value=>String(value),pageRows:rows=>rows,
  PageHeader:'PageHeader',Card:'Card',SearchBox:'SearchBox',Button:'Button',Badge:'Badge',CustomerNameCell:'CustomerNameCell',Pagination:'Pagination',RepaymentScheduleModal:'RepaymentScheduleModal',RepaymentEdit:'RepaymentEdit',ConfirmDelete:'ConfirmDelete',Modal:'Modal',
  createClient:()=>{throw Error('The UI must use the checked store write')},
 };
 const renderComponent=execute(repaymentNode.getText(pageAst)+';Repayments',context);
 function render(){cursor=0;tree=renderComponent();return tree}
 function modal(){return nodes(tree).find(node=>node.type==='Modal'&&node.props.title==='상환일정 미등록 목록 미표기')}
 function modalButton(label){const button=nodes(modal()).find(node=>node.type==='Button'&&text(node)===label);assert.ok(button,`button ${label} exists`);return button}
 render();
 return {render,modal,modalButton,get tree(){return tree},
  visibleIds(){return nodes(tree).filter(node=>node.type==='CustomerNameCell').map(node=>node.props.customer.id)},
  open(id='customer'){const row=nodes(tree).find(node=>node.type==='tr'&&nodes(node).some(child=>child.type==='CustomerNameCell'&&child.props.customer.id===id));assert.ok(row,'missing schedule row exists');const button=nodes(row).find(node=>node.type==='Button'&&text(node)==='미표기');assert.ok(button);button.props.onClick();render();assert.equal(modal().props.open,true)},
  confirm(){const buttons=nodes(modal()).filter(node=>node.type==='Button');return buttons[buttons.length-1]},
 };
}

test('the customer reload queries and maps the persisted hide flag',()=>{
 const query=findNode(storeAst,node=>ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='select'&&node.expression.expression.getText(storeAst)==='supabase.from("customers")');
 const columns=query.arguments[0].text.split(',');assert.equal(columns.includes('hide_missing_repayment'),true);
 const mapping=findNode(storeAst,node=>ts.isCallExpression(node)&&node.expression.getText(storeAst)==='setCustomers');
 let loaded;execute(mapping.getText(storeAst),{cu:{data:[{id:'hidden',hide_missing_repayment:true},{id:'visible',hide_missing_repayment:false}]},extrasByCustomer:new Map(),recoveryCreditsByCustomer:new Map(),setCustomers:update=>{loaded=update([])},reuseUnchangedRows:(_previous,next)=>next,n:value=>Number(value||0),date:value=>String(value||'').slice(0,10)});
 assert.equal(loaded[0].hideMissingRepayment,true);assert.equal(loaded[1].hideMissingRepayment,false);
});

test('the checked store write refreshes only customers and hides its live customer without changing schedules',async()=>{
 const db=database([success('customer')]),model=statefulStore(db,[customer(),customer({id:'other',memo:'보존'})]);
 const schedules=[{id:'schedule',customerId:'customer',amount:300000}];model.state.repayments=schedules;
 await model.store.hideMissingRepayment('customer');
 assert.deepEqual(plain(db.calls),[{table:'customers',patch:{hide_missing_repayment:true},filters:[['eq','id','customer'],['is','deleted_at',null]],columns:'id,hide_missing_repayment'}]);
 assert.equal(model.state.customers[0].hideMissingRepayment,true);assert.equal(model.state.customers[1].hideMissingRepayment,false);assert.equal(model.state.customers[1].memo,'보존');assert.equal(model.state.repayments,schedules);assert.equal(model.state.refreshes,1);assert.deepEqual(model.state.refreshTables,[['customers']]);
});

test('queued customer refresh replaces stale cache before unrelated partial refreshes can replay it',async()=>{
 const queueModule={exports:{}};execute(fs.readFileSync('lib/supabase/refresh-queue.ts','utf8'),{module:queueModule,exports:queueModule.exports});
 const {createTableLoader,createRefreshQueue}=queueModule.exports,load=createTableLoader();
 const remote=[{id:'customer',hide_missing_repayment:false}];let queue,fetches=0,holdNext=false,release,entered;
 const readStarted=new Promise(resolve=>{entered=resolve});
 const db=database([()=>{remote[0].hide_missing_repayment=true;return success('customer')}]);
 const model=statefulStore(db,[customer()],tables=>queue(tables));
 queue=createRefreshQueue(async tables=>{
  const result=await load('customers',!tables||tables.has('customers'),async()=>{
   fetches++;const snapshot=plain(remote);
   if(holdNext){holdNext=false;entered();await new Promise(resolve=>{release=resolve})}
   return {data:snapshot,error:null};
  });
  model.state.customers=result.data.map(row=>customer({id:row.id,hideMissingRepayment:row.hide_missing_repayment}));
 });
 await queue();assert.equal(fetches,1);assert.equal(model.state.customers[0].hideMissingRepayment,false);
 holdNext=true;const staleRefresh=queue(['customers']);await readStarted;
 let saved=false;const hide=model.store.hideMissingRepayment('customer').then(()=>{saved=true});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(remote[0].hide_missing_repayment,true);assert.equal(saved,false,'the mutation waits for the queued fresh customer snapshot');
 release();await Promise.all([staleRefresh,hide]);assert.equal(fetches,3);assert.deepEqual(model.state.refreshTables,[['customers']]);assert.equal(model.state.customers[0].hideMissingRepayment,true);
 await queue(['repayment_schedules']);assert.equal(fetches,3,'an unrelated table refresh reuses the refreshed customer cache');assert.equal(model.state.customers[0].hideMissingRepayment,true);
});

for(const [label,result] of [
 ['database error',{data:null,error:{message:'권한 오류'}}],['zero returned rows',{data:null,error:null}],
 ['a different customer',{data:{id:'other',hide_missing_repayment:true},error:null}],
 ['a false hide flag',{data:{id:'customer',hide_missing_repayment:false},error:null}],
 ['a transport exception',Error('연결 끊김')],
])test('the store rejects '+label+' without hiding any customer',async()=>{
 const db=database([result]),model=statefulStore(db);await assert.rejects(model.store.hideMissingRepayment('customer'));assert.equal(model.state.customers[0].hideMissingRepayment,false);assert.equal(model.state.updates,0);assert.equal(model.state.refreshes,0);
});

test('confirming hide removes the selected warning row and closes the actual UI',async()=>{
 const db=database([success('customer')]),model=statefulStore(db,[customer(),customer({id:'other'})]),page=screen(model);
 page.open();const pending=page.confirm().props.onClick();assert.equal(typeof pending?.then,'function');await pending;page.render();
 assert.equal(page.modal().props.open,false);assert.deepEqual(page.visibleIds(),['other']);assert.equal(db.calls.length,1);
});

test('a failed hide keeps the modal and warning visible and permits a successful retry',async()=>{
 const db=database([{data:null,error:{message:'잠시 후 재시도'}},success('customer')]),model=statefulStore(db),page=screen(model);
 page.open();await page.confirm().props.onClick();page.render();
 assert.equal(page.modal().props.open,true);assert.deepEqual(page.visibleIds(),['customer']);const error=nodes(page.modal()).find(node=>node.props.role==='alert');assert.ok(error);assert.match(text(error),/잠시 후 재시도/);assert.equal(page.confirm().props.disabled,false);
 await page.confirm().props.onClick();page.render();assert.equal(page.modal().props.open,false);assert.deepEqual(page.visibleIds(),[]);assert.equal(db.calls.length,2);
});

test('a pending hide prevents duplicate submissions, cancellation, and modal closing',async()=>{
 let finish;const db=database([()=>new Promise(resolve=>{finish=resolve})]),model=statefulStore(db),page=screen(model);page.open();
 const confirm=page.confirm().props.onClick;const first=confirm();const duplicate=confirm();page.render();assert.equal(page.modal().props.busy,true);assert.equal(page.confirm().props.disabled,true);assert.equal(page.modalButton('아니오').props.disabled,true);assert.equal(db.calls.length,1);
 page.modal().props.onClose();page.modalButton('아니오').props.onClick();page.render();assert.equal(page.modal().props.open,true);
 finish(success('customer'));await first;await duplicate;page.render();assert.equal(page.modal().props.open,false);assert.equal(db.calls.length,1);assert.equal(model.state.customers[0].hideMissingRepayment,true);
});

test('a rejected pending request releases the lock and keeps cancellation available',async()=>{
 let reject;const db=database([()=>new Promise((_resolve,fail)=>{reject=fail})]),model=statefulStore(db),page=screen(model);page.open();
 const pending=page.confirm().props.onClick();page.render();reject(Error('통신 오류'));await pending;page.render();assert.equal(page.modal().props.open,true);assert.equal(page.modal().props.busy,false);assert.equal(page.modalButton('아니오').props.disabled,false);assert.match(text(nodes(page.modal()).find(node=>node.props.role==='alert')),/통신 오류/);
 page.modalButton('아니오').props.onClick();page.render();assert.equal(page.modal().props.open,false);assert.deepEqual(page.visibleIds(),['customer']);
});

test('the visibility migration repairs the missing column and preserves existing values on reapply',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();
 try{
  await db.exec("create table public.customers(id text primary key,name text,contract_amount bigint);insert into customers values('customer','검증 고객',660000)");
  await assert.rejects(db.query("update customers set hide_missing_repayment=true where id='customer'"),error=>error.code==='42703');
  const migration=fs.readFileSync('tests/fixtures/dowon-reference/supabase/migrations/20261019123644_missing_repayment_visibility.sql','utf8');
  await db.exec(migration);
  assert.deepEqual((await db.query('select * from customers')).rows,[{id:'customer',name:'검증 고객',contract_amount:660000,hide_missing_repayment:false}]);
  await db.exec("update customers set hide_missing_repayment=true where id='customer'");
  await db.exec(migration);
  assert.deepEqual((await db.query('select * from customers')).rows,[{id:'customer',name:'검증 고객',contract_amount:660000,hide_missing_repayment:true}]);
 }finally{await db.close()}
});
