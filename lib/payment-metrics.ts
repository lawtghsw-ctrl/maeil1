import type {Payment} from "@/components/store";

export function hasRescheduledChild(payments:Payment[],id:string){return payments.some(p=>p.rescheduledFromId===id)}
export function isEffectivePayment(payments:Payment[],payment:Payment){return !hasRescheduledChild(payments,payment.id)}
export function effectivePayments(payments:Payment[]){return payments.filter(p=>isEffectivePayment(payments,p))}
export function isRecoveryPayment(payment:Payment){return payment.scheduleType==="환수"}
export function isContractPayment(payment:Payment){return payment.scheduleType!=="환수"}
export function isSystemManagedPayment(payment:Payment){return !!payment.sourceRecoveryId||payment.scheduleType==="추가계약"||!!payment.sourceAdditionalContractId}
export function originalPlannedPayments(payments:Payment[]){return payments.filter(p=>p.scheduleType!=="재약정"&&p.scheduleType!=="환수")}
export function paymentRootId(payment:Payment){return payment.rootScheduleId||payment.id}
export function paymentRemaining(payment:Payment){return Math.max(0,(payment.dueAmount||0)-(payment.paidAmount||0))}
