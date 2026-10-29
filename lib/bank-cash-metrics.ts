import type {Customer,RecoveryRefund,Settlement} from "@/components/store";

type ActiveStatement=Settlement&{deletedAt?:string|null;userDeleted?:boolean};
type ActiveRefund=RecoveryRefund&{cancelledAt?:string|null};
export type BankCashTotals={inflow:number;outflow:number;net:number};

/** Use the statement's bank transactions, never schedules or revenue allocations. */
export function buildBankCashRows(settlements:readonly ActiveStatement[],refunds:readonly ActiveRefund[],customers:readonly Pick<Customer,"id"|"name">[]=[]):Settlement[]{
 const names=new Map(customers.map(customer=>[customer.id,customer.name]));
 const rows:Settlement[]=settlements.filter(row=>!row.deletedAt&&!row.userDeleted);
 for(const refund of refunds){
  if(refund.settlementHidden||refund.cancelledAt)continue;
  rows.push({id:"refund:"+refund.id,paidDate:refund.refundDate,clientName:names.get(refund.customerId)||"-",amount:-refund.amount,
   paymentMethod:refund.paymentMethod,memo:`환수금 고객 반환 [수취인:${refund.recipientName}]${refund.memo?` · ${refund.memo}`:""}`,
   customerId:refund.customerId,entrySource:"refund",entryType:"반환"});
 }
 return rows;
}

export function bankCashRowsInRange(rows:readonly Settlement[],start="",end=""):Settlement[]{
 return rows.filter(row=>!((start||end)&&!row.paidDate)&&(!start||row.paidDate>=start)&&(!end||row.paidDate<=end));
}

export function summarizeBankCash(rows:readonly Settlement[],start="",end=""):BankCashTotals{
 const totals:BankCashTotals={inflow:0,outflow:0,net:0};
 for(const row of bankCashRowsInRange(rows,start,end)){
  if(row.amount>0)totals.inflow+=row.amount;
  else if(row.amount<0)totals.outflow-=row.amount;
  totals.net+=row.amount;
 }
 return totals;
}
