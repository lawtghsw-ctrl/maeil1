const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');

function compile(source,context={}){
 const module={exports:{}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,Error,...context});
 return module.exports;
}
const api=compile(fs.readFileSync('lib/installment-plan.ts','utf8'));
const plain=value=>JSON.parse(JSON.stringify(value));
const input=(patch={})=>({totalAmount:1000000,months:3,firstPaymentDate:'2026-11-03',...patch});
const form=(patch={})=>({createdAt:'2026-11-01',contractDate:'2026-11-03',name:'분납 검증 고객',phone:'01000000000',address:'',birthNumber:'',manager:'신홍규',coordinationManager:'이중호',memo:'기존 메모',contractAmount:1000000,prepaidAmount:100000,installmentMonths:3,installmentTotal:900000,installmentFirstDate:'2026-11-05',autoCreateInstallments:true,monthlyNetSalary:0,salaryDay:0,lenderUnitPrice:0,lenderCount:1,isAccident:false,...patch});
function preview(value){
 const plan=api.buildInstallmentPlan({totalAmount:api.getCustomerInstallmentTotal(value),months:value.installmentMonths,firstPaymentDate:value.installmentFirstDate||value.contractDate||value.createdAt});
 return {...value,installmentRows:plain(plan.rows),installmentPlanSignature:api.customerInstallmentSignature(value)};
}

test('manual installment calculation needs only the chosen total, count and first date',()=>{
 const plan=api.buildInstallmentPlan(input());
 assert.deepEqual(plain(plan),{totalAmount:1000000,remaining:1000000,monthlyAmount:333333,months:3,rows:[{dueDate:'2026-11-03',amount:333333},{dueDate:'2026-12-03',amount:333333},{dueDate:'2027-01-03',amount:333334}]});
});
test('the final installment receives the whole remainder without changing the requested count',()=>{
 for(const [total,count,expected] of [[10,3,[3,3,4]],[13,5,[2,2,2,2,5]],[100,1,[100]],[4,4,[1,1,1,1]]]){
  const plan=api.buildInstallmentPlan(input({totalAmount:total,months:count}));assert.deepEqual(Array.from(plan.rows,row=>row.amount),expected);assert.equal(plan.months,count);assert.equal(plan.rows.reduce((sum,row)=>sum+row.amount,0),total);
 }
});
test('month-end clamping restores the chosen day after a short month',()=>{
 for(const [first,dates] of [
  ['2027-01-31',['2027-01-31','2027-02-28','2027-03-31','2027-04-30']],
  ['2028-01-31',['2028-01-31','2028-02-29','2028-03-31','2028-04-30']],
  ['2026-11-30',['2026-11-30','2026-12-30','2027-01-30','2027-02-28']],
  ['2026-12-29',['2026-12-29','2027-01-29','2027-02-28','2027-03-29']],
 ])assert.deepEqual(Array.from(api.buildInstallmentPlan(input({firstPaymentDate:first,months:dates.length})).rows,row=>row.dueDate),dates);
});
test('a plan extending beyond the supported date range is rejected',()=>{assert.throws(()=>api.buildInstallmentPlan(input({firstPaymentDate:'9999-12-31',months:2})),Error)});
test('safe integer totals remain conserved through the maximum 600 installments',()=>{
 const total=Number.MAX_SAFE_INTEGER,plan=api.buildInstallmentPlan(input({totalAmount:total,months:600,firstPaymentDate:'2026-01-31'}));
 assert.equal(plan.rows.length,600);assert.equal(plan.rows[599].dueDate,'2075-12-31');assert.ok(plan.rows.every(row=>Number.isSafeInteger(row.amount)&&row.amount>0));assert.equal(plan.rows.reduce((sum,row)=>sum+row.amount,0),total);
});
test('zero amount and explicitly disabled auto creation both return an empty plan',()=>{
 const expected={totalAmount:0,remaining:0,monthlyAmount:0,months:0,rows:[]};
 assert.deepEqual(plain(api.buildInstallmentPlan(input({totalAmount:0,months:0,firstPaymentDate:''}))),expected);
 assert.deepEqual(plain(api.getCustomerInstallmentPlan(form({autoCreateInstallments:false,installmentMonths:0,installmentFirstDate:'',installmentPlanSignature:undefined,installmentRows:undefined}))),expected);
 assert.deepEqual(plain(api.getCustomerInstallmentPlan(form({installmentTotal:0,installmentMonths:0,installmentFirstDate:''}))),expected);
});
for(const amount of [-1,0.5,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1,'100',null,undefined])test('invalid manual total is rejected: '+String(amount),()=>{assert.throws(()=>api.buildInstallmentPlan(input({totalAmount:amount})),Error)});
for(const months of [0,-1,1.5,601,NaN,Infinity,'3',null,undefined])test('invalid positive-total installment count is rejected: '+String(months),()=>{assert.throws(()=>api.buildInstallmentPlan(input({months})),Error)});
test('a requested count that would create zero-amount rows is rejected rather than changed silently',()=>{assert.throws(()=>api.buildInstallmentPlan(input({totalAmount:2,months:3})),Error)});
for(const date of ['','2026-02-29','2026-02-30','2026-11-31','2026-00-01','2026-13-01','2026-01-00','2026-01-32','2026-2-03','2026-11-03T00:00:00Z'])test('invalid first payment date is rejected: '+date,()=>{assert.throws(()=>api.buildInstallmentPlan(input({firstPaymentDate:date})),Error)});

