import type {AdditionalContract,Customer,Payment,Recovery,RecoveryAllocation,RecoveryRefund,Settlement} from "@/components/store";

export type SettlementCancellationKind="manual"|"payment"|"recovery"|"additional"|"recovery_return"|"refund";
export type SettlementCancellationExpected={kind:SettlementCancellationKind;settlement:Record<string,unknown>;source:Record<string,unknown>|null;payment:Record<string,unknown>|null;recovery?:Record<string,unknown>};
export type SettlementCancellationSnapshot={row:Settlement;requestKey:string;expected:SettlementCancellationExpected|null;label:string;description:string;guidance:string;customerId:string;manage:"payment"|"recovery"|"additional"|"customers"};
type Sources={customers:Customer[];payments:Payment[];recoveries:Recovery[];additionalContracts:AdditionalContract[];recoveryRefunds:RecoveryRefund[];recoveryAllocations:RecoveryAllocation[]};
const nullable=(value:string|undefined)=>value||null;
const won=(amount:number)=>`₩${Math.abs(amount).toLocaleString("ko-KR")}`;
export function settlementSnapshot(row:Settlement){
 return {id:row.id,amount:row.amount,payment_date:nullable(row.paidDate),client_name:row.clientName,payment_method:row.paymentMethod,memo:row.memo,
  entry_source:row.entrySource||"manual",entry_type:row.entryType||"계약",customer_id:nullable(row.customerId),source_payment_schedule_id:nullable(row.sourcePaymentScheduleId),source_recovery_id:nullable(row.sourceRecoveryId),recovery_component:nullable(row.recoveryComponent)};
}
export function paymentSnapshot(row:Payment){
 return {id:row.id,customer_id:row.customerId,row_version:row.rowVersion||1,paid_amount:row.paidAmount,paid_date:nullable(row.paidDate),expected_amount:row.dueAmount,due_date:nullable(row.dueDate),status:row.status,
  promise_state:row.promiseState||null,schedule_type:row.scheduleType||"일반",source_recovery_id:nullable(row.sourceRecoveryId),source_additional_contract_id:nullable(row.sourceAdditionalContractId),memo:row.memo,payment_method:row.paymentMethod||"계좌이체"};
}
function recoverySnapshot(row:Recovery){
 return {id:row.id,customer_id:row.customerId,row_version:row.rowVersion||1,accounting_version:row.accountingVersion||1,recovery_date:nullable(row.recoveryDate),lender_name:row.lenderName,depositor_name:row.depositorName||"",amount:row.amount,payment_method:row.paymentMethod,memo:row.memo,installment_amount:row.installmentAmount||0,client_return_amount:row.clientReturnAmount||0,success_fee_amount:row.successFeeAmount||0};
}
function additionalSnapshot(row:AdditionalContract){
 return {id:row.id,customer_id:row.customerId,contract_date:nullable(row.contractDate),contract_amount:row.contractAmount,upfront_amount:row.prepaidAmount,installment_period:row.installmentMonths,lender_unit_price:row.lenderUnitPrice,lender_count:row.lenderCount,is_renegotiation:row.isRenegotiation,memo:row.memo};
}

