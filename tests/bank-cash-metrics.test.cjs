const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const loaded={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/bank-cash-metrics.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:loaded,exports:loaded.exports});
const {buildBankCashRows,bankCashRowsInRange,summarizeBankCash}=loaded.exports;
const row=(id,amount,paidDate='2026-10-20',patch={})=>({id,amount,paidDate,clientName:'가상 의뢰인',paymentMethod:'계좌이체',memo:'',...patch});
const refund=(id,amount,refundDate='2026-10-22',patch={})=>({id,amount,refundDate,customerId:'c',recoveryId:'r',recipientName:'가상 반환 수취인',paymentMethod:'계좌이체',memo:'실제 반환',...patch});

test('bank cash uses one canonical gross deposit and actual return rows without creating revenue allocation or shadow receipts',()=>{
 const statements=[row('ordinary',100000),row('gross',1000000,'2026-10-21',{entrySource:'payment',entryType:'환수',sourcePaymentScheduleId:'shadow'}),row('return-remainder',-100000,'2026-10-23',{entrySource:'recovery',entryType:'의뢰인 환수 반환금',sourceRecoveryId:'r',recoveryComponent:'client_return'})];
 const refunds=[refund('legacy',300000)],rows=buildBankCashRows(statements,refunds,[{id:'c',name:'가상 의뢰인'}]);
 assert.equal(rows.length,4);const totals=summarizeBankCash(rows,'2026-10-16','2026-10-31');assert.equal(totals.inflow,1100000);assert.equal(totals.outflow,400000);assert.equal(totals.net,700000);assert.equal(rows.filter(item=>item.id==='gross').length,1);
});

test('cash refunds and manual outflows can make the net balance negative without a clamp',()=>{
 const rows=buildBankCashRows([row('in',10000),row('manual-out',-40000)],[refund('refund',20000)]),totals=summarizeBankCash(rows);
 assert.equal(totals.inflow,10000);assert.equal(totals.outflow,60000);assert.equal(totals.net,-50000);
});

test('explicitly hidden statement rows and hidden or cancelled refunds stay excluded without changing their source facts',()=>{
 const statements=[row('visible',100000),row('deleted',900000,'2026-10-20',{deletedAt:'2026-10-21'}),row('user-hidden',800000,'2026-10-20',{userDeleted:true})];
 const refunds=[refund('actual',30000),refund('hidden',40000,'2026-10-22',{settlementHidden:true}),refund('cancelled',50000,'2026-10-22',{cancelledAt:'2026-10-23'})];
 const before=JSON.stringify({statements,refunds}),rows=buildBankCashRows(statements,refunds),totals=summarizeBankCash(rows);assert.deepEqual(Array.from(rows,item=>item.id),['visible','refund:actual']);assert.equal(totals.net,70000);assert.equal(JSON.stringify({statements,refunds}),before);
});

test('actual cash uses transaction dates for the 15th and 16th inclusive boundaries instead of creation or planned dates',()=>{
 const rows=buildBankCashRows([row('first-half',100000,'2026-10-15',{createdTime:'2026-10-20',dueDate:'2026-10-16'}),row('second-half-out',-150000,'2026-10-16'),row('prior',200000,'2026-09-30'),row('next',300000,'2026-11-01')],[]);
 assert.equal(summarizeBankCash(rows,'2026-10-01','2026-10-15').net,100000);assert.equal(summarizeBankCash(rows,'2026-10-16','2026-10-31').net,-150000);assert.equal(summarizeBankCash(rows,'2026-10-01','2026-10-31').net,-50000);
});

test('same-day same-amount manual transactions remain separate genuine bank records',()=>{
 const rows=buildBankCashRows([row('manual-one',50000),row('manual-two',50000)],[]);assert.equal(rows.length,2);assert.equal(summarizeBankCash(rows).net,100000);
});

test('refund display metadata matches the statement and CSV including recipient quotes and fallback customer name',()=>{
 const rows=buildBankCashRows([],[refund('f',10000,'2026-10-23',{recipientName:'가상 "수취인"',memo:'입금 대조'})]);assert.equal(rows[0].clientName,'-');assert.equal(rows[0].id,'refund:f');assert.equal(rows[0].amount,-10000);assert.equal(rows[0].memo,'환수금 고객 반환 [수취인:가상 "수취인"] · 입금 대조');assert.equal(rows[0].entryType,'반환');
});

test('undated facts are never assigned an artificial date for an open or closed date range',()=>{
 const rows=[row('missing-date',100000,'')];for(const [start,end] of [['2026-10-01','2026-10-31'],['','2026-10-31'],['2026-10-01','']])assert.equal(bankCashRowsInRange(rows,start,end).length,0);
});

test('unsigned customers and unlinked manual entries use the same unfiltered cash population as the law-firm statement',()=>{
 const rows=buildBankCashRows([row('signed',100000,'2026-10-20',{customerId:'signed'}),row('unsigned',200000,'2026-10-20',{customerId:'unsigned'}),row('unlinked',-50000)],[]);assert.equal(rows.length,3);assert.equal(summarizeBankCash(rows).net,250000);
});
