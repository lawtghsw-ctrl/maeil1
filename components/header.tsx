"use client";
import {Bell,Inbox,RefreshCcw,Search,X} from "lucide-react";
import {useMemo,useState} from "react";
import {useRouter} from "next/navigation";
import {useAdminStore} from "./store";
import {buildScheduleLedger} from "@/lib/schedule-ledger";
import {effectivePayments,currentPaymentBalances} from "@/lib/payment-metrics";
import {SalesTodoButton} from "@/components/sales-todo";
function kstDate(){return new Intl.DateTimeFormat("ko-KR",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}
function isoToday(){return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}
export function Header(){
 const s=useAdminStore();const router=useRouter();const [noticeOpen,setNoticeOpen]=useState(false);const [q,setQ]=useState("");const [searchOpen,setSearchOpen]=useState(false);const today=isoToday();
 const matches=useMemo(()=>q.trim()?s.customers.filter(c=>`${c.name} ${c.phone}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0,8):[],[q,s.customers]);
 const accidentIds=useMemo(()=>new Set(s.customers.filter(c=>c.isAccident).map(c=>c.id)),[s.customers]);
 const paymentBalances=currentPaymentBalances(s.payments,s.customers);
 const paymentAlerts=effectivePayments(s.payments,s.customers).filter(p=>!accidentIds.has(p.customerId)&&p.status!=="환불"&&!!p.dueDate&&p.dueDate<=today).map(p=>({...p,dueAmount:paymentBalances.get(p.id)||0,customer:s.customers.find(c=>c.id===p.customerId)}));
 const repaymentPositions=buildScheduleLedger(s.repayments).byId;
 const repaymentAlerts=s.repayments.filter(r=>(repaymentPositions.get(r.id)?.remaining||0)>0&&!accidentIds.has(r.customerId)&&r.status!=="추심"&&!!r.dueDate&&r.dueDate<=today).map(r=>({...r,amount:repaymentPositions.get(r.id)?.remaining||0,customer:s.customers.find(c=>c.id===r.customerId)}));
 const alertCount=paymentAlerts.length+repaymentAlerts.length;
 const unclassifiedLeadCount=useMemo(()=>s.metaLeads.filter(lead=>lead.status==="신규"&&lead.newDbAlertEnabled===true&&(lead.leadResult||"신규DB")==="신규DB").length,[s.metaLeads]);
 function choose(id:string){setQ("");setSearchOpen(false);router.push(`/customers?customer=${encodeURIComponent(id)}`)}
 return <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
  <div className="flex min-h-16 min-w-0 items-center justify-between gap-3 pl-16 pr-4 lg:px-7">
  <div className="relative hidden min-w-0 w-full max-w-md md:block"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/><input value={q} onChange={e=>{setQ(e.target.value);setSearchOpen(true)}} onFocus={()=>setSearchOpen(true)} onKeyDown={e=>{if(e.key==="Enter"&&matches[0])choose(matches[0].id)}} placeholder="고객명 또는 전화번호 검색" className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100"/>
  {searchOpen&&q.trim()&&<div className="absolute left-0 right-0 top-11 z-50 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">{matches.length===0?<div className="px-4 py-6 text-center text-sm text-slate-400">일치하는 고객이 없습니다.</div>:matches.map(c=><button key={c.id} onClick={()=>choose(c.id)} className="flex w-full items-center justify-between border-b border-slate-100 px-4 py-3 text-left last:border-0 hover:bg-blue-50"><div><div className="text-sm font-semibold">{c.name}</div><div className="text-xs text-slate-400">{c.phone}</div></div><span className="text-xs text-slate-500">{c.manager}</span></button>)}</div>}</div>
  <div className="ml-auto flex shrink-0 items-center gap-2">
  <SalesTodoButton/>
  <button onClick={()=>window.location.reload()} title="새로고침" className="grid size-9 place-items-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"><RefreshCcw size={16}/></button>
  <div className="relative"><button onClick={()=>setNoticeOpen(v=>!v)} title="알림" className="relative grid size-9 place-items-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"><Bell size={17}/>{alertCount>0&&<span className="absolute right-1 top-1 min-w-4 rounded-full bg-blue-600 px-1 text-center text-[9px] font-bold leading-4 text-white">{alertCount>9?"9+":alertCount}</span>}</button>
  {noticeOpen&&<div className="absolute right-0 top-11 z-50 w-[calc(100vw-24px)] max-w-[360px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl"><div className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><div><div className="text-sm font-bold">업무 알림</div><div className="text-[11px] text-slate-400">오늘까지 확인할 일정 {alertCount}건</div></div><button onClick={()=>setNoticeOpen(false)} className="grid size-7 place-items-center rounded-md text-slate-400 hover:bg-slate-100"><X size={15}/></button></div><div className="max-h-96 overflow-y-auto">{alertCount===0?<div className="px-4 py-8 text-center text-sm text-slate-400">확인할 알림이 없습니다.</div>:<>{paymentAlerts.slice(0,8).map(a=><div key={a.id} className="border-b border-slate-100 px-4 py-3"><div className="flex justify-between"><b className="text-sm">수임료 · {a.customer?.name||"삭제된 고객"}</b><span className="text-xs font-semibold text-blue-700">{a.dueAmount.toLocaleString()}원</span></div><div className="mt-1 text-[11px] text-slate-400">{a.dueDate} · {a.status}</div></div>)}{repaymentAlerts.slice(0,8).map(a=><div key={a.id} className="border-b border-slate-100 px-4 py-3"><div className="flex justify-between"><b className="text-sm">상환 · {a.customer?.name||"삭제된 고객"}</b><span className="text-xs font-semibold text-amber-700">{a.amount.toLocaleString()}원</span></div><div className="mt-1 text-[11px] text-slate-400">{a.lenderName} · {a.dueDate} · {a.status}</div></div>)}</>}</div></div>}</div>
  <div className="ml-1 hidden text-right sm:block"><div className="text-xs font-semibold text-slate-800">{kstDate()}</div><div className="text-[11px] text-slate-400">KST</div></div></div>
  </div>
  {unclassifiedLeadCount>0&&<div className="flex min-w-0 flex-wrap gap-2 px-4 pb-3 lg:px-7">
  {unclassifiedLeadCount>0&&<button type="button" onClick={()=>router.push("/leads")} className="new-db-alert-pulse flex min-h-9 w-full min-w-0 max-w-full items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-left whitespace-normal break-keep shadow-sm transition hover:border-amber-400 hover:bg-amber-100 sm:w-auto sm:px-3" title={`신규 DB ${unclassifiedLeadCount}건 · DB 관리 화면으로 이동`} aria-live="polite">
   <span className="relative grid size-5 shrink-0 place-items-center rounded-full bg-amber-500 text-white"><Inbox size={12}/><span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-red-500"/></span>
   <span className="min-w-0 flex-1 whitespace-normal break-keep text-[11px] font-bold leading-5 text-amber-950">신규 DB가 입고되었습니다. 확인 바랍니다.</span>
   <span className="ml-auto shrink-0 rounded-full bg-amber-600 px-1.5 py-0.5 text-[10px] font-black leading-none text-white">{unclassifiedLeadCount>99?"99+":unclassifiedLeadCount}</span>
  </button>}
  </div>}
 </header>
}