/** Capture primitives once at confirmation time; realtime must not change a retry. */
export function createSettlementCancellation(row:Settlement,sources:Sources,requestKey:string):SettlementCancellationSnapshot{
 const directPayment=sources.payments.find(item=>item.id===row.sourcePaymentScheduleId);
 const customerId=row.customerId||directPayment?.customerId||"";
 const recoveryId=row.sourceRecoveryId||directPayment?.sourceRecoveryId;
 const recovery=sources.recoveries.find(item=>item.id===recoveryId);
 const payment=directPayment||(recovery?sources.payments.find(item=>item.sourceRecoveryId===recovery.id):undefined);
 const additional=sources.additionalContracts.find(item=>item.id===payment?.sourceAdditionalContractId);
 const snapshot:SettlementCancellationSnapshot={row:{...row},requestKey,expected:null,label:"실제 거래 취소",description:"",guidance:"원본 거래 연결을 확인하지 못했습니다. 고객 관리에서 실제 입금·환수 원본을 확인해주세요.",customerId,manage:recoveryId||row.entrySource==="refund"?"recovery":additional||payment?.scheduleType==="추가계약"?"additional":payment?"payment":"customers"};
 const base=settlementSnapshot(row);
 if(row.entrySource==="refund"){
  const refundId=row.id.startsWith("refund:")?row.id.slice("refund:".length):"";
  const refund=sources.recoveryRefunds.find(item=>item.id===refundId);
  const parent=sources.recoveries.find(item=>item.id===refund?.recoveryId);
  snapshot.label="의뢰인 반환 출금 취소";snapshot.customerId=refund?.customerId||customerId;
  if(!refund||!parent||parent.customerId!==refund.customerId||row.customerId!==refund.customerId||refund.settlementHidden||row.amount!==-refund.amount||row.paidDate!==refund.refundDate||!(refund.amount>0)||row.sourcePaymentScheduleId||row.sourceRecoveryId||row.recoveryComponent){
   snapshot.guidance="반환 원본과 정산표의 연결·금액·날짜를 확인하지 못했습니다. 새로고침 후 환수 관리에서 실제 반환 내역을 확인해주세요.";return snapshot;
  }
  if((parent.accountingVersion||1)!==1){
   snapshot.guidance="신형 환수와 연결된 별도 반환 기록은 이 화면에서 취소할 수 없습니다. 환수 관리에서 반환 내역을 확인해주세요.";return snapshot;
  }
  snapshot.expected={kind:"refund",settlement:base,payment:null,source:{id:refund.id,recovery_id:refund.recoveryId,customer_id:refund.customerId,refund_date:nullable(refund.refundDate),amount:refund.amount,recipient_name:refund.recipientName||"",payment_method:refund.paymentMethod||"계좌이체",memo:refund.memo||"",settlement_hidden:!!refund.settlementHidden},recovery:recoverySnapshot(parent)};
  snapshot.label=`의뢰인 반환 출금 ${won(refund.amount)} 취소`;
  snapshot.description=`환수 원본: ${parent.lenderName||"업체 미입력"} · 총환수 ${won(parent.amount)}\n반환 수취인: ${refund.recipientName||"미입력"} · 실제 반환일: ${refund.refundDate||"미입력"}\n실제 반환 출금 ${won(refund.amount)}만 취소합니다. 업체 환수 총입금·성공보수·분납 충당액·계약원금은 유지하고 반환 잔액과 정산표·CSV 출금 합계를 다시 계산합니다. 원래 반환 기록은 취소 이력으로 보존됩니다.`;
  snapshot.guidance="";return snapshot;
 }
 if((!row.entrySource||row.entrySource==="manual")&&(row.sourcePaymentScheduleId||row.sourceRecoveryId||row.recoveryComponent)){
  snapshot.guidance="수기 정산에 원본 연결 정보가 함께 있어 거래 종류를 확정하지 못했습니다. 원본 관리에서 실제 입금·환수 내역을 확인해주세요.";return snapshot;
 }
 if((!row.entrySource||row.entrySource==="manual")&&!row.sourcePaymentScheduleId&&!row.sourceRecoveryId&&!row.recoveryComponent){
  snapshot.expected={kind:"manual",settlement:base,source:null,payment:null};snapshot.label=`수기 ${row.amount<0?"출금":"입금"} ${won(row.amount)} 취소`;
  snapshot.description=`수기로 등록한 ${row.amount<0?"출금":"입금"} ${won(row.amount)}을 취소하고 정산표·CSV의 입출금 합계를 다시 계산합니다. 연결된 고객 입금 원본이 없는 수기 거래이므로 고객 납부액·계약원금·환수 충당액은 변경되지 않습니다.`;snapshot.guidance="";return snapshot;
 }
 if(row.entrySource==="payment"&&payment&&(!payment.paidDate||row.paidDate!==payment.paidDate||row.amount!==payment.paidAmount||payment.sourceRecoveryId&&payment.sourceAdditionalContractId)){
  snapshot.guidance="정산표와 원본 입금의 금액·날짜·연결 정보가 일치하지 않습니다. 새로고침 후 원본 관리에서 확인해주세요.";return snapshot;
 }
 if(recovery){
  snapshot.manage="recovery";snapshot.customerId=recovery.customerId;
  snapshot.label=row.recoveryComponent==="client_return"?"의뢰인 반환 출금 취소":`업체 환수 입금 ${won(recovery.amount)} 취소`;
  if(row.recoveryComponent==="client_return"&&row.amount<0&&row.entrySource==="recovery"){
   snapshot.expected={kind:"recovery_return",settlement:base,source:recoverySnapshot(recovery),payment:null};
   snapshot.description=`의뢰인 반환 출금 ${won(row.amount)}만 취소합니다. 업체 환수 입금 ${won(recovery.amount)}과 성공보수·계약 분납 충당액은 유지하고 반환금과 정산표·CSV 출금 합계를 다시 계산합니다.`;snapshot.guidance="";return snapshot;
  }
  const gross=row.entrySource==="payment"&&row.entryType==="환수"&&row.amount===recovery.amount&&row.amount>0;
  if(gross&&((recovery.clientReturnAmount||0)>0||sources.recoveryRefunds.some(item=>item.recoveryId===recovery.id))){
   snapshot.guidance="환수에 연결된 의뢰인 반환 출금이 있습니다. 환수 관리에서 반환 내역을 먼저 확인해주세요. 이 화면에서 반환 출금을 함께 삭제하지 않습니다.";return snapshot;
  }
  if(gross&&payment&&payment.sourceRecoveryId===recovery.id&&payment.paidAmount===row.amount){
   const credit=(recovery.accountingVersion||1)>=2?(recovery.installmentAmount||0):sources.recoveryAllocations.filter(item=>item.recoveryId===recovery.id).reduce((sum,item)=>sum+item.amount,0);
   snapshot.expected={kind:"recovery",settlement:base,source:recoverySnapshot(recovery),payment:paymentSnapshot(payment)};
   snapshot.description=`업체 환수 원본 입금 ${won(recovery.amount)}을 취소합니다. 환수 성공보수 ${won(Math.floor(recovery.amount/2))}와 분납 충당 ${won(credit)}도 함께 취소되어 실매출·환수·고객 미수금 및 정산표·CSV가 다시 계산됩니다. 계약원금은 유지됩니다. 연결된 반환·배분 내역 때문에 취소할 수 없으면 환수 관리에서 확인해야 합니다.`;snapshot.guidance="";return snapshot;
  }
  snapshot.guidance="환수 관리에서 원본 입금과 연결된 반환·배분 내역을 확인해주세요.";
  return snapshot;
 }
 if(additional&&payment){
  snapshot.manage="additional";snapshot.customerId=additional.customerId;snapshot.label=`추가계약 선납 입금 ${won(payment.paidAmount)} 취소`;
  if(row.entrySource==="payment"&&row.amount>0&&payment.paidAmount===row.amount&&additional.prepaidAmount===row.amount){
   snapshot.expected={kind:"additional",settlement:base,source:additionalSnapshot(additional),payment:paymentSnapshot(payment)};
   snapshot.description=`추가계약 선납 입금 ${won(payment.paidAmount)}을 취소하고 선납금을 0원으로 변경합니다. 추가계약 원금 ${won(additional.contractAmount)}은 유지하며 고객 납부액·미수금·실매출과 연결된 정산표·CSV를 다시 계산합니다.`;snapshot.guidance="";return snapshot;
  }
  snapshot.guidance="추가계약 관리에서 선납금 원본을 확인해주세요.";return snapshot;
 }
 if(payment){
  snapshot.manage="payment";snapshot.customerId=payment.customerId;snapshot.label=`실제 입금 ${won(payment.paidAmount)} 취소`;
  if(row.entrySource==="payment"&&row.amount>0&&payment.paidAmount===row.amount&&payment.status!=="환불"&&payment.scheduleType!=="환수"&&payment.scheduleType!=="추가계약"&&!payment.sourceRecoveryId&&!payment.sourceAdditionalContractId){
   snapshot.expected={kind:"payment",settlement:base,source:null,payment:paymentSnapshot(payment)};
   snapshot.description=`실제 입금 ${won(payment.paidAmount)}과 해당 납부 약속을 취소합니다. 납부액·미수금·실매출과 연결된 정산표·CSV가 다시 계산됩니다. 계약원금${(payment.allocatedAmount||0)>0?`과 환수 분납 충당 ${won(payment.allocatedAmount||0)}`:""}은 유지됩니다.`;snapshot.guidance="";return snapshot;
  }
  snapshot.guidance="입금/분납 관리에서 원본 입금 기록을 확인해주세요.";return snapshot;
 }
 return snapshot;
}