test('customer total defaults to the unprepaid contract balance and honors an explicitly chosen total',()=>{
 assert.equal(api.getCustomerInstallmentTotal(form({installmentTotal:undefined})),900000);
 assert.equal(api.getCustomerInstallmentTotal(form({installmentTotal:120000})),120000);
 assert.equal(api.getCustomerInstallmentTotal(form({installmentTotal:0})),0);
});
test('a validated editable preview is saved exactly without any salary data',()=>{
 const value=preview(form()),rows=[{dueDate:'2026-11-07',amount:200000},{dueDate:'2026-12-10',amount:300000},{dueDate:'2027-01-15',amount:400000}];
 const plan=api.getCustomerInstallmentPlan({...value,installmentRows:rows});
 assert.deepEqual(plain(plan.rows),rows);assert.equal(plan.totalAmount,900000);assert.equal(plan.months,3);plan.rows[0].amount=1;assert.equal(rows[0].amount,200000);
 assert.equal(api.customerInstallmentSignature(value),api.customerInstallmentSignature({...value,monthlyNetSalary:99999999,salaryDay:31}));
 assert.deepEqual(plain(api.getCustomerInstallmentPlan({...value,installmentRows:rows,monthlyNetSalary:99999999,salaryDay:31}).rows),rows);
});
test('a positive customer installment plan must be calculated before it can be submitted',()=>{
 assert.throws(()=>api.getCustomerInstallmentPlan(form()),Error);
 assert.throws(()=>api.getCustomerInstallmentPlan({...form(),installmentRows:preview(form()).installmentRows}),Error);
});
for(const patch of [{installmentTotal:800000},{installmentMonths:2},{installmentFirstDate:'2026-12-01'}])test('changed calculation inputs invalidate the old preview: '+Object.keys(patch)[0],()=>{assert.throws(()=>api.getCustomerInstallmentPlan({...preview(form()),...patch}),Error)});
for(const rows of [
 [{dueDate:'2026-11-05',amount:900000}],
 [{dueDate:'2026-11-05',amount:100000},{dueDate:'2026-12-05',amount:200000},{dueDate:'2027-01-05',amount:300000}],
 [{dueDate:'2026-11-05',amount:0},{dueDate:'2026-12-05',amount:300000},{dueDate:'2027-01-05',amount:600000}],
 [{dueDate:'2026-11-05',amount:-1},{dueDate:'2026-12-05',amount:300000},{dueDate:'2027-01-05',amount:600001}],
 [{dueDate:'2026-11-31',amount:300000},{dueDate:'2026-12-05',amount:300000},{dueDate:'2027-01-05',amount:300000}],
 [{dueDate:'2026-11-05',amount:300000.5},{dueDate:'2026-12-05',amount:300000},{dueDate:'2027-01-05',amount:299999.5}],
])test('malformed or unbalanced editable preview is rejected: '+JSON.stringify(rows),()=>{assert.throws(()=>api.getCustomerInstallmentPlan({...preview(form()),installmentRows:rows}),Error)});

test('shared initial customer form contains manual calculation fields and no salary fields',()=>{
 const file='components/customer-form-fields.tsx',source=fs.readFileSync(file,'utf8');
 assert.doesNotMatch(source,/세후 월급여|급여일|월급여 15%|buildSalaryInstallmentPlan|monthlyNetSalary|salaryDay/);
 assert.match(source,/buildInstallmentPlan/);assert.match(source,/installmentTotal/);assert.match(source,/installmentFirstDate/);assert.match(source,/installmentRows/);
});

