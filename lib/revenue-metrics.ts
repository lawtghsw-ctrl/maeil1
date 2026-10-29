import type {Payment,Recovery,RecoveryAllocation} from "@/components/store";

/** Revenue allocation and bank receipts share their source, but not their totals. */
export type RevenueEvent={
 id:string;customerId:string;date:string;source:"payment"|"recovery";
 contractCash:number;recoveryGross:number;recoveryInstallment:number;recoverySuccessFee:number;
};
export type RevenueTotals={contractCash:number;recoveryGross:number;recoveryInstallment:number;recoverySuccessFee:number;realSales:number;cashInflow:number};
const positive=(value:number|undefined)=>Number.isFinite(value)?Math.max(0,value||0):0;

export function buildRevenueEvents(payments:Payment[],recoveries:Recovery[],allocations:RecoveryAllocation[]=[]):RevenueEvent[]{
 const events:RevenueEvent[]=[];
 const allocated=new Map<string,number>();
 for(const row of allocations)allocated.set(row.recoveryId,(allocated.get(row.recoveryId)||0)+positive(row.amount));
 for(const payment of payments){
  // Recovery shadow payments represent the same bank receipt as their source.
  // A cancelled promise can still contain a genuine receipt, so retain its cash.
  if(payment.status==="환불"||payment.scheduleType==="환수"||payment.sourceRecoveryId||!(positive(payment.paidAmount)>0))continue;
  events.push({id:payment.id,customerId:payment.customerId,date:payment.paidDate,source:"payment",
   contractCash:positive(payment.paidAmount),recoveryGross:0,recoveryInstallment:0,recoverySuccessFee:0});
 }
 for(const recovery of recoveries){
  const gross=positive(recovery.amount),date=recovery.recoveryDate||"";
  if(gross===0)continue;
  // The active allocation view contains legacy credits only; v2 has one explicit
  // installment amount. Never add the legacy and v2 representations together.
  const installment=(recovery.accountingVersion||1)>=2?positive(recovery.installmentAmount):(allocated.get(recovery.id)||0);
  events.push({id:recovery.id,customerId:recovery.customerId,date,source:"recovery",contractCash:0,
   recoveryGross:gross,recoveryInstallment:installment,recoverySuccessFee:Math.floor(gross/2)});
 }
 return events;
}

export function summarizeRevenue(events:RevenueEvent[],start="",end="",customerIds?:ReadonlySet<string>):RevenueTotals{
 const result:RevenueTotals={contractCash:0,recoveryGross:0,recoveryInstallment:0,recoverySuccessFee:0,realSales:0,cashInflow:0};
 for(const event of events){
  if((start||end)&&!event.date||start&&event.date<start||end&&event.date>end||customerIds&&!customerIds.has(event.customerId))continue;
  result.contractCash+=event.contractCash;result.recoveryGross+=event.recoveryGross;
  result.recoveryInstallment+=event.recoveryInstallment;result.recoverySuccessFee+=event.recoverySuccessFee;
 }
 result.realSales=result.contractCash+result.recoveryInstallment;
 result.cashInflow=result.contractCash+result.recoveryGross;
 return result;
}
