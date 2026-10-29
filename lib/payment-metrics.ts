import type {Payment,Customer} from "@/components/store";
import {buildScheduleLedger} from "./schedule-ledger";

// Store publishes immutable arrays. WeakMap releases indexes with old snapshots.
const indexes=new WeakMap<Payment[],{parents:Set<string>;paid:Map<string,number>;credit:Map<string,number>}>();
function paymentIndex(payments:Payment[]){
 let result=indexes.get(payments);
 if(!result){
  result={parents:new Set(),paid:new Map(),credit:new Map()};
  for(const p of payments){
   if(p.rescheduledFromId)result.parents.add(p.rescheduledFromId);
   if(p.status!=="환불"&&p.scheduleType!=="환수"){
    result.paid.set(p.customerId,(result.paid.get(p.customerId)||0)+(p.paidAmount||0));
    result.credit.set(p.customerId,(result.credit.get(p.customerId)||0)+(p.allocatedAmount||0));
   }
  }
  indexes.set(payments,result);
 }
 return result;
}
export function hasRescheduledChild(payments:Payment[],id:string){return paymentIndex(payments).parents.has(id)}
export function customerPaid(payments:Payment[],customerId:string){return paymentIndex(payments).paid.get(customerId)||0}
export function isEffectivePayment(payments:Payment[],payment:Payment){return payment.promiseState?payment.promiseState==="active":!hasRescheduledChild(payments,payment.id)}
export function effectivePayments(payments:Payment[],customers?:Pick<Customer,"id"|"contractAmount"|"recoveryCredit">[]){
 const balances=customers?currentPaymentBalances(payments,customers):null;
 return payments.filter(p=>isEffectivePayment(payments,p)&&(!balances||(balances.get(p.id)||0)>0));
}
export function currentPaymentBalances(payments:Payment[],customers:Pick<Customer,"id"|"contractAmount"|"recoveryCredit">[]){
 const grouped=new Map<string,Payment[]>();
 for(const p of payments){const rows=grouped.get(p.customerId)||[];rows.push(p);grouped.set(p.customerId,rows)}
 const result=new Map<string,number>();
 for(const customer of customers){const ledger=buildScheduleLedger(grouped.get(customer.id)||[],customer.contractAmount,customer.recoveryCredit||0);for(const [id,position] of ledger.byId)result.set(id,position.remaining)}
 return result;
}
export function isRecoveryPayment(payment:Payment){return payment.scheduleType==="환수"}
export function isContractPayment(payment:Payment){return payment.scheduleType!=="환수"}
export function isSystemManagedPayment(payment:Payment){return payment.scheduleType==="환수"||payment.scheduleType==="추가계약"||!!payment.sourceRecoveryId||!!payment.sourceAdditionalContractId}
export function originalPlannedPayments(payments:Payment[]){return payments.filter(p=>p.scheduleType!=="재약정"&&p.scheduleType!=="환수")}
export function paymentRootId(payment:Payment){return payment.rootScheduleId||payment.id}
// Allocations extinguish debt but are never cash receipts.
export function paymentRemaining(payment:Pick<Payment,"dueAmount"|"paidAmount"|"allocatedAmount">){return Math.max(0,(payment.dueAmount||0)-(payment.paidAmount||0)-(payment.allocatedAmount||0))}
export function customerCredit(payments:Payment[],customerId:string,extraCredit=0){return (paymentIndex(payments).credit.get(customerId)||0)+Math.max(0,extraCredit)}
// Customer debt paid through cash or recovery allocation, not bank cash inflow.
export function customerCumulativePaid(payments:Payment[],customerId:string,extraCredit=0){return customerPaid(payments,customerId)+customerCredit(payments,customerId,extraCredit)}
export function paymentCarryAmount(payment:Pick<Payment,"dueAmount"|"paidAmount"|"allocatedAmount">,requested?:number){
 const remaining=paymentRemaining(payment),amount=requested??remaining;
 if(!Number.isSafeInteger(amount)||amount<0)throw new Error("일정 금액은 0 이상의 정수로 입력해주세요.");
 return amount;
}
export function paymentCompletionIssue(p:Pick<Payment,"status"|"paidDate"|"paidAmount">&Partial<Pick<Payment,"dueAmount"|"allocatedAmount">>){
 if(p.status!=="완료")return "";
 // Fully allocated debt has no additional cash receipt or cash receipt date.
 if(p.paidAmount===0&&(p.dueAmount||0)>0&&(p.allocatedAmount||0)>=(p.dueAmount||0))return "";
 const missing:string[]=[];
 if(!p.paidDate)missing.push("입금일");
 if(!(p.paidAmount>0))missing.push("실입금액");
 return missing.length?`${missing.join(" · ")} 누락`:"";
}
