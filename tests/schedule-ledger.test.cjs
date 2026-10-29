const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const mod={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/schedule-ledger.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{module:mod,exports:mod.exports});
const {buildScheduleLedger:ledger,previewScheduleLedger:preview}=mod.exports;
const row=(id,amount=500000,other={})=>({id,dueAmount:amount,dueDate:'2026-10-16',paidAmount:0,paidDate:'',status:'연체',...other});
const values=l=>[l.totals.paid,l.totals.remaining,l.totals.planned,l.totals.undated];
test('50만원 약속, 16일 20만원 입금, 30만원 재약정 preserves each cash fact',()=>{
 const source=row('a',500000,{paidAmount:200000,paidDate:'2026-10-16'}),before=JSON.stringify(source);
 const result=preview([source],[source],{a:[{dueDate:'2026-10-20',dueAmount:300000}]},[],500000);
 assert.deepEqual(values(result.before),[200000,300000,300000,0]);
 assert.deepEqual(values(result.after),[200000,300000,300000,0]);
 assert.equal(result.after.byId.get('a').history,true);assert.equal(result.after.byId.get('a').remaining,0);
 assert.equal(JSON.stringify(source),before);
});
test('partial replan preserves unassigned debt without inventing a date or receipt',()=>{
 const source=row('a',500000,{paidAmount:200000});
 const {after}=preview([source],[source],{a:[{dueDate:'2026-10-20',dueAmount:100000}]},[],500000);
 assert.deepEqual(values(after),[200000,300000,100000,200000]);assert.equal(after.totals.unassigned,200000);
 assert.equal(after.byId.get('a').unassigned,0);assert.equal(after.byId.get('a').history,true);
});
test('unknown date stays explicit while split dates share the same revision budget',()=>{
 const source=row('a',500000,{paidAmount:200000});
 const {after}=preview([source],[source],{a:[{dueDate:'',dueAmount:100000},{dueDate:'2026-10-20',dueAmount:200000}]},[],500000);
 assert.deepEqual(values(after),[200000,300000,200000,100000]);assert.equal(after.totals.unassigned,0);
});
test('cancelling a paid promise preserves receipt and debt',()=>{
 const source=row('a',500000,{paidAmount:200000,paidDate:'2026-10-16'});
 const {after}=preview([source],[],{},['a'],500000);
 assert.deepEqual(values(after),[200000,300000,0,300000]);assert.equal(after.byId.get('a').state,'cancelled');
});
test('cancelling all children never reactivates the original promise',()=>{
 const root=row('a'),child=row('b',500000,{rescheduledFromId:'a',promiseState:'cancelled'});
 const result=ledger([root,child],500000);assert.equal(result.byId.get('a').history,true);assert.equal(result.totals.undated,500000);
});
test('cash recorded on an original reduces debt while preserving the manually entered current promise',()=>{
 const rows=[row('a',500000,{paidAmount:300000}),row('b',300000,{rescheduledFromId:'a',dueDate:'2026-10-20'})];
 assert.deepEqual(values(ledger(rows,500000)),[300000,200000,300000,0]);
 assert.equal(ledger(rows,500000).totals.overplanned,100000);
});
test('full receipt clears actual debt while a remaining manual promise stays visible for correction',()=>{
 const result=ledger([row('a',500000,{paidAmount:500000}),row('b',500000,{rescheduledFromId:'a'})],500000);
 assert.deepEqual(values(result),[500000,0,500000,0]);
 assert.equal(result.totals.overplanned,500000);assert.equal(result.byId.get('a').history,true);
});
test('overpayment is excess, never negative debt or fabricated outgoing cash',()=>{
 const result=ledger([row('a',500000,{paidAmount:600000})],500000);
 assert.equal(result.totals.excess,100000);assert.equal(result.totals.remaining,0);assert.equal(result.totals.paid,600000);
});
test('legacy root473000 child693000 respects real contract693000',()=>{
 const result=ledger([row('a',473000),row('b',693000,{rescheduledFromId:'a'})],693000);
 assert.equal(result.totals.remaining,693000);assert.equal(result.byId.get('b').remaining,693000);assert.equal(result.totals.overplanned,0);
});
test('excess legacy promises are diagnostic, not added debt',()=>{
 const result=ledger([row('a',1000000),row('b',1030000,{dueDate:'2026-10-20'})],1650000);
 assert.equal(result.totals.remaining,1650000);assert.equal(result.totals.planned,2030000);assert.equal(result.totals.overplanned,380000);
});
test('allocation reduces debt without becoming cash; refund/recovery excluded',()=>{
 const result=ledger([row('a',500000,{paidAmount:100000,allocatedAmount:100000}),row('r',100000,{scheduleType:'환수',paidAmount:100000}),row('refund',50000,{status:'환불',paidAmount:50000})],500000);
 assert.equal(result.totals.paid,100000);assert.equal(result.totals.credit,100000);assert.equal(result.totals.remaining,300000);
});
test('completed status alone cannot create cash or extinguish a debt',()=>{
 const result=ledger([row('a',500000,{status:'완료',paidAmount:0})],500000);
 assert.equal(result.totals.paid,0);assert.equal(result.totals.remaining,500000);
});
test('repayment promise amount edit does not implicitly edit the obligation',()=>{
 const original=row('a',500000,{paidAmount:200000});
 const result=preview([original],[{...original,dueAmount:100000}],{},[]);
 assert.equal(result.after.totals.owed,500000);assert.equal(result.after.totals.remaining,300000);
 assert.equal(result.after.totals.undated,300000);
});
test('repayment creditors remain separate pools even if one is overpaid',()=>{
 const result=ledger([row('a',500000,{paidAmount:600000}),row('b',500000)]);
 assert.equal(result.totals.remaining,500000);assert.equal(result.totals.excess,100000);assert.equal(result.byId.get('b').remaining,500000);
});
test('unassigned shared balance stays at customer level without reactivating a history root',()=>{
 const result=ledger([row('a',100000,{promiseState:'cancelled'}),row('b',100000,{promiseState:'cancelled'})],200000);
 assert.equal(result.totals.unassigned,200000);assert.equal(result.totals.undated,200000);
 assert.equal([...result.byId.values()].reduce((sum,p)=>sum+p.unassigned,0),0);
});
test('multiple rounds, sibling partial receipt, unified replacement conserve money',()=>{
 const rows=[row('a',500000,{paidAmount:200000}),row('b',100000,{rescheduledFromId:'a',paidAmount:50000}),row('c',200000,{rescheduledFromId:'a'})];
 const {after}=preview(rows,rows,{b:[{dueDate:'2026-11-01',dueAmount:50000}],c:[{dueDate:'2026-11-01',dueAmount:200000}]},[],500000);
 assert.deepEqual(values(after),[250000,250000,250000,0]);
 assert.equal(after.byId.get('b').history,true);assert.equal(after.byId.get('c').history,true);
});
test('a historical receipt never silently reduces any manually registered installment',()=>{
 const rows=[row('a',300000),row('a-child',300000,{rescheduledFromId:'a',dueDate:'2026-10-20'}),row('b',200000,{dueDate:'2026-11-20'})];
 const draft=rows.map(r=>r.id==='a'?{...r,paidAmount:100000,paidDate:'2026-10-17'}:r);
 const {after}=preview(rows,draft,{},[],500000);
 assert.equal(after.byId.get('a-child').remaining,300000);assert.equal(after.byId.get('b').remaining,200000);
 assert.deepEqual(values(after),[100000,400000,500000,0]);assert.equal(after.totals.overplanned,100000);
});
test('cancel and newly entered receipt in the same save are both preserved',()=>{
 const original=row('a');const {after}=preview([original],[{...original,paidAmount:200000,paidDate:'2026-10-16',promiseState:'cancelled'}],{},[],500000);
 assert.deepEqual(values(after),[200000,300000,0,300000]);
});
test('deleted repayment ancestor metadata preserves debt without restoring its old cash',()=>{
 const result=ledger([row('child',200000,{rescheduledFromId:'deleted',rootScheduleId:'deleted',rootObligationAmount:500000,paidAmount:100000})]);
 assert.equal(result.totals.owed,500000);assert.equal(result.totals.paid,100000);assert.equal(result.totals.remaining,400000);
 assert.equal(result.totals.undated,300000);
});
test('a saved zero placeholder can receive an actual promise from unassigned contract debt',()=>{
 const original=row('a',0,{obligationAmount:0});const {after}=preview([original],[{...original,dueAmount:100000}],{},[],500000);
 assert.equal(after.totals.planned,100000);assert.equal(after.totals.undated,400000);assert.equal(after.totals.overplanned,0);
});
test('promise increase assigns unplanned debt while an excess remains visible',()=>{
 const original=row('a',500000,{obligationAmount:500000});
 const first=preview([original],[{...original,dueAmount:700000}],{},[],1000000).after;
 assert.equal(first.totals.planned,700000);assert.equal(first.totals.undated,300000);assert.equal(first.totals.owed,1000000);
 const excess=preview([original],[{...original,dueAmount:1100000}],{},[],1000000).after;
 assert.equal(excess.totals.overplanned,100000);assert.equal(excess.totals.owed,1000000);
});

