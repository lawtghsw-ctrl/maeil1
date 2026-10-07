"use client";
import {useMemo,useState} from "react";
import {CalendarDays,CircleDollarSign,Users,WalletCards} from "lucide-react";
import {Card,PageHeader} from "@/components/ui";
import {DateRangePicker} from "@/components/date-range-picker";
import {useAdminStore} from "@/components/store";
import {duplicateCustomerTag,inRange,isEformSignedStatus,won} from "@/lib/utils";
import {hasRescheduledChild} from "@/lib/payment-metrics";
function today(){return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}
function monthRange(){const t=today();const [y,m]=t.split("-").map(Number);return{start:`${y}-${String(m).padStart(2,"0")}-01`,end:`${y}-${String(m).padStart(2,"0")}-${String(new Date(y,m,0).getDate()).padStart(2,"0")}`}}
function shiftMonth(month:string,delta:number){const [y,m]=month.split("-").map(Number);const d=new Date(y,m-1+delta,1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`}
const REPAYMENT_PROBLEM_MEMO="상환에 문제 있음";
function hasRepaymentProblem(memo:string){return String(memo||"").split(/\r?\n/).some(line=>line.trim()===REPAYMENT_PROBLEM_MEMO)}
function setRepaymentProblemMemo(memo:string,checked:boolean){const lines=String(memo||"").split(/\r?\n/).filter(line=>line.trim()!==REPAYMENT_PROBLEM_MEMO);if(checked)lines.push(REPAYMENT_PROBLEM_MEMO);return lines.join("\n").trim()}
type CalendarItem={id:string;date:string;label:string;sub:string;done:boolean;status?:string;amount:number;duplicateTag?:string;problem?:boolean};
function MonthCalendar({title,month,onMonthChange,items,tone,summary,onProblemChange}:{title:string;month:string;onMonthChange:(month:string)=>void;items:CalendarItem[];tone:"blue"|"amber";summary?:{paid:number;expected:number;total:number};onProblemChange?:(id:string,checked:boolean)=>void}){
 const [yy,mm]=month.split("-").map(Number);
 const daysInMonth=new Date(yy,mm,0).getDate();
 const firstDay=new Date(yy,mm-1,1).getDay();
 const days=[...Array(firstDay).fill(""),...Array.from({length:daysInMonth},(_,i)=>`${month}-${String(i+1).padStart(2,"0")}`)];
 type DayPreview={date:string;rows:CalendarItem[];top:number;left:number};
 const [hovered,setHovered]=useState<DayPreview|null>(null);
 const [pinned,setPinned]=useState<DayPreview|null>(null);

 function previewPosition(e:React.MouseEvent<HTMLDivElement>,date:string,rows:CalendarItem[]){
  const rect=e.currentTarget.getBoundingClientRect();
  const popupWidth=280;
  const popupHeight=258;
  const gap=8;
  let left=rect.right+gap;
  if(left+popupWidth>window.innerWidth-10)left=Math.max(10,rect.left-popupWidth-gap);
  let top=rect.top;
  if(top+popupHeight>window.innerHeight-10)top=Math.max(10,window.innerHeight-popupHeight-10);
  return{date,rows,top,left};
 }
 function showDay(e:React.MouseEvent<HTMLDivElement>,date:string,rows:CalendarItem[]){
  if(pinned||!rows.length)return;
  setHovered(previewPosition(e,date,rows));
 }
 function pinDay(e:React.MouseEvent<HTMLDivElement>,date:string,rows:CalendarItem[]){
  if(!rows.length)return;
  e.stopPropagation();
  setHovered(null);
  setPinned(previewPosition(e,date,rows));
 }
 function toggleProblem(id:string,checked:boolean){
  setPinned(prev=>prev?{...prev,rows:prev.rows.map(row=>row.id===id?{...row,problem:checked}:row)}:prev);
  onProblemChange?.(id,checked);
 }
 const active=pinned||hovered;

 return <>
  <Card className="overflow-hidden">
   <div className="border-b border-slate-100 px-5 py-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
     <div><h3 className="text-base font-bold">{title}</h3><p className="mt-1 text-xs text-slate-500">{month} 일정</p></div>
     <div className="flex flex-wrap items-center gap-2">
      <select value={yy} onChange={e=>onMonthChange(`${e.target.value}-${String(mm).padStart(2,"0")}`)} className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs">{Array.from({length:11},(_,i)=>yy-5+i).map(y=><option key={y} value={y}>{y}년</option>)}</select>
      <select value={mm} onChange={e=>onMonthChange(`${yy}-${String(Number(e.target.value)).padStart(2,"0")}`)} className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs">{Array.from({length:12},(_,i)=>i+1).map(m=><option key={m} value={m}>{m}월</option>)}</select>
      <button type="button" onClick={()=>onMonthChange(shiftMonth(month,-1))} className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">이전달</button>
      <button type="button" onClick={()=>onMonthChange(today().slice(0,7))} className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">이번달</button>
      <button type="button" onClick={()=>onMonthChange(shiftMonth(month,1))} className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">다음달</button>
      <label className="relative grid h-8 w-9 cursor-pointer place-items-center overflow-hidden rounded-lg border border-slate-200 bg-white hover:bg-slate-50" title="년·월 선택">
       <CalendarDays size={17} className={tone==="blue"?"text-blue-600":"text-amber-600"}/>
       <input type="month" value={month} onChange={e=>e.target.value&&onMonthChange(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label={`${title} 년·월 선택`}/>
      </label>
     </div>
    </div>
    {summary&&<div className="mt-4 grid gap-2 sm:grid-cols-3"><div className="rounded-xl border border-emerald-100 bg-emerald-50/70 px-4 py-3"><div className="text-[11px] font-semibold text-emerald-700">해당 달 총 입금액</div><div className="mt-1 text-lg font-bold text-emerald-900">{won(summary.paid)}</div><div className="mt-0.5 text-[10px] text-emerald-700/80">선납 + 분납 실입금</div></div><div className="rounded-xl border border-blue-100 bg-blue-50/70 px-4 py-3"><div className="text-[11px] font-semibold text-blue-700">받을 예정 금액</div><div className="mt-1 text-lg font-bold text-blue-900">{won(summary.expected)}</div><div className="mt-0.5 text-[10px] text-blue-700/80">아직 받지 못한 분납 예정액</div></div><div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"><div className="text-[11px] font-semibold text-slate-600">합산 금액</div><div className="mt-1 text-lg font-bold text-slate-900">{won(summary.total)}</div><div className="mt-0.5 text-[10px] text-slate-500">총 입금액 + 받을 예정 금액</div></div></div>}
   </div>
   <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50">{["일","월","화","수","목","금","토"].map(x=><div key={x} className="p-2 text-center text-xs font-semibold text-slate-500">{x}</div>)}</div>
   <div className="grid grid-cols-7">
    {days.map((d,i)=>{
     const rows=d?items.filter(x=>x.date===d):[];
     return <div key={`${d}-${i}`}
      onMouseEnter={e=>d&&showDay(e,d,rows)}
      onMouseLeave={()=>{if(!pinned)setHovered(null)}}
      onClick={e=>d&&pinDay(e,d,rows)}
      className={`min-h-[96px] border-b border-r border-slate-100 p-1.5 sm:min-h-[112px] sm:p-2 ${rows.length?"cursor-pointer hover:bg-slate-50/80":""}`}>
      {d&&<><div className="text-xs font-bold text-slate-600">{Number(d.slice(-2))}</div><div className="mt-1.5 space-y-1.5">{rows.slice(0,3).map(x=>{
       const rowClass=x.status==="추심"?"bg-slate-200 text-slate-500":x.done?"bg-slate-200 text-slate-500 opacity-75":tone==="blue"?"bg-blue-50 text-blue-800":"bg-amber-50 text-amber-800";
       return <div key={x.id} className={`rounded-md px-1.5 py-1 text-[10px] font-medium sm:text-[11px] ${rowClass}`}><div className="flex min-w-0 items-center gap-1"><span className={`min-w-0 truncate ${x.status==="추심"||x.problem?"font-bold text-red-600":""}`}>{x.label}</span>{x.duplicateTag&&<span className="shrink-0 rounded bg-white/80 px-1 py-0.5 text-[8px] font-bold text-slate-600 ring-1 ring-inset ring-slate-200">{x.duplicateTag}</span>}</div><div className="truncate opacity-90">{x.sub}</div></div>
      })}{rows.length>3&&<div className="px-1 text-[10px] font-semibold text-slate-500">+{rows.length-3}건</div>}</div></>}
     </div>
    })}
   </div>
  </Card>

  {pinned&&<div className="fixed inset-0 z-[90]" onClick={()=>setPinned(null)} aria-hidden="true"/>}

  {active&&<div
   className={`fixed z-[100] w-[280px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl ${pinned?"pointer-events-auto":"pointer-events-none"}`}
   style={{top:active.top,left:active.left}}
   onClick={e=>e.stopPropagation()}>
   <div className="border-b border-slate-100 bg-slate-50 px-3 py-2.5">
    <div className="flex items-center justify-between gap-2">
     <div className="shrink-0 text-[13px] font-bold text-slate-900">{Number(active.date.slice(5,7))}월 {Number(active.date.slice(-2))}일 일정</div>
     <div className={`min-w-0 flex-1 truncate text-center text-[10px] font-bold ${tone==="blue"?"text-blue-700":"text-amber-700"}`}>{tone==="blue"?"분납 총합":"상환 총합"} {won(active.rows.reduce((sum,row)=>sum+(row.amount||0),0))}</div>
     <div className="flex shrink-0 items-center gap-1.5">
      <div className="rounded-full bg-white px-2 py-0.5 text-[9px] font-bold text-slate-500 ring-1 ring-slate-200">{active.rows.length}건</div>
      {pinned&&<div className="text-[9px] font-semibold text-blue-600">고정됨</div>}
     </div>
    </div>
    <div className="mt-0.5 text-[10px] text-slate-500">{title}{!pinned&&" · 클릭하면 고정"}</div>
   </div>
   <div className="max-h-[174px] space-y-1.5 overflow-y-auto p-2">
    {active.rows.map(x=>{
     const rowClass=x.status==="추심"?"border-slate-300 bg-slate-100 text-slate-500":x.done?"border-slate-200 bg-slate-100 text-slate-500":tone==="blue"?"border-blue-100 bg-blue-50 text-blue-900":"border-amber-100 bg-amber-50 text-amber-900";
     return <div key={x.id} className={`rounded-lg border px-2.5 py-2 ${rowClass}`}>
      <div className="flex items-start justify-between gap-2">
       <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1"><div className={`min-w-0 break-words text-[12px] font-bold leading-4 ${x.status==="추심"||x.problem?"text-red-600":""}`}>{x.label}</div>{x.duplicateTag&&<span className="shrink-0 rounded-md bg-white px-1.5 py-0.5 text-[8px] font-bold text-slate-600 ring-1 ring-inset ring-slate-200">{x.duplicateTag}</span>}{tone==="amber"&&pinned&&!x.done&&x.status!=="추심"&&<input type="checkbox" checked={!!x.problem} onClick={e=>e.stopPropagation()} onChange={e=>toggleProblem(x.id,e.target.checked)} className="ml-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-red-600" aria-label="상환 문제 표시" title="상환 문제 표시"/>}</div>
       {x.status&&<span className={`shrink-0 rounded-full bg-white/80 px-1.5 py-0.5 text-[8px] font-bold ${x.done?"text-slate-500":x.status==="연체"||x.status==="미납"||x.status==="추심"?"text-red-600":x.status==="보류"?"text-amber-700":"text-slate-600"}`}>{x.status}</span>}
      </div>
      <div className="mt-0.5 break-words text-[10px] leading-4 opacity-85">{x.sub}</div>
     </div>
    })}
   </div>
  </div>}
 </>
}

export default function Dashboard(){const s=useAdminStore();const initialRange=monthRange();const currentMonth=today().slice(0,7);const [rangeStart,setRangeStart]=useState(initialRange.start);const [rangeEnd,setRangeEnd]=useState(initialRange.end);const [paymentMonth,setPaymentMonth]=useState(currentMonth);const [repaymentMonth,setRepaymentMonth]=useState(currentMonth);const accidentIds=useMemo(()=>new Set(s.customers.filter(c=>c.isAccident).map(c=>c.id)),[s.customers]);const data=useMemo(()=>{const customers=s.customers.filter(x=>inRange(x.createdAt,rangeStart,rangeEnd));const baseContractSales=s.customers.filter(x=>isEformSignedStatus(x.eformsignStatus)&&(x.isAccident?x.contractAmount:(x.baseContractAmount??x.contractAmount))>0&&inRange(x.contractDate||x.createdAt,rangeStart,rangeEnd)).reduce((a,b)=>a+(b.isAccident?b.contractAmount:(b.baseContractAmount??b.contractAmount)),0);const additionalContractSales=s.additionalContracts.filter(x=>s.customers.some(c=>c.id===x.customerId&&isEformSignedStatus(c.eformsignStatus)&&!c.isAccident)&&x.contractAmount>0&&inRange(x.contractDate||String(x.createdTime||"").slice(0,10),rangeStart,rangeEnd)).reduce((a,b)=>a+b.contractAmount,0);const contractSales=baseContractSales+additionalContractSales;const paid=s.payments.filter(x=>s.customers.some(c=>c.id===x.customerId&&isEformSignedStatus(c.eformsignStatus))&&x.paidDate&&inRange(x.paidDate,rangeStart,rangeEnd)&&x.status!=="환불");const realSales=paid.reduce((a,b)=>a+b.paidAmount,0);const receivable=s.customers.filter(c=>c.contractAmount>0).reduce((sum,c)=>{const allPaid=s.payments.filter(p=>p.customerId===c.id&&p.status!=="환불"&&p.scheduleType!=="환수").reduce((a,b)=>a+b.paidAmount,0);return sum+Math.max(0,c.contractAmount-allPaid)},0);return{customers,contractSales,realSales,receivable}},[s.customers,s.payments,s.additionalContracts,rangeStart,rangeEnd]);
 const paymentMonthSchedules=s.payments.filter(p=>!accidentIds.has(p.customerId)&&p.dueDate.startsWith(paymentMonth)&&p.status!=="환불");
 const paymentItems=paymentMonthSchedules.map(p=>{const c=s.customers.find(x=>x.id===p.customerId);return{id:p.id,date:p.dueDate,label:c?.name||"고객없음",duplicateTag:duplicateCustomerTag(s.customers,c),sub:`${p.scheduleType==="재약정"?`재약정 ${p.rescheduleSequence||1}차 · `:""}${won(p.dueAmount)}`,done:p.status==="완료",status:p.status,amount:p.dueAmount||0}});
 const monthPaid=s.payments.filter(p=>s.customers.some(c=>c.id===p.customerId&&isEformSignedStatus(c.eformsignStatus))&&p.paidDate.startsWith(paymentMonth)&&p.status!=="환불").reduce((sum,p)=>sum+(p.paidAmount||0),0);
 const monthExpected=paymentMonthSchedules.filter(p=>s.customers.some(c=>c.id===p.customerId&&isEformSignedStatus(c.eformsignStatus)&&!c.isAccident)).reduce((sum,p)=>sum+(p.status==="완료"||hasRescheduledChild(s.payments,p.id)?0:Math.max(0,(p.dueAmount||0)-(p.paidAmount||0))),0);
 const paymentSummary={paid:monthPaid,expected:monthExpected,total:monthPaid+monthExpected};
 const repaymentItems=s.repayments.filter(r=>!accidentIds.has(r.customerId)&&r.dueDate.startsWith(repaymentMonth)).map(r=>{const c=s.customers.find(x=>x.id===r.customerId);return{id:r.id,date:r.dueDate,label:c?.name||"고객없음",duplicateTag:duplicateCustomerTag(s.customers,c),sub:`${r.lenderName} ${won(r.amount)}`,done:r.status==="상환완료"||r.status==="종결"||String(r.status)==="완료",status:String(r.status)==="완료"?"상환완료":r.status,amount:r.amount||0,problem:hasRepaymentProblem(r.memo)}});
 function updateRepaymentProblem(id:string,checked:boolean){const row=s.repayments.find(r=>r.id===id);if(!row)return;s.updateRepayment(id,{memo:setRepaymentProblemMemo(row.memo,checked)})}
 return <><PageHeader title="대시보드" description="선택한 기간의 운영 현황과 월별 분납·상환 일정을 확인합니다. 계약·실매출은 전자서명 완료 고객 기준이며, 미수금은 등록된 계약금액에서 실제 계약대금 입금액을 차감해 계산합니다." action={<DateRangePicker start={rangeStart} end={rangeEnd} onChange={(start,end)=>{setRangeStart(start);setRangeEnd(end)}}/>}/>
 <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[[Users,"전체 고객",data.customers.length,"normal"],[CircleDollarSign,"계약 매출",won(data.contractSales),"normal"],[WalletCards,"실매출",won(data.realSales),"normal"],[CircleDollarSign,"미수금",won(data.receivable),"red"]].map(([Icon,l,v,t]:any)=><Card key={l} className="p-4"><div className="flex items-center justify-between"><span className="text-xs font-semibold text-slate-500">{l}</span><Icon size={16} className="text-slate-400"/></div><div className={`mt-3 text-xl font-bold ${t==="red"?"text-red-600":"text-slate-900"}`}>{v}</div></Card>)}</div>
 <div className="mt-4 grid gap-4 xl:grid-cols-2"><MonthCalendar title="분납 캘린더" month={paymentMonth} onMonthChange={setPaymentMonth} items={paymentItems} tone="blue" summary={paymentSummary}/><MonthCalendar title="상환 캘린더" month={repaymentMonth} onMonthChange={setRepaymentMonth} items={repaymentItems} tone="amber" onProblemChange={updateRepaymentProblem}/></div>
 </>}
