const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const vm=require('node:vm');
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
function compile(source,context={}){
 const mod={exports:{}};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{require,exports:mod.exports,module:mod,...context});
 return mod.exports;
}
const {buildScheduleLedger}=compile(fs.readFileSync('lib/schedule-ledger.ts','utf8'));
const raw=fs.readFileSync('components/payment-overplanned.tsx','utf8');
const ast=ts.createSourceFile('overplanned.tsx',raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const functions=ast.statements.filter(ts.isFunctionDeclaration).map(node=>node.getText(ast)).join('\n');
const {overplannedPaymentCustomers,PaymentOverplanned}=compile(functions,{
 useMemo:run=>run(),isEformSignedStatus:value=>value==='doc_complete',won:value=>`${value}원`,
 Card:({children,...props})=>React.createElement('section',props,children),Button:({children,...props})=>React.createElement('button',props,children),
});
const customer=(id,patch={})=>({id,name:`가상 고객 ${id}`,phone:'010-0000-0000',contractAmount:1000000,recoveryCredit:0,eformsignStatus:'doc_complete',manager:'가상 담당자',coordinationManager:'가상 조율자',...patch});
const payment=(id,patch={})=>({id,dueDate:'2026-10-23',dueAmount:500000,paidAmount:0,paidDate:'',promiseState:'active',status:'예정',...patch});
function ledger(c,rows){return buildScheduleLedger(rows,c.contractAmount,c.recoveryCredit);}

test('warning shows the true outstanding, current promise sum and exact excess without counting history again',()=>{
 const c=customer('a',{recoveryCredit:100000}),rows=[
  payment('cash',{paidAmount:200000,paidDate:'2026-10-20',status:'완료',promiseState:'cancelled'}),
  payment('current'),payment('undated',{dueDate:'',dueAmount:400000}),
  payment('old',{dueAmount:900000,promiseState:'rescheduled'}),
  payment('removed',{dueAmount:800000,promiseState:'cancelled'}),
 ],data=new Map([[c.id,ledger(c,rows)]]),before=JSON.stringify(rows);
 const result=overplannedPaymentCustomers([c],data);
 assert.equal(result.length,1);assert.equal(result[0].receivable,700000);assert.equal(result[0].promised,900000);assert.equal(result[0].excess,200000);
 assert.equal(JSON.stringify(rows),before);assert.equal(data.get(c.id).totals.paid,200000);assert.equal(data.get(c.id).totals.credit,100000);
});

test('equal and lower promises are omitted while allocation credit lowers the true remaining balance',()=>{
 for(const dueAmount of [0,500000,1000000]){
  const c=customer('equal');assert.equal(overplannedPaymentCustomers([c],new Map([[c.id,ledger(c,[payment('p',{dueAmount})])]])).length,0);
 }
 const c=customer('credit'),data=new Map([[c.id,ledger(c,[payment('credited',{dueAmount:1000000,allocatedAmount:300000}),payment('excess',{dueAmount:100000})])]]);
 const row=overplannedPaymentCustomers([c],data)[0];assert.equal(row.receivable,700000);assert.equal(row.promised,800000);assert.equal(row.excess,100000);
});

test('only signed operational customers are shown, ordered by largest excess',()=>{
 const clients=[customer('small'),customer('large'),customer('unsigned',{eformsignStatus:'doc_create'}),customer('accident',{isAccident:true}),customer('no-ledger')];
 const data=new Map(clients.slice(0,4).map((c,index)=>[c.id,ledger(c,[payment('p',{dueAmount:1100000+index*100000})])]));
 assert.deepEqual(Array.from(overplannedPaymentCustomers(clients,data),row=>row.customer.id),['large','small']);
});

test('a settled contract with new live promises is flagged without recreating any receipt',()=>{
 const c=customer('settled'),rows=[payment('paid',{dueAmount:1000000,paidAmount:1000000,status:'완료',promiseState:'cancelled'}),payment('new',{dueAmount:300000})];
 const result=overplannedPaymentCustomers([c],new Map([[c.id,ledger(c,rows)]]));assert.equal(result[0].receivable,0);assert.equal(result[0].promised,300000);assert.equal(result[0].excess,300000);
 assert.equal(rows[0].paidAmount,1000000);
});

test('the horizontal box shows exact amounts and opens only the selected customer editor',()=>{
 const c=customer('screen'),data=new Map([[c.id,ledger(c,[payment('p',{dueAmount:1200000})])]]),selected=[];
 const tree=PaymentOverplanned({customers:[c],ledgers:data,onManage:value=>selected.push(value)}),html=renderToStaticMarkup(tree);
 for(const label of ['예정 금액 초과 의뢰인','현재 미수금','현재 약속 합계','초과 금액','1000000원','1200000원','200000원','일정 수정'])assert.ok(html.includes(label),label);
 assert.match(html,/admin-responsive-table.*min-w-\[1100px\]/);
 function visit(node){if(!React.isValidElement(node))return;if(node.props.onClick)node.props.onClick();React.Children.forEach(node.props.children,visit);}
 visit(tree);assert.deepEqual(selected,[c]);assert.equal(data.get(c.id).totals.overplanned,200000);
});

test('no empty warning box is rendered when no customer is overplanned',()=>{
 const c=customer('none'),ledgers=new Map([[c.id,ledger(c,[payment('p')])]]);
 assert.equal(PaymentOverplanned({customers:[c],ledgers,onManage:()=>assert.fail('no action expected')}),null);
});