test('explicit promise increase accounts for money already above its old family budget',()=>{
 const original=row('a',100000,{obligationAmount:100000,paidAmount:150000,paidDate:'2026-10-16'});
 for(const contract of [300000,500000]){const {after}=preview([original],[{...original,dueAmount:300000}],{},[],contract);
 assert.equal(after.totals.planned,150000);assert.equal(after.totals.undated,contract-300000);assert.equal(after.totals.overplanned,0);assert.equal(after.totals.paid,150000);}
});

test('moving a date edits the existing promise without generating another row or changing cash',()=>{
 const original=row('a',500000,{paidAmount:200000,paidDate:'2026-10-16',obligationAmount:500000});
 const snapshot=JSON.stringify(original),draft={...original,dueDate:'2026-11-01'};
 const {before,after}=preview([original],[draft],{},[],500000);
 assert.deepEqual(values(after),values(before));assert.equal(after.byId.size,1);
 assert.equal(after.byId.get('a').remaining,300000);assert.equal(after.byId.get('a').history,false);
 assert.equal(draft.paidAmount,200000);assert.equal(draft.paidDate,'2026-10-16');assert.equal(JSON.stringify(original),snapshot);
});

test('raising a repayment promise never increases its recorded obligation',()=>{
 const original=row('a',100000,{obligationAmount:100000,paidAmount:20000,paidDate:'2026-10-16'});
 const {after}=preview([original],[{...original,dueAmount:300000}],{},[]);
 assert.equal(after.totals.owed,100000);assert.equal(after.totals.remaining,80000);
 assert.equal(after.totals.planned,280000);assert.equal(after.totals.overplanned,200000);assert.equal(after.totals.paid,20000);
});

