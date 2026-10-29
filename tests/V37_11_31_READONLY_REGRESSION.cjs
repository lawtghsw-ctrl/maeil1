// Read-only invariants/static regression assertions. No database calls.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path');
const root=path.join(__dirname,'..');
const ui=fs.readFileSync(path.join(root,'app/(admin)/[section]/page.tsx'),'utf8');
const dash=fs.readFileSync(path.join(root,'app/(admin)/page.tsx'),'utf8');
const sql=fs.readFileSync(path.join(root,'tests/fixtures/dowon-reference/V37_11_31_OVERDUE_REPLAN_BALANCE_SAFE.sql'),'utf8');
const allocate=(amount,paid,plans)=>{const rest=amount-paid,applied=plans.reduce((s,p)=>s+p,0);if(rest<0||applied<=0||applied>rest)throw Error('over-allocated or invalid');return {paid,applied,overdue:rest-applied,conserved:paid+applied+rest-applied}};
test('37.5만 예정 / 35만 입금 / 2.5만 재약정: 총액 보존',()=>{const v=allocate(375000,350000,[25000]);assert.equal(v.conserved,375000);assert.equal(v.overdue,0);});
test('일부만 재조율하면 남은 10만은 연체로 보존',()=>{const v=allocate(400000,0,[150000,150000]);assert.equal(v.overdue,100000);assert.equal(v.conserved,400000);});
test('기납부가 있는 상환도 미배정 잔액 보존',()=>{const v=allocate(375000,350000,[10000]);assert.equal(v.overdue,15000);assert.equal(v.conserved,375000);});
test('잔액 초과 재조율은 거부',()=>assert.throws(()=>allocate(375000,350000,[30000])));
test('두 RPC 원자 함수가 있고 기존 거래 INSERT는 추가하지 않음',()=>{assert.match(sql,/dowon_save_payment_batch/);assert.match(sql,/dowon_save_repayment_batch/);assert.equal((sql.match(/pg_advisory_xact_lock/g)||[]).length,2);assert.equal((sql.match(/'재조율 미배정 잔액 · 재약정 가능'/g)||[]).length,2);assert.doesNotMatch(sql,/INSERT INTO public\.settlement_entries/i);});
test('일정 편집은 재조율 생성 없이 직접 날짜와 금액을 수정',()=>{assert.doesNotMatch(ui,/allocateSchedulePlans|applyUnifiedPlan|applyBatch|startCarry/);assert.match(ui,/scheduleDateChangeCount/);assert.match(ui,/saveCustomerPaymentsAtomic\(customer.id,rows,\{\}/);assert.match(ui,/saveCustomerRepaymentsAtomic\(customer.id,rows,\{\}/);});
test('캘린더 실제 지급일에 완료 표시를 생성하며 입금 원본은 한 번만 참조',()=>{assert.match(dash,/date:p\.paidDate/);assert.match(dash,/status:"완료",amount:p\.paidAmount/);assert.match(dash,/date:r\.paidDate!/);assert.match(dash,/status:"완료",amount:Number\(r\.paidAmount/);});
