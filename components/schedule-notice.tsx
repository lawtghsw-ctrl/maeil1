"use client";

import {useEffect,useMemo,useState} from "react";
import {Check,Copy,RefreshCw} from "lucide-react";
import {Button,Modal} from "@/components/ui";
import {Customer,Payment,Repayment,useAdminStore} from "@/components/store";
import {paymentRemaining} from "@/lib/payment-metrics";
import {BANK_NOTICE,NOTICE_SENDER_NAME} from "@/lib/brand";

type NoticeMode="all"|"d3"|"d1";

function money(value:number){return `${Math.max(0,Number(value||0)).toLocaleString("ko-KR")}원`}
function today(){return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}
function dateLabel(value:string){
 if(!value)return "날짜 미정";
 const [y,m,d]=value.split("-").map(Number);
 if(!y||!m||!d)return value;
 const weekday=["일","월","화","수","목","금","토"][new Date(y,m-1,d).getDay()];
 return `${String(m).padStart(2,"0")}월 ${String(d).padStart(2,"0")}일(${weekday})`;
}
function paymentStatus(status:Payment["status"]){
 if(status==="완료")return "✅ 완료";
 if(status==="연체")return "⚠️ 연체";
 if(status==="미납")return "⚠️ 미납";
 return "예정";
}
function repaymentStatus(status:Repayment["status"]){
 if(status==="상환완료")return "✅ 완료";
 if(status==="종결")return "✅ 종결";
 if(status==="연체")return "⚠️ 연체";
 if(status==="보류")return "보류";
 if(status==="추심")return "🚨 추심";
 return "예정";
}
function hasRescheduledChild(payments:Payment[],id:string){return payments.some(p=>p.rescheduledFromId===id)}
function paymentAmount(p:Payment){return Math.max(0,paymentRemaining(p)||p.dueAmount||0)}