function creationRoute(kind,value,{editing=false}={}){
 const calls=[],errors=[];let refreshed=0,closed=0;
 const supabase={from(table){return {
  select(){const query={eq:()=>query,limit:async()=>({data:[],error:null})};return query;},
  insert(payload){calls.push({table,action:'insert',payload:plain(payload)});return {error:null,select:()=>({single:async()=>({data:{id:'new-customer'},error:null})})};},
  update(payload){calls.push({table,action:'update',payload:plain(payload)});return {eq:async()=>({error:null})};},
 };}};
 const file=kind==='store'?'components/store.tsx':'components/meta-leads-v28.tsx';
 const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let node;const name=kind==='store'?(editing?'updateCustomer':'addCustomer'):'saveCustomer';
 function visit(n){if((ts.isMethodDeclaration(n)||ts.isFunctionDeclaration(n))&&n.name?.getText(tree)===name)node=n;ts.forEachChild(n,visit);}visit(tree);assert.ok(node,name);
 const context={...api,supabase,customers:[{...value,id:'existing-customer'}],payments:[],customerForm:value,selectedLead:{id:'source-lead'},
  refresh:async()=>{refreshed++},load:async()=>{refreshed++},fail:message=>errors.push(message),alert:message=>{if(!/고객정보 등록이 완료/.test(message))errors.push(message)},sendMetaResult:async()=>{},setCustomerOpen:()=>{closed++},setSelectedLead(){},setCustomerForm(){},showToast(){},
 };
 const code=ts.isMethodDeclaration(node)?'exports.run=({'+node.getText(tree)+'}).'+name+';':node.getText(tree)+';exports.run='+name+';';
 const run=compile(code,context).run;
 return {calls,errors,async execute(){await (kind==='store'?(editing?run('existing-customer',{memo:'정정 메모',monthlyNetSalary:0,salaryDay:0}):run(value)):run());await new Promise(resolve=>setImmediate(resolve));return {refreshed,closed};}};
}
for(const kind of ['store','lead'])test(kind+' initial creation persists the validated edited installment rows without salary columns',async()=>{
 const value=preview(form()),edited=[{dueDate:'2026-11-07',amount:200000},{dueDate:'2026-12-10',amount:300000},{dueDate:'2027-01-15',amount:400000}];
 const route=creationRoute(kind,{...value,installmentRows:edited}),result=await route.execute();assert.deepEqual(route.errors,[]);assert.ok(result.refreshed>0);
 const customer=route.calls.find(call=>call.table==='customers'&&call.action==='insert');assert.ok(customer);assert.equal(customer.payload.installment_period,3);assert.equal('monthly_net_salary' in customer.payload,false);assert.equal('salary_day' in customer.payload,false);
 const schedules=route.calls.filter(call=>call.table==='payment_schedules'&&call.action==='insert').flatMap(call=>Array.isArray(call.payload)?call.payload:[call.payload]),pending=schedules.filter(row=>row.status==='예정');
 assert.deepEqual(pending.map(row=>({dueDate:row.due_date,amount:row.expected_amount})),edited);assert.ok(pending.every(row=>row.paid_amount===0&&row.paid_date===null));
 const receipts=schedules.filter(row=>row.status==='완료');assert.equal(receipts.length,1);assert.equal(receipts[0].paid_amount,100000);assert.equal(receipts[0].paid_date,'2026-11-03');
});
for(const kind of ['store','lead'])test(kind+' rejects a stale preview before creating customer or payment rows',async()=>{
 const value={...preview(form()),installmentTotal:800000};const route=creationRoute(kind,value);await route.execute();assert.equal(route.calls.length,0);assert.equal(route.errors.length,1);
});
for(const kind of ['store','lead'])test(kind+' auto creation disabled needs no preview and creates no future installments',async()=>{
 const route=creationRoute(kind,form({autoCreateInstallments:false,prepaidAmount:0,installmentRows:undefined,installmentPlanSignature:undefined}));await route.execute();assert.deepEqual(route.errors,[]);assert.ok(route.calls.some(call=>call.table==='customers'&&call.action==='insert'));assert.equal(route.calls.some(call=>call.table==='payment_schedules'),false);
});
test('editing an existing customer preserves salary fields and never regenerates installments',async()=>{
 const route=creationRoute('store',form({monthlyNetSalary:2500000,salaryDay:25}),{editing:true});await route.execute();assert.deepEqual(route.errors,[]);assert.equal(route.calls.length,1);const call=route.calls[0];assert.equal(call.table,'customers');assert.equal(call.action,'update');assert.equal(call.payload.memo,'정정 메모');assert.equal('monthly_net_salary' in call.payload,false);assert.equal('salary_day' in call.payload,false);
});

