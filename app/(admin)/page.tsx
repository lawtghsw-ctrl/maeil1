"use client";
import {useMemo,useState} from "react";
import {CalendarDays,CircleDollarSign,Users,WalletCards} from "lucide-react";
import {Card,PageHeader} from "@/components/ui";
import {DateRangePicker} from "@/components/date-range-picker";
import {useAdminStore} from "@/components/store";
import {duplicateCustomerTag,inRange,isEformSignedStatus,won} from "@/lib/utils";
import {calendarItemTone,calendarOverdueHistory,calendarPaymentRecord,isCompletedRepaymentStatus} from "@/lib/calendar-status";
import {paymentRemaining,customerCredit} from "@/lib/payment-metrics";
import {buildRevenueEvents,summarizeRevenue} from "@/lib/revenue-metrics";
import {buildBankCashRows,summarizeBankCash} from "@/lib/bank-cash-metrics";
import {buildScheduleLedger,SchedulePosition} from "@/lib/schedule-ledger";
import {groupBy} from "@/lib/supabase/refresh-queue";
function today(){return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}
function monthRange(){const t=today();const [y,m]=t.split("-").map(Number);return{start:`${y}-${String(m).padStart(2,"0")}-01`,end:`${y}-${String(m).padStart(2,"0")}-${String(new Date(y,m,0).getDate()).padStart(2,"0")}`}}
function shiftMonth(month:string,delta:number){const [y,m]=month.split("-").map(Number);const d=new Date(y,m-1+delta,1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`}
const REPAYMENT_PROBLEM_MEMO="상환에 문제 있음";
function hasRepaymentProblem(memo:string){return String(memo||"").split(/\r?\n/).some(line=>line.trim()===REPAYMENT_PROBLEM_MEMO)}
function setRepaymentProblemMemo(memo:string,checked:boolean){const lines=String(memo||"").split(/\r?\n/).filter(line=>line.trim()!==REPAYMENT_PROBLEM_MEMO);if(checked)lines.push(REPAYMENT_PROBLEM_MEMO);return lines.join("\n").trim()}
type CalendarItem={id:string;date:string;label:string;sub:string;done:boolean;status?:string;registeredStatus?:string;amount:number;duplicateTag?:string;problem?:boolean;history?:boolean};
type CalendarSummary={paid:number;expected:number;total:number;periods?:{label:string;paid:number;expected:number;total:number;inflow?:number;outflow?:number}[]};
const isLatePaymentItem=(item:CalendarItem)=>!item.done&&(item.status==="연체"||item.status==="미납");
function sortPaymentDayItems(rows:CalendarItem[],collectionsLast=false){const collectionRank=(item:CalendarItem)=>Number(collectionsLast&&(item.problem||item.status==="추심"||item.registeredStatus==="추심"));return [...rows].sort((a,b)=>collectionRank(a)-collectionRank(b)||Number(a.done)-Number(b.done)||b.amount-a.amount||a.label.localeCompare(b.label,"ko"))}
function MonthCalendar({title,month,onMonthChange,items,tone,summary,onProblemChange}:{title:string;month:string;onMonthChange:(month:string)=>void;items:CalendarItem[];tone:"blue"|"amber";summary?:CalendarSummary;onProblemChange?:(id:string,checked:boolean)=>void}){
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
  setPinned(prev=>prev?{...prev,rows:sortPaymentDayItems(prev.rows.map(row=>row.id===id?{...row,problem:checked}:row),tone==="amber")}:prev);
  onProblemChange?.(id,checked);
 }
 const active=pinned||hovered;

 return <>
  <Card className="overflow-hidden">
   <div className="border-b border-slate-100 px-5 py-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
     <div><h3 className="text-base font-bold">{title}</h3><p className="mt-1 text-xs text-slate-500">{month} 일정</p><div className="mt-2 flex flex-wrap gap-3 text-[10px] font-semibold"><span className="text-blue-700">● 예정</span><span className="text-orange-700">● 미납</span><span className="text-slate-500">● 완료·종결·추심</span></div></div>
     <div className="flex flex-wrap items-center gap-2">
      <select value={yy} onChange={e=>onMonthChange(`${e.target.value}-${String(mm).padStart(2,"0")}`)} className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs">{Array.from({length:11},(_,i)=>yy-5+i).map(y=><option key={y} value={y}>{y}년</option>)}</select>
      <select value={mm} onChange={e=>onMonthChange(`${yy}-${String(Number(e.target.value)).padStart(2,"0")}`)} className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs">{Array.from({length:12},(_,i)=>i+1).map(m=><option key={m} value={m}>{m}월</option>)}</select>
      <button type="button" onClick={()=>onMonthChange(today().slice(0,7))} className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">이번달</button>
      <button type="button" onClick={()=>onMonthChange(shiftMonth(month,-1))} className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">이전달</button>
      <button type="button" onClick={()=>onMonthChange(shiftMonth(month,1))} className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">다음달</button>
      <label className="relative grid h-8 w-9 cursor-pointer place-items-center overflow-hidden rounded-lg border border-slate-200 bg-white hover:bg-slate-50" title="년·월 선택">
       <CalendarDays size={17} className={tone==="blue"?"text-blue-600":"text-amber-600"}/>
       <input type="month" value={month} onChange={e=>e.target.value&&onMonthChange(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label={`${title} 년·월 선택`}/>
      </label>
     </div>
    </div>
    {summary&&<div className="mt-4 space-y-3">
     <div className="grid grid-cols-3 gap-2">
      {([{label:tone==="amber"?"이번 달 상환액":"이번 달 입금액",value:summary.paid,color:"emerald"},{label:tone==="amber"?"상환 예정 금액":"받을 예정 금액",value:summary.expected,color:"blue"},{label:"합산 금액",value:summary.total,color:"slate"}] as const).map(item=><div key={item.label} className={`min-w-0 rounded-xl border px-2 py-3 sm:px-3 ${item.color==="emerald"?"border-emerald-100 bg-emerald-50/70":item.color==="blue"?"border-blue-100 bg-blue-50/70":"border-slate-200 bg-slate-50"}`}><div className="text-[11px] font-semibold text-slate-600">{item.label}</div><div className="mt-1 whitespace-nowrap text-[11px] font-bold tabular-nums text-slate-900 sm:text-base xl:text-lg">{won(item.value)}</div></div>)}
     </div>
     {summary.periods&&<div className="overflow-x-auto rounded-xl border border-slate-200"><table className={`w-full text-xs ${tone==="amber"?"min-w-[360px]":"min-w-[600px]"}`}><thead className="bg-slate-50 text-slate-600"><tr>{(tone==="amber"?["기간","상환액","상환예정","합산"]:["기간","입금","출금","순입금액","받을 예정","합산"]).map(h=><th key={h} scope="col" className="px-3 py-2 text-right first:text-left">{h}</th>)}</tr></thead><tbody>{summary.periods.map(period=><tr key={period.label} className="border-t border-slate-100"><th scope="row" className="px-3 py-2 text-left font-semibold text-slate-700">{period.label}</th>{tone==="blue"&&<><td className="px-3 py-2 text-right">{won(period.inflow||0)}</td><td className="px-3 py-2 text-right text-red-600">{won(period.outflow||0)}</td></>}<td className="px-3 py-2 text-right font-semibold">{won(period.paid)}</td><td className="px-3 py-2 text-right text-blue-700">{won(period.expected)}</td><td className="px-3 py-2 text-right font-bold">{won(period.total)}</td></tr>)}</tbody></table></div>}
    </div>}
   </div>
   <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50">{["일","월","화","수","목","금","토"].map(x=><div key={x} className="p-2 text-center text-xs font-semibold text-slate-500">{x}</div>)}</div>
   <div className="grid grid-cols-7">
    {days.map((d,i)=>{
     const dayRows=d?items.filter(x=>x.date===d):[];
     const rows=sortPaymentDayItems(dayRows,tone==="amber");
     return <div key={`${d}-${i}`}
      onMouseEnter={e=>d&&showDay(e,d,rows)}
      onMouseLeave={()=>{if(!pinned)setHovered(null)}}
      onClick={e=>d&&pinDay(e,d,rows)}
      className={`min-h-[96px] border-b border-r border-slate-100 p-1.5 sm:min-h-[112px] sm:p-2 ${rows.length?"cursor-pointer hover:bg-slate-50/80":""}`}>
      {d&&<><div className="text-xs font-bold text-slate-600">{Number(d.slice(-2))}</div><div className="mt-1.5 space-y-1.5">{rows.slice(0,3).map(x=>{
       const rowTone=calendarItemTone(x);
       const rowClass=rowTone==="gray"?`bg-slate-200 text-slate-500 ${x.done?"opacity-75":""}`:rowTone==="orange"?"bg-orange-100 text-orange-900":"bg-blue-50 text-blue-800";
       return <div key={x.id} title={x.sub} className={`rounded-md px-1.5 py-1 text-[10px] font-medium sm:text-[11px] ${rowClass}`}><div className="flex min-w-0 items-center gap-1"><span className={`min-w-0 truncate ${x.status==="추심"||x.problem?"font-bold text-red-600":""}`}>{x.label}</span>{x.duplicateTag&&<span className="shrink-0 rounded bg-white/80 px-1 py-0.5 text-[8px] font-bold text-slate-600 ring-1 ring-inset ring-slate-200">{x.duplicateTag}</span>}</div><div className="truncate opacity-90">{x.sub}</div></div>
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
     <div className={`min-w-0 flex-1 truncate text-center text-[10px] font-bold ${tone==="blue"?"text-blue-700":"text-amber-700"}`}>{tone==="blue"?"분납 총합":"상환 총합"} {won(active.rows.reduce((sum,row)=>sum+(tone==="blue"&&isLatePaymentItem(row)?0:(row.amount||0)),0))}</div>
     <div className="flex shrink-0 items-center gap-1.5">
      <div className="rounded-full bg-white px-2 py-0.5 text-[9px] font-bold text-slate-500 ring-1 ring-slate-200">{active.rows.length}건</div>
      {pinned&&<div className="text-[9px] font-semibold text-blue-600">고정됨</div>}
     </div>
    </div>
    <div className="mt-0.5 text-[10px] text-slate-500">{title}{!pinned&&" · 클릭하면 고정"}</div>
   </div>
   <div className="max-h-[174px] space-y-1.5 overflow-y-auto p-2">
    {active.rows.map(x=>{
     const rowTone=calendarItemTone(x);
     const rowClass=rowTone==="gray"?"border-slate-200 bg-slate-100 text-slate-500":rowTone==="orange"?"border-orange-200 bg-orange-100 text-orange-900":"border-blue-100 bg-blue-50 text-blue-900";
     return <div key={x.id} className={`rounded-lg border px-2.5 py-2 ${rowClass}`}>
      <div className="flex items-start justify-between gap-2">
       <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1"><div className={`min-w-0 break-words text-[12px] font-bold leading-4 ${x.status==="추심"||x.problem?"text-red-600":""}`}>{x.label}</div>{x.duplicateTag&&<span className="shrink-0 rounded-md bg-white px-1.5 py-0.5 text-[8px] font-bold text-slate-600 ring-1 ring-inset ring-slate-200">{x.duplicateTag}</span>}{tone==="amber"&&pinned&&!x.done&&!x.history&&x.status!=="추심"&&<input type="checkbox" checked={!!x.problem} onClick={e=>e.stopPropagation()} onChange={e=>toggleProblem(x.id,e.target.checked)} className="ml-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-red-600" aria-label="상환 문제 표시" title="상환 문제 표시"/>}</div>
       {x.status&&<span className={`shrink-0 rounded-full bg-white/80 px-1.5 py-0.5 text-[8px] font-bold ${x.done?"text-slate-500":x.status==="연체"||x.status==="미납"||x.status==="추심"?"text-red-600":x.status==="보류"?"text-amber-700":"text-slate-600"}`}>{x.status}</span>}
      </div>
      <div className="mt-0.5 break-words text-[10px] leading-4 opacity-85">{x.sub}</div>
     </div>
    })}
   </div>
  </div>}
 </>
}

export default function Dashboard(){const s=useAdminStore();const initialRange=monthRange();const currentMonth=today().slice(0,7);const [rangeStart,setRangeStart]=useState(initialRange.start);const [rangeEnd,setRangeEnd]=useState(initialRange.end);const [paymentMonth,setPaymentMonth]=useState(currentMonth);const [repaymentMonth,setRepaymentMonth]=useState(currentMonth);const accidentIds=useMemo(()=>new Set(s.customers.filter(c=>c.isAccident).map(c=>c.id)),[s.customers]);const revenueEvents=useMemo(()=>buildRevenueEvents(s.payments,s.recoveries,s.recoveryAllocations),[s.payments,s.recoveries,s.recoveryAllocations]);const data=useMemo(()=>{const customers=s.customers.filter(x=>inRange(x.createdAt,rangeStart,rangeEnd));const baseContractSales=s.customers.filter(x=>isEformSignedStatus(x.eformsignStatus)&&(x.isAccident?x.contractAmount:(x.baseContractAmount??x.contractAmount))>0&&inRange(x.contractDate||x.createdAt,rangeStart,rangeEnd)).reduce((a,b)=>a+(b.isAccident?b.contractAmount:(b.baseContractAmount??b.contractAmount)),0);const additionalContractSales=s.additionalContracts.filter(x=>s.customers.some(c=>c.id===x.customerId&&isEformSignedStatus(c.eformsignStatus)&&!c.isAccident)&&x.contractAmount>0&&inRange(x.contractDate||String(x.createdTime||"").slice(0,10),rangeStart,rangeEnd)).reduce((a,b)=>a+b.contractAmount,0);const contractSales=baseContractSales+additionalContractSales;const signedIds=new Set(s.customers.filter(c=>isEformSignedStatus(c.eformsignStatus)).map(c=>c.id));const realSales=summarizeRevenue(revenueEvents,rangeStart,rangeEnd,signedIds).realSales;const receivable=s.customers.filter(c=>isEformSignedStatus(c.eformsignStatus)).reduce((sum,c)=>{const allPaid=s.payments.filter(p=>p.customerId===c.id&&p.status!=="환불"&&p.scheduleType!=="환수").reduce((a,b)=>a+b.paidAmount,0);return sum+Math.max(0,c.contractAmount-allPaid-customerCredit(s.payments,c.id,c.recoveryCredit||0))},0);return{customers,contractSales,realSales,receivable}},[s.customers,s.payments,s.additionalContracts,revenueEvents,rangeStart,rangeEnd]);
 const bankRows=useMemo(()=>buildBankCashRows(s.settlements,s.recoveryRefunds,s.customers),[s.settlements,s.recoveryRefunds,s.customers]);
 const bankSummary=useMemo(()=>summarizeBankCash(bankRows,rangeStart,rangeEnd),[bankRows,rangeStart,rangeEnd]);
 const paymentLedgers=useMemo(()=>{
  const grouped=groupBy(s.payments,p=>p.customerId);
  return new Map(s.customers.map(c=>[c.id,buildScheduleLedger(grouped.get(c.id)||[],c.contractAmount,c.recoveryCredit||0)]));
 },[s.payments,s.customers]);
 const repaymentLedger=useMemo(()=>buildScheduleLedger(s.repayments),[s.repayments]);
 const paymentPositions=useMemo(()=>{
  const positions=new Map<string,SchedulePosition>();
  for(const ledger of paymentLedgers.values())for(const [id,position] of ledger.byId)positions.set(id,position);
  return positions;
 },[paymentLedgers]);
 const remaining=(p:typeof s.payments[number])=>p.scheduleType==="환수"?paymentRemaining(p):(paymentPositions.get(p.id)?.remaining||0);
 const paymentMonthSchedules=s.payments.filter(p=>!accidentIds.has(p.customerId)&&p.dueDate.startsWith(paymentMonth)&&p.status!=="환불"&&remaining(p)>0);
 // Current promises carry only remaining debt; receipts stay on their actual date.
 const paymentScheduleItems:CalendarItem[]=paymentMonthSchedules.map(p=>{const c=s.customers.find(x=>x.id===p.customerId),balance=remaining(p),registeredBalance=paymentRemaining(p);return{id:`schedule-${p.id}`,date:p.dueDate,label:c?.name||"고객없음",duplicateTag:duplicateCustomerTag(s.customers,c),sub:`${registeredBalance>balance?`등록 잔액 ${won(registeredBalance)} · 현재 집계 ${won(balance)} · `:""}${p.scheduleType==="재약정"?`재약정 ${p.rescheduleSequence||1}차 · `:""}${registeredBalance>balance?"금액 확인 필요":`남은 금액 ${won(balance)}`}${p.paidAmount>0?` · 입금 ${won(p.paidAmount)}${!p.paidDate?" · 입금일 미등록":""}`:""}`,done:false,registeredStatus:p.status,status:p.status==="완료"?"입금 확인 필요":p.status,amount:balance}});
 const paymentActualItems:CalendarItem[]=s.payments.filter(p=>!accidentIds.has(p.customerId)&&p.status!=="환불"&&p.paidAmount>0&&p.paidDate&&p.paidDate.startsWith(paymentMonth)).map(p=>{const c=s.customers.find(x=>x.id===p.customerId);return{id:`paid-${p.id}`,date:p.paidDate,label:c?.name||"고객없음",duplicateTag:duplicateCustomerTag(s.customers,c),sub:`실입금 ${won(p.paidAmount)} · 원래 예정일 ${p.dueDate}`,done:true,status:"완료",amount:p.paidAmount}});
 const paymentHistoryItems:CalendarItem[]=s.payments.flatMap(p=>{
  if(accidentIds.has(p.customerId)||!p.dueDate.startsWith(paymentMonth)||p.status==="환불")return [];
  const record=calendarPaymentRecord(p,paymentPositions.get(p.id));if(!record)return [];
  const c=s.customers.find(x=>x.id===p.customerId);
  const late=p.status==="연체"||p.status==="미납"||String(p.status)==="부분납부 후 연체";
  const receipt=p.paidAmount>0?` · 등록 입금 ${won(p.paidAmount)}${p.paidDate?` (${p.paidDate})`:" · 입금일 미등록"}`:"";
  const credit=(p.allocatedAmount||0)>0?` · 충당 ${won(p.allocatedAmount||0)}`:"";
  const description=record.kind==="settled"?(p.paidAmount>0?"입금 반영 완료":"충당 반영 완료"):record.kind==="confirmation"?"입금 확인 필요":record.kind==="rescheduled"?(late?"재약정 전 연체 이력":"재약정 전 이력"):record.kind==="empty"?"등록 일정":"등록 금액 확인 필요";
  const registeredAmount=record.rawRemaining>0?`등록 잔액 ${won(record.rawRemaining)}${record.rawRemaining!==p.dueAmount?` · 원래 예정 ${won(p.dueAmount)}`:""}`:`원래 예정 ${won(p.dueAmount)}`;
  const status=record.kind==="settled"?"완료":record.kind==="confirmation"?"입금 확인 필요":record.kind==="rescheduled"?(late?"연체 이력":"이전 예정"):record.kind==="empty"?p.status:"금액 확인 필요";
  return [{id:`history-${p.id}`,date:p.dueDate,label:c?.name||"고객없음",duplicateTag:duplicateCustomerTag(s.customers,c),
   sub:`${registeredAmount} · ${description}${receipt}${credit} · 합계 제외`,
   done:record.kind==="settled",history:true,registeredStatus:p.status,status,amount:0}];
 });
 const paymentItems=[...paymentScheduleItems,...paymentHistoryItems,...paymentActualItems];
 const signedCustomerIds=new Set(s.customers.filter(c=>isEformSignedStatus(c.eformsignStatus)).map(c=>c.id));
 const eligibleSchedules=paymentMonthSchedules.filter(p=>signedCustomerIds.has(p.customerId));
 // Bank totals share the exact statement population; revenue and planned debt stay separate.
 const isOverdue=(p:typeof s.payments[number])=>p.status==="연체"||p.status==="미납";
 const isExpected=(p:typeof s.payments[number])=>!isOverdue(p);

 const sumScheduled=(startDay:number,endDay:number,predicate:(p:typeof s.payments[number])=>boolean)=>eligibleSchedules.filter(p=>{const day=Number(p.dueDate.slice(8,10));return day>=startDay&&day<=endDay&&predicate(p)}).reduce((sum,p)=>sum+remaining(p),0);
 const lastDay=new Date(Number(paymentMonth.slice(0,4)),Number(paymentMonth.slice(5,7)),0).getDate();
 const periods=[{label:"1~15일",from:1,to:15},{label:`16~${lastDay}일`,from:16,to:lastDay}].map(({label,from,to})=>{const cash=summarizeBankCash(bankRows,`${paymentMonth}-${String(from).padStart(2,"0")}`,`${paymentMonth}-${String(to).padStart(2,"0")}`);const paid=cash.net;const expected=sumScheduled(from,to,isExpected);const overdue=sumScheduled(from,to,isOverdue);return{label,paid,inflow:cash.inflow,outflow:cash.outflow,expected,overdue,total:paid+expected}});
 const monthPaid=periods.reduce((sum,p)=>sum+p.paid,0);
 const monthExpected=periods.reduce((sum,p)=>sum+p.expected,0);
 const monthOverdue=periods.reduce((sum,p)=>sum+p.overdue,0);
 const paymentSummary={paid:monthPaid,inflow:periods.reduce((sum,p)=>sum+p.inflow,0),outflow:periods.reduce((sum,p)=>sum+p.outflow,0),expected:monthExpected,total:monthPaid+monthExpected,overdue:monthOverdue,periods};
 // 실제 상환은 원본 일정 상태와 무관하게 납부한 날짜에 [완료] 이벤트로 표시.
 // DB에 별도 상환/입금 행을 만들지 않으므로 실납부 집계와 이중으로 계산되지 않습니다.
 const repaymentScheduleItems:CalendarItem[]=s.repayments.filter(r=>!accidentIds.has(r.customerId)&&r.dueDate.startsWith(repaymentMonth)&&!isCompletedRepaymentStatus(r.status)&&(repaymentLedger.byId.get(r.id)?.remaining||0)>0).map(r=>{const c=s.customers.find(x=>x.id===r.customerId);const balance=repaymentLedger.byId.get(r.id)?.remaining||0;return{id:r.id,date:r.dueDate,label:c?.name||"고객없음",duplicateTag:duplicateCustomerTag(s.customers,c),sub:`${r.lenderName} 남은 금액 ${won(balance)}`,done:false,registeredStatus:r.status,status:r.status,amount:balance,problem:hasRepaymentProblem(r.memo)}});
 const repaymentActualItems:CalendarItem[]=s.repayments.filter(r=>!accidentIds.has(r.customerId)&&Number(r.paidAmount||0)>0&&r.paidDate&&r.paidDate.startsWith(repaymentMonth)).map(r=>{const c=s.customers.find(x=>x.id===r.customerId);return{id:`actual-repayment-${r.id}`,date:r.paidDate!,label:c?.name||"고객없음",duplicateTag:duplicateCustomerTag(s.customers,c),sub:`${r.lenderName} 실상환 ${won(Number(r.paidAmount||0))} · 원래 상환일 ${r.dueDate}`,done:true,status:"완료",amount:Number(r.paidAmount||0)}});
 // Registered completion is a calendar fact, not an invented cash receipt.
 const repaymentCompletionItems:CalendarItem[]=s.repayments.flatMap(r=>{
  if(accidentIds.has(r.customerId)||!r.dueDate.startsWith(repaymentMonth)||!isCompletedRepaymentStatus(r.status)||repaymentLedger.byId.get(r.id)?.state==="cancelled")return [];
  if(r.amount>0&&Number(r.paidAmount||0)>=r.amount&&r.paidDate===r.dueDate)return [];
  const c=s.customers.find(x=>x.id===r.customerId),status=r.status==="종결"?"종결":"상환완료";
  return [{id:`completion-${r.id}`,date:r.dueDate,label:c?.name||"고객없음",duplicateTag:duplicateCustomerTag(s.customers,c),
   sub:`${r.lenderName} ${status} 등록 · 원래 예정 ${won(r.amount)} · 합계 제외`,
   done:true,history:true,registeredStatus:r.status,status,amount:0,problem:hasRepaymentProblem(r.memo)}];
 });
 const repaymentHistoryItems:CalendarItem[]=s.repayments.flatMap(r=>{
  if(accidentIds.has(r.customerId)||!r.dueDate.startsWith(repaymentMonth))return [];
  const history=calendarOverdueHistory(r,repaymentLedger.byId.get(r.id));if(!history)return [];
  const c=s.customers.find(x=>x.id===r.customerId);
  return [{id:`history-${r.id}`,date:r.dueDate,label:c?.name||"고객없음",duplicateTag:duplicateCustomerTag(s.customers,c),
   sub:`${history==="rescheduled"?"재약정 전 연체 이력":"등록 금액 확인 필요"} · ${r.lenderName} 원래 예정 ${won(r.amount)} · 합계 제외`,
   done:false,history:true,registeredStatus:r.status,status:history==="rescheduled"?"연체 이력":"금액 확인 필요",amount:0,problem:hasRepaymentProblem(r.memo)}];
 });
 const repaymentItems=[...repaymentScheduleItems,...repaymentHistoryItems,...repaymentCompletionItems,...repaymentActualItems];
 // Hide overdue and replaced promises without changing debt or real receipts.
 function isVisibleCalendarItem(item:CalendarItem){
  const status=item.registeredStatus??item.status;
  const previousPromise=item.history&&(item.status==="이전 예정"||item.status==="연체 이력");
  return item.done||(!previousPromise&&status!=="연체"&&status!=="부분납부 후 연체"&&status!=="연체 이력");
 }
 const paymentCalendarItems=paymentItems.filter(isVisibleCalendarItem);
 const repaymentCalendarItems=repaymentItems.filter(isVisibleCalendarItem);
 const repaymentExpectedItems=repaymentCalendarItems.filter(item=>!item.done&&!item.history&&(item.registeredStatus??item.status)!=="추심");
 const repaymentLastDay=new Date(Number(repaymentMonth.slice(0,4)),Number(repaymentMonth.slice(5,7)),0).getDate();
 const repaymentPeriods=[{label:"1~15일",from:1,to:15},{label:`16~${repaymentLastDay}일`,from:16,to:repaymentLastDay}].map(({label,from,to})=>{
  const sumItems=(items:CalendarItem[])=>items.reduce((sum,item)=>{const day=Number(item.date.slice(8,10));return day>=from&&day<=to?sum+item.amount:sum},0);
  const paid=sumItems(repaymentActualItems),expected=sumItems(repaymentExpectedItems);
  return{label,paid,expected,total:paid+expected};
 });
 const repaymentPaid=repaymentPeriods.reduce((sum,period)=>sum+period.paid,0);
 const repaymentExpected=repaymentPeriods.reduce((sum,period)=>sum+period.expected,0);
 const repaymentSummary:CalendarSummary={paid:repaymentPaid,expected:repaymentExpected,total:repaymentPaid+repaymentExpected,periods:repaymentPeriods};
 function updateRepaymentProblem(id:string,checked:boolean){const row=s.repayments.find(r=>r.id===id);if(!row)return;void s.updateRepayment(id,{memo:setRepaymentProblemMemo(row.memo,checked)}).catch(error=>alert(`상환 메모 저장 실패: ${error instanceof Error?error.message:String(error)}`))}
 return <><PageHeader title="대시보드" description="" action={<DateRangePicker start={rangeStart} end={rangeEnd} onChange={(start,end)=>{setRangeStart(start);setRangeEnd(end)}}/>}/>
 <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[[Users,"전체 고객",data.customers.length,"normal"],[CircleDollarSign,"계약 매출",won(data.contractSales),"normal"],[WalletCards,"실매출",won(data.realSales),"normal"],[CircleDollarSign,"미수금",won(data.receivable),"red"]].map(([Icon,l,v,t]:any)=><Card key={l} className="p-4"><div className="flex items-center justify-between"><span className="text-xs font-semibold text-slate-500">{l}</span><Icon size={16} className="text-slate-400"/></div><div className={`mt-3 text-xl font-bold ${t==="red"?"text-red-600":"text-slate-900"}`}>{v}</div></Card>)}</div>
 <Card className="mt-4 p-4"><div className="mb-3 text-sm font-bold">실제 입출금 · {rangeStart} ~ {rangeEnd}</div><div className="grid grid-cols-3 gap-3">{[["입금",bankSummary.inflow],["출금",bankSummary.outflow],["순입금 (입금 − 출금)",bankSummary.net]].map(([label,value])=><div key={label as string} className="rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="text-xs font-semibold text-slate-500">{label}</div><div className={`mt-2 text-base font-bold sm:text-xl ${label==="출금"?"text-red-600":"text-slate-900"}`}>{won(value as number)}</div></div>)}</div></Card>
 <div className="mt-4 grid gap-4 xl:grid-cols-2"><MonthCalendar title="분납 캘린더" month={paymentMonth} onMonthChange={setPaymentMonth} items={paymentCalendarItems} tone="blue" summary={paymentSummary}/><MonthCalendar title="상환 캘린더" month={repaymentMonth} onMonthChange={setRepaymentMonth} items={repaymentCalendarItems} tone="amber" summary={repaymentSummary} onProblemChange={updateRepaymentProblem}/></div>
 </>}