export function ScheduleNoticeModal({open,customer,onClose}:{open:boolean;customer:Customer;onClose:()=>void}){
 const s=useAdminStore();
 const paymentRows=useMemo(()=>s.payments
  .filter(p=>!customer.isAccident&&p.customerId===customer.id&&p.status!=="환불"&&p.scheduleType!=="환수"&&p.scheduleType!=="추가계약")
  .filter(p=>p.status==="완료"||!hasRescheduledChild(s.payments,p.id))
  .sort((a,b)=>(a.dueDate||"").localeCompare(b.dueDate||"")||(a.createdTime||"").localeCompare(b.createdTime||"")),[s.payments,customer.id,customer.isAccident]);
 const repaymentRows=useMemo(()=>s.repayments
  .filter(r=>!customer.isAccident&&r.customerId===customer.id)
  .sort((a,b)=>(a.dueDate||"").localeCompare(b.dueDate||"")||(a.createdTime||"").localeCompare(b.createdTime||"")),[s.repayments,customer.id,customer.isAccident]);
 const nextPayment=useMemo(()=>{
  const unresolved=paymentRows.filter(p=>p.status!=="완료"&&p.status!=="환불"&&!!p.dueDate);
  return unresolved.find(p=>p.dueDate>=today())||unresolved[0]||null;
 },[paymentRows]);
 const [mode,setMode]=useState<NoticeMode>("all");
 const [selectedPayments,setSelectedPayments]=useState<string[]>([]);
 const [selectedRepayments,setSelectedRepayments]=useState<string[]>([]);
 const [text,setText]=useState("");
 const [copied,setCopied]=useState(false);

 function buildAllNotice(paymentIds=selectedPayments,repaymentIds=selectedRepayments){
  const pays=paymentRows.filter(p=>paymentIds.includes(p.id));
  const repays=repaymentRows.filter(r=>repaymentIds.includes(r.id));
  const paidContractAmount=s.payments
   .filter(p=>p.customerId===customer.id&&p.status!=="환불"&&p.scheduleType!=="환수")
   .reduce((sum,p)=>sum+(p.paidAmount>0?p.paidAmount:(p.status==="완료"?p.dueAmount:0)),0);
  const remainingPayment=Math.max(0,(customer.contractAmount||0)-paidContractAmount);
  const remainingRepayment=repays.filter(r=>r.status!=="상환완료"&&r.status!=="종결").reduce((sum,r)=>sum+(r.amount||0),0);
  const lines:string[]=[
   "📌 납부 및 상환 일정 안내",
   "",
   `${customer.name} 고객님, 현재 등록되어 있는 납부 및 상환 일정을 안내드립니다.`,
   "날짜와 금액을 확인 부탁드립니다.",
   "",
   "■ 수임료 납부 일정",
   "",
  ];
  if(pays.length){
   pays.forEach(p=>{
    const amount=p.status==="완료"?(p.paidAmount||p.dueAmount):paymentAmount(p);
    lines.push(`${dateLabel(p.dueDate)} — ${money(amount)} ${paymentStatus(p.status)}`);
   });
  }else lines.push("등록된 납부 일정이 없습니다.");
  lines.push("",`남은 납부 예정금액: ${money(remainingPayment)}`,"","■ 업체 상환 일정","");
  if(repays.length){
   repays.forEach(r=>lines.push(`${dateLabel(r.dueDate)} — ${r.lenderName||"업체명 미입력"} — ${money(r.status==="종결"?0:r.amount)} ${repaymentStatus(r.status)}`));
  }else lines.push("등록된 상환 일정이 없습니다.");
  lines.push("",`남은 상환 예정금액 합계: ${money(remainingRepayment)}`,"","※ 완료·종결된 일정은 처리된 내역이며, 예정 일정은 현재 등록된 일정을 기준으로 안내드립니다.","","일정 변경 또는 납부가 어려울 것으로 예상되는 경우에는 예정일 전에 담당자에게 말씀해주세요.","","※ 업체 상환 일정은 조율 진행 상황에 따라 변경될 수 있습니다.");
  if(BANK_NOTICE)lines.push("",BANK_NOTICE);
  return lines.join("\n");
 }

 function buildInstallmentNotice(kind:"d3"|"d1"){
  if(!nextPayment)return [
   kind==="d3"?"📌 [분납 납부 안내 · D-3]":"📌 [분납 납부일 최종 안내 · D-1]",
   "",
   `${customer.name}님에게 안내할 미완료 분납 일정이 등록되어 있지 않습니다.`,
  ].join("\n");
  const due=dateLabel(nextPayment.dueDate);
  const amount=money(paymentAmount(nextPayment));
  if(kind==="d3")return [
   "📌 [분납 납부 안내 · D-3]",
   "",
   `안녕하세요, ${customer.name}님. ${NOTICE_SENDER_NAME}입니다.`,
   "",
   `3일 뒤인 ${due}은 사채해결 사건 관련 분납금 ${amount} 납부 예정일입니다.`,
   "",
   "원활한 업무 진행을 위해 약정된 납부일을 꼭 지켜주시길 부탁드리며, 납부일 하루 전 다시 한번 안내 메시지가 발송될 예정입니다.",
   "",
   "본 메시지를 확인하셨다면 “확인했습니다”라고 간단히 회신 부탁드립니다.",
   "",
   "별도의 회신 없이 납부일까지 연락이 되지 않거나 분납금이 미납될 경우, 담당자가 납부 의사를 확인하기 위해 별도로 연락드릴 수 있으며 약정 내용 및 사건 진행 상황에 따라 수임관계 또는 업무 진행에 영향이 있을 수 있습니다.",
   "",
   "납부가 어려운 사정이 있으신 경우에는 예정일 전에 담당자에게 말씀해주시기 바랍니다.",
   "",
   "확인 후 회신 부탁드립니다.",
   "감사합니다.",
   "",
   NOTICE_SENDER_NAME,
  ].join("\n");
  return [
   "📌 [분납 납부일 최종 안내 · D-1]",
   "",
   `안녕하세요, ${customer.name}님. ${NOTICE_SENDER_NAME}입니다.`,
   "",
   `내일 ${due}은 사채해결 사건 관련 분납금 ${amount} 납부 예정일입니다.`,
   "",
   "약정된 납부일에 정상적으로 납부될 수 있도록 다시 한번 확인 부탁드립니다.",
   "",
   "본 메시지를 확인하셨다면 “확인했습니다”라고 간단히 회신 부탁드립니다.",
   "",
   "사전 협의 없이 납부가 이루어지지 않거나 연락이 되지 않을 경우 미납 상태로 처리될 수 있으며, 약정 내용 및 사건 진행 상황에 따라 업무 진행 또는 수임관계에 영향이 있을 수 있으니 납부일을 준수해주시기 바랍니다.",
   "",
   "납부가 어려운 사정이 있으신 경우에는 납부일이 지나기 전에 반드시 담당자에게 연락해주시기 바랍니다.",
   "",
   "확인 후 회신 부탁드립니다.",
   "감사합니다.",
   "",
   NOTICE_SENDER_NAME,
  ].join("\n");
 }

 function buildForMode(nextMode:NoticeMode,paymentIds=selectedPayments,repaymentIds=selectedRepayments){
  if(nextMode==="d3")return buildInstallmentNotice("d3");
  if(nextMode==="d1")return buildInstallmentNotice("d1");
  return buildAllNotice(paymentIds,repaymentIds);
 }

 useEffect(()=>{
  if(!open)return;
  const payIds=paymentRows.map(p=>p.id);const repayIds=repaymentRows.map(r=>r.id);
  setMode("all");setSelectedPayments(payIds);setSelectedRepayments(repayIds);setText(buildAllNotice(payIds,repayIds));setCopied(false);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[open,customer.id,paymentRows,repaymentRows]);

 function changeMode(nextMode:NoticeMode){setMode(nextMode);setText(buildForMode(nextMode));setCopied(false)}
 function togglePayment(id:string){const next=selectedPayments.includes(id)?selectedPayments.filter(x=>x!==id):[...selectedPayments,id];setSelectedPayments(next);setText(buildAllNotice(next,selectedRepayments));setCopied(false)}
 function toggleRepayment(id:string){const next=selectedRepayments.includes(id)?selectedRepayments.filter(x=>x!==id):[...selectedRepayments,id];setSelectedRepayments(next);setText(buildAllNotice(selectedPayments,next));setCopied(false)}
 async function copy(){
  try{await navigator.clipboard.writeText(text);setCopied(true);setTimeout(()=>setCopied(false),1800)}catch{
   const area=document.createElement("textarea");area.value=text;area.style.position="fixed";area.style.opacity="0";document.body.appendChild(area);area.select();document.execCommand("copy");document.body.removeChild(area);setCopied(true);setTimeout(()=>setCopied(false),1800);
  }
 }
 return <Modal open={open} title={`${customer.name} · 일정 공지 만들기`} onClose={onClose}>
  <div className="space-y-5">
   <div className="grid grid-cols-3 gap-2 rounded-xl bg-slate-100 p-1.5">
    {([{"id":"all","label":"납부 및 상환 일정"},{"id":"d3","label":"분납 3D"},{"id":"d1","label":"분납 1D"}] as {id:NoticeMode;label:string}[]).map(x=><button key={x.id} type="button" onClick={()=>changeMode(x.id)} className={`rounded-lg px-2 py-2.5 text-xs font-bold transition sm:text-sm ${mode===x.id?"bg-white text-blue-700 shadow-sm ring-1 ring-slate-200":"text-slate-500 hover:bg-white/70 hover:text-slate-700"}`}>{x.label}</button>)}
   </div>

   {mode==="all"?<>
    <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-800">현재 등록된 분납·상환 일정을 자동으로 불러왔습니다. 완료된 일정도 함께 표시되며, 공지에서 빼고 싶은 일정은 체크를 해제하면 됩니다.</div>
    <div className="grid gap-4 lg:grid-cols-2">
     <div className="rounded-xl border border-slate-200 p-4">
      <div className="mb-3 flex items-center justify-between"><b className="text-sm">수임료 납부 일정</b><span className="text-xs text-slate-400">{selectedPayments.length}/{paymentRows.length}건 포함</span></div>
      <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
       {paymentRows.length?paymentRows.map(p=><label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm"><input type="checkbox" checked={selectedPayments.includes(p.id)} onChange={()=>togglePayment(p.id)} className="h-4 w-4 accent-blue-600"/><span className="min-w-0 flex-1"><b>{dateLabel(p.dueDate)}</b><span className="ml-2 text-slate-500">{money(p.status==="완료"?(p.paidAmount||p.dueAmount):paymentAmount(p))}</span></span><span className="shrink-0 text-xs font-semibold">{paymentStatus(p.status)}</span></label>):<div className="py-6 text-center text-sm text-slate-400">등록된 납부 일정이 없습니다.</div>}
      </div>
     </div>
     <div className="rounded-xl border border-slate-200 p-4">
      <div className="mb-3 flex items-center justify-between"><b className="text-sm">업체 상환 일정</b><span className="text-xs text-slate-400">{selectedRepayments.length}/{repaymentRows.length}건 포함</span></div>
      <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
       {repaymentRows.length?repaymentRows.map(r=><label key={r.id} className="flex cursor-pointer items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm"><input type="checkbox" checked={selectedRepayments.includes(r.id)} onChange={()=>toggleRepayment(r.id)} className="h-4 w-4 accent-blue-600"/><span className="min-w-0 flex-1"><b>{dateLabel(r.dueDate)}</b><span className="ml-2 truncate text-slate-500">{r.lenderName||"업체명 미입력"} · {money(r.status==="종결"?0:r.amount)}</span></span><span className={`shrink-0 text-xs font-semibold ${r.status==="추심"?"text-red-600":""}`}>{repaymentStatus(r.status)}</span></label>):<div className="py-6 text-center text-sm text-slate-400">등록된 상환 일정이 없습니다.</div>}
      </div>
     </div>
    </div>
   </>:<div className={`rounded-xl border p-4 ${nextPayment?"border-emerald-100 bg-emerald-50":"border-amber-200 bg-amber-50"}`}>
    {nextPayment?<div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-xs font-bold text-emerald-700">자동 적용 분납 일정</div><div className="mt-1 text-sm font-bold text-slate-900">{dateLabel(nextPayment.dueDate)} · {money(paymentAmount(nextPayment))}</div></div><div className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-500 ring-1 ring-emerald-100">가장 가까운 미완료 일정</div></div>:<div className="text-sm font-semibold text-amber-800">자동으로 불러올 미완료 분납 일정이 없습니다. 입금/분납 관리에서 일정을 먼저 등록해주세요.</div>}
   </div>}

   <div>
    <div className="mb-2 flex items-center justify-between gap-2"><div><b className="text-sm">카카오톡 공지문</b><div className="mt-0.5 text-xs text-slate-400">자동 생성 후 필요한 표현은 직접 수정할 수 있습니다.</div></div><Button variant="secondary" onClick={()=>{setText(buildForMode(mode));setCopied(false)}}><RefreshCw size={14}/>문구 다시 만들기</Button></div>
    <textarea className="min-h-[360px] w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-7 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" value={text} onChange={e=>{setText(e.target.value);setCopied(false)}}/>
   </div>
   <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>닫기</Button><Button onClick={()=>void copy()}>{copied?<Check size={15}/>:<Copy size={15}/>} {copied?"복사 완료":"전체 복사"}</Button></div>
  </div>
 </Modal>
}
