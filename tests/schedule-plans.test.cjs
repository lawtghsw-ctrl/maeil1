const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const vm=require('node:vm');
const mod={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/schedule-plans.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:mod.exports,module:mod,Error,Date});
const {allocateSchedulePlans,isScheduleDate,isScheduleAmount,scheduleDateChangeCount}=mod.exports;
const plain=value=>JSON.parse(JSON.stringify(value));

test('replanning rejects a promise that would exceed available debt',()=>{
 assert.throws(()=>allocateSchedulePlans([{id:'a',balance:200000},{id:'b',balance:350000}],[{date:'2026-10-20',amount:600000},{date:'2026-10-21',amount:50000}]),/100,000/);
});
test('zero balances never block or loop and zero-valued schedules remain explicit',()=>{
 assert.throws(()=>allocateSchedulePlans([{id:'a',balance:0},{id:'b',balance:0}],[{date:'2026-01-01',amount:10}]),/잔액/);
 assert.throws(()=>allocateSchedulePlans([{id:'a',balance:0}],[{date:'',amount:0}]),/빈 일정/);
});
test('a smaller plan creates only requested rows without an automatic remainder',()=>{
 assert.deepEqual(plain(allocateSchedulePlans([{id:'a',balance:550000}],[{date:'2026-09-01',amount:200000}])),{a:[{date:'2026-09-01',amount:200000}]});
});
test('an undetermined date can be saved without inventing a replacement date',()=>{
 assert.deepEqual(plain(allocateSchedulePlans([{id:'a',balance:200000}],[{date:'',amount:200000}])),{a:[{date:'',amount:200000}]});
});
test('replanning retains only basic date and nonnegative integer validation',()=>{
 assert.equal(isScheduleDate('2026-02-30'),false);
 assert.equal(isScheduleDate('2028-02-29'),true);
 assert.equal(isScheduleDate('',true),true);
 assert.equal(isScheduleAmount(0),true);
 assert.equal(isScheduleAmount(-1),false);
 assert.equal(isScheduleAmount(Infinity),false);
 assert.throws(()=>allocateSchedulePlans([],[]),/원본/);
 assert.throws(()=>allocateSchedulePlans([{id:'a',balance:1}],[{date:'2026-01-01',amount:1.2}]),/날짜와 금액/);
});

test('only a persisted nonempty date changed to another date adds one overdue count',()=>{
 const old={dueDate:'2026-10-16',dateChangeCount:2};
 assert.equal(scheduleDateChangeCount({id:'saved',dueDate:'2026-10-20'},old),3);
 assert.equal(scheduleDateChangeCount({id:'saved',dueDate:'2026-10-16'},old),2);
 assert.equal(scheduleDateChangeCount({id:'saved',dueDate:''},old),2);
 assert.equal(scheduleDateChangeCount({id:'saved',dueDate:'2026-10-20'},{dueDate:'',dateChangeCount:0}),0);
 assert.equal(scheduleDateChangeCount({dueDate:'2026-10-20'}),0);
 assert.equal(scheduleDateChangeCount({id:'legacy',dueDate:'2026-10-20'},{dueDate:'2026-10-16'}),1);
});
