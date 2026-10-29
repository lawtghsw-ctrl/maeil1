"use client";
import {useMemo} from "react";
import type {Customer} from "@/components/store";
import {Button,Card} from "@/components/ui";
import type {ScheduleLedger} from "@/lib/schedule-ledger";
import {isEformSignedStatus,won} from "@/lib/utils";

export function overplannedPaymentCustomers(customers:Customer[],ledgers:Map<string,ScheduleLedger>){
 return customers.flatMap(customer=>{
  const ledger=ledgers.get(customer.id);
  if(customer.isAccident||!isEformSignedStatus(customer.eformsignStatus)||!ledger||ledger.totals.overplanned<=0)return [];
  const promised=[...ledger.byId.values()].filter(row=>row.state==="active").reduce((sum,row)=>sum+row.remaining,0);
  return [{customer,receivable:ledger.totals.remaining,promised,excess:ledger.totals.overplanned}];
 }).sort((a,b)=>b.excess-a.excess||a.customer.name.localeCompare(b.customer.name,"ko")||a.customer.id.localeCompare(b.customer.id));
}

export function PaymentOverplanned({customers,ledgers,onManage}:{customers:Customer[];ledgers:Map<string,ScheduleLedger>;onManage:(customer:Customer)=>void}){
 const rows=useMemo(()=>overplannedPaymentCustomers(customers,ledgers),[customers,ledgers]);
 if(!rows.length)return null;
 const total=rows.reduce((sum,row)=>sum+row.excess,0);
 return <Card className="mb-4 overflow-hidden border-orange-300">
  <div className="flex flex-wrap items-center justify-between gap-3 bg-orange-50 px-5 py-4">
   <div><div className="font-bold text-orange-800">예정 금액 초과 의뢰인 <span className="ml-2">{rows.length}명</span></div><p className="mt-1 text-xs leading-5 text-orange-700">현재 미수금보다 납부 약속 합계가 많은 의뢰인입니다. 이전 약속과 취소된 일정은 제외합니다.</p></div>
   <div className="text-sm font-bold text-orange-800">총 초과 금액 {won(total)}</div>
  </div>
  <div className="overflow-x-auto"><table className="admin-responsive-table w-full min-w-[1100px] text-sm">
   <thead className="bg-orange-50/40 text-left text-xs text-slate-500"><tr>{["고객명","연락처","영업 담당자","조율 담당자","현재 미수금","현재 약속 합계","초과 금액",""].map(label=><th key={label} className="px-4 py-3">{label}</th>)}</tr></thead>
   <tbody>{rows.map(({customer,receivable,promised,excess})=><tr key={customer.id} className="border-t border-orange-100">
    <td className="px-4 py-3 font-semibold">{customer.name}</td><td className="px-4 py-3">{customer.phone||"-"}</td><td className="px-4 py-3">{customer.manager||"-"}</td><td className="px-4 py-3">{customer.coordinationManager||"-"}</td>
    <td className="px-4 py-3 font-semibold">{won(receivable)}</td><td className="px-4 py-3 font-semibold">{won(promised)}</td><td className="px-4 py-3 font-bold text-red-600">{won(excess)}</td>
    <td className="px-4 py-3 text-right"><Button onClick={()=>onManage(customer)}>일정 수정</Button></td>
   </tr>)}</tbody>
  </table></div>
 </Card>;
}