test('detailed recovery credit reduces actual debt once while leaving receipt and entered schedule amounts intact',()=>{
 const source=row('a',500000,{paidAmount:100000,allocatedAmount:100000,paidDate:'2026-10-16'}),snapshot=JSON.stringify(source);
 const {before,after}=preview([source],[{...source,dueDate:'2026-11-01'}],{},[],500000,50000);
 for(const result of [before,after]){
  assert.equal(result.totals.paid,100000);assert.equal(result.totals.credit,150000);
  assert.equal(result.totals.remaining,250000);assert.equal(result.totals.planned,300000);
  assert.equal(result.byId.get('a').remaining,300000);assert.equal(result.totals.overplanned,50000);
 }
 assert.equal(JSON.stringify(source),snapshot);
});

test('customer recovery credit is applied once across independent schedules and without payment rows',()=>{
 const result=ledger([row('a',100000),row('b',200000)],500000,150000);
 assert.equal(result.totals.credit,150000);assert.equal(result.totals.remaining,350000);assert.equal(result.totals.paid,0);
 const empty=ledger([],500000,150000);
 assert.equal(empty.totals.credit,150000);assert.equal(empty.totals.remaining,350000);assert.equal(empty.totals.undated,350000);
});

test('excess recovery credit stays separate from actual cash receipts',()=>{
 const result=ledger([row('a',200000,{paidAmount:100000,allocatedAmount:50000})],200000,100000);
 assert.equal(result.totals.paid,100000);assert.equal(result.totals.credit,150000);
 assert.equal(result.totals.remaining,0);assert.equal(result.totals.excess,50000);
});