function elements(tree){if(Array.isArray(tree))return tree.flatMap(elements);if(!tree||typeof tree!=='object')return [];return [tree,...elements(tree.props?.children)];}
function text(tree){if(Array.isArray(tree))return tree.map(text).join('');return tree&&typeof tree==='object'?text(tree.props?.children):tree==null?'':String(tree);}
function initialEditor(value=form(),editing=false){
 let current=value,saved=0,tree;const alerts=[];
 const loaded=compile(fs.readFileSync('components/customer-form-fields.tsx','utf8'),{window:{alert:message=>alerts.push(message)},require:name=>{
  if(name==='@/components/ui')return {Button:'Button'};
  if(name==='@/components/customer-text-import')return {CustomerTextImport:'CustomerTextImport'};
  if(name==='@/lib/installment-plan')return api;
  if(name==='@/lib/utils')return {formatBirthNumber:v=>v,formatPhone:v=>v,won:v=>String(v)};
  return require(name);
 }});
 const render=()=>tree=loaded.CustomerFormFields({open:true,form:current,setForm:next=>{current=next},editing,showTextImport:false,onClose(){},onSave(){saved++}});
 render();return {render,alerts,get form(){return current},get saved(){return saved},get tree(){return tree},
  button(label){const found=elements(tree).find(node=>node.type==='Button'&&text(node)===label);assert.ok(found,label);return found;},
  field(label){const found=elements(tree).find(node=>node.type?.name==='Label'&&node.props.text===label);assert.ok(found,label);return elements(found).find(node=>['input','select','textarea'].includes(node.type)||node.type?.name==='NumberInput');},
  row(index){const found=elements(tree).find(node=>node.type==='div'&&node.key===String(index)&&node.props.className?.includes('grid-cols-'));assert.ok(found,'installment row '+index);const children=elements(found);return {date:children.find(node=>node.type==='input'&&node.props.type==='date'),amount:children.find(node=>node.type?.name==='NumberInput')};},
 };
}
test('the shared form calculates and submits an initial plan after choosing total, months and first date',()=>{
 const page=initialEditor();page.button('등록').props.onClick();assert.equal(page.saved,0);assert.equal(page.alerts.length,1);
 page.field('총 분납금').props.onChange(120000);page.render();page.field('분납 개월 수').props.onChange(4);page.render();page.field('첫 납부일').props.onChange({target:{value:'2026-11-30'}});page.render();page.button('일정 만들기').props.onClick();page.render();
 assert.deepEqual(plain(page.form.installmentRows),[{dueDate:'2026-11-30',amount:30000},{dueDate:'2026-12-30',amount:30000},{dueDate:'2027-01-30',amount:30000},{dueDate:'2027-02-28',amount:30000}]);page.button('등록').props.onClick();assert.equal(page.saved,1);
});
test('editing the total invalidates the existing preview until the operator explicitly rebuilds it',()=>{
 const page=initialEditor(preview(form()));page.field('총 분납금').props.onChange(600000);page.render();page.button('등록').props.onClick();assert.equal(page.saved,0);assert.equal(page.alerts.length,1);
 page.button('일정 만들기').props.onClick();page.render();assert.deepEqual(Array.from(page.form.installmentRows,row=>row.amount),[200000,200000,200000]);page.button('등록').props.onClick();assert.equal(page.saved,1);
});
test('row dates and amounts are editable but an unbalanced preview cannot be submitted',()=>{
 const page=initialEditor(preview(form()));page.row(0).amount.props.onChange(200000);page.render();page.button('등록').props.onClick();assert.equal(page.saved,0);assert.equal(page.alerts.length,1);
 page.row(1).amount.props.onChange(400000);page.render();page.row(0).date.props.onChange({target:{value:'2026-11-09'}});page.render();page.button('등록').props.onClick();assert.equal(page.saved,1);assert.equal(page.form.installmentRows[0].dueDate,'2026-11-09');assert.deepEqual(Array.from(page.form.installmentRows,row=>row.amount),[200000,400000,300000]);
});
test('initial creation can opt out of installments without entering salary or building a preview',()=>{
 const page=initialEditor(form({autoCreateInstallments:false}));assert.equal(elements(page.tree).some(node=>node.type==='Button'&&text(node)==='일정 만들기'),false);page.button('등록').props.onClick();assert.equal(page.saved,1);assert.deepEqual(page.alerts,[]);
});
test('an existing customer form saves metadata without requiring or building any plan',()=>{
 const page=initialEditor(form({monthlyNetSalary:2500000,salaryDay:25}),true);page.field('메모').props.onChange({target:{value:'메모 정정'}});page.render();page.button('수정 저장').props.onClick();assert.equal(page.saved,1);assert.equal(page.form.memo,'메모 정정');assert.equal(page.form.installmentRows,undefined);assert.equal(elements(page.tree).some(node=>node.type==='Button'&&text(node)==='일정 만들기'),false);
});
