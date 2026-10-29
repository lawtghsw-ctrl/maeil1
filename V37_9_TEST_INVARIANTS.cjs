/* Node regression checks: run `node V37_9_TEST_INVARIANTS.cjs`. No Supabase writes. */
const fs=require('fs');const assert=require('node:assert/strict');const vm=require('node:vm');
const ts=require('./node_modules/typescript');
const src=fs.readFileSync('lib/payment-metrics.ts','utf8');
const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const mod={exports:{}};vm.runInNewContext(js,{module:mod,exports:mod.exports,require:()=>({})});
const m=mod.exports;
const p=(id,due,paid,parent)=>({id,customerId:'a',dueDate:'2026-10-15',dueAmount:due,paidDate:paid>0?'2026-10-15':'',paidAmount:paid,status:'예정',memo:'',rescheduledFromId:parent||'',scheduleType:parent?'재약정':'일반'});
function verify(rows,expectedPaid,expectedRemaining){
 const paid=rows.reduce((s,r)=>s+r.paidAmount,0);
 const remaining=m.effectivePayments(rows).reduce((s,r)=>s+m.paymentRemaining(r),0);
 assert.equal(paid,expectedPaid);assert.equal(remaining,expectedRemaining);assert.equal(paid+remaining,500000);
}
verify([p('root',500000,100000),p('child',400000,0,'root')],100000,400000);
verify([p('root',500000,100000),p('child',400000,200000,'root'),p('leaf',200000,0,'child')],300000,200000);
verify([p('root',500000,100000),p('child',400000,200000,'root'),p('leaf',200000,200000,'child')],500000,0);
assert.equal(m.originalPlannedPayments([p('root',500000,100000),p('child',400000,0,'root')]).length,1);
console.log('PASS: historical three-step partial-payment conservation');
