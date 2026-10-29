import type {ScheduleLedgerRow,SchedulePosition} from "./schedule-ledger";

type CalendarStatus={done:boolean;status?:string;registeredStatus?:string};

export function isCompletedRepaymentStatus(status?:string):boolean{
 return status==="상환완료"||status==="종결"||status==="완료";
}

// An unpaid registered overdue record remains visible after its money moves to
// another promise. The calendar marker carries no money into current totals.
export function calendarOverdueHistory(row:{status?:string},position?:SchedulePosition):"rescheduled"|"unallocated"|undefined{
 if(!position||position.rawRemaining<=0||position.remaining!==0)return;
 if(row.status!=="연체"&&row.status!=="미납"&&row.status!=="부분납부 후 연체")return;
 if(position.state==="rescheduled")return "rescheduled";
 if(position.state==="active")return "unallocated";
}

type PaymentCalendarRow=Pick<ScheduleLedgerRow,"dueDate"|"dueAmount"|"paidAmount"|"paidDate"|"allocatedAmount"|"status"|"scheduleType"|"promiseState">;
export type CalendarPaymentRecord={kind:"rescheduled"|"unallocated"|"settled"|"empty"|"confirmation";rawRemaining:number};
const paymentMoney=(value:number|undefined)=>Number.isFinite(value)?Math.max(0,value||0):0;

// The current debt allocation can be zero while a registered calendar record
// still exists. These original-date markers never contribute money to totals.
export function calendarPaymentRecord(row:PaymentCalendarRow,position?:SchedulePosition):CalendarPaymentRecord|undefined{
 if(!row.dueDate||row.status==="환불"||row.scheduleType==="환수"||row.promiseState==="cancelled"||position?.state==="cancelled"||(position?.remaining||0)>0)return;
 const amount=paymentMoney(row.dueAmount),paid=paymentMoney(row.paidAmount),credit=paymentMoney(row.allocatedAmount);
 const rawRemaining=Math.max(0,amount-paid-credit);
 // The actual receipt already represents this original date in full.
 if(amount>0&&paid>=amount&&row.paidDate===row.dueDate)return;
 if(amount>0&&rawRemaining===0)return{kind:"settled",rawRemaining};
 // A registered completion alone is never evidence of a payment.
 if(row.status==="완료")return{kind:"confirmation",rawRemaining};
 if(position?.state==="rescheduled"||row.promiseState==="rescheduled")return{kind:"rescheduled",rawRemaining};
 if(rawRemaining===0&&position)return{kind:"empty",rawRemaining};
 return{kind:"unallocated",rawRemaining};
}

// Calendar colors reflect the registered state, not the passage of time.
// Keep the original state when a parent is displayed with an "이월" label.
export function calendarItemTone(item:CalendarStatus):"blue"|"orange"|"gray"{
 const status=item.registeredStatus??item.status;
 if(item.done||status==="추심")return "gray";
 return status==="연체"||status==="미납"||status==="부분납부 후 연체"?"orange":"blue";
}
