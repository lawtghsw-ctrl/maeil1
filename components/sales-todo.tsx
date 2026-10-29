"use client";

import {useEffect,useMemo,useState} from "react";
import {ListTodo,TriangleAlert,X} from "lucide-react";
import {useRouter} from "next/navigation";
import {createClient} from "@/lib/supabase/client";
import {DAILY_NO_ANSWER_THRESHOLD,LeadCallLog,LeadStage,callWarning,kstDateKey,normalizeLeadStage} from "@/lib/lead-workflow";

type TodoLead={id:string;source:"meta"|"external";sourceLabel:string;name:string;phone:string;stage:LeadStage;createdAt:string};
const supabase=createClient();
function formatPhone(v:string){const d=String(v||"").replace(/\D/g,"");if(d.length===11)return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;return v||"-"}

export function SalesTodoButton(){
 const router=useRouter();const [open,setOpen]=useState(false);const [leads,setLeads]=useState<TodoLead[]>([]);const [logs,setLogs]=useState<LeadCallLog[]>([]);const today=kstDateKey();
 async function load(){
  const [meta,call]=await Promise.all([
   supabase.from("meta_leads").select("id,customer_name,phone_number,lead_stage,lead_result,status,created_at").eq("status","신규"),
   supabase.from("lead_call_logs").select("*").order("created_at",{ascending:false}),
  ]);
  if(!meta.error){
   const next:TodoLead[]=[];
   for(const x of meta.data||[])next.push({id:x.id,source:"meta",sourceLabel:"로파워DB",name:x.customer_name||"이름 없음",phone:formatPhone(x.phone_number||""),stage:normalizeLeadStage(x.lead_stage||x.lead_result),createdAt:x.created_at||""});
   setLeads(next);
  }
  if(!call.error)setLogs((call.data||[]).map((x:any)=>({id:x.id,leadSource:x.lead_source,leadId:x.lead_id,result:x.call_result,note:x.note||"",createdAt:x.created_at||""})));
 }
 useEffect(()=>{
  void load();
  const handler=(event:Event)=>{const table=(event as CustomEvent<{table?:string}>).detail?.table;if(table==="meta_leads"||table==="lead_call_logs")void load()};
  window.addEventListener("admin:data-changed",handler);
  const timer=window.setInterval(()=>void load(),30000);
  return()=>{window.removeEventListener("admin:data-changed",handler);window.clearInterval(timer)}
 },[]);
 const todos=useMemo(()=>leads.map(lead=>{const own=logs.filter(log=>log.leadSource===lead.source&&log.leadId===lead.id);return {lead,warning:callWarning(own,lead.stage,today)}}).filter(x=>x.warning.active).sort((a,b)=>a.lead.createdAt.localeCompare(b.lead.createdAt)),[leads,logs,today]);
 return <div className="relative">
  <button type="button" onClick={()=>setOpen(v=>!v)} title="영업 투두리스트" className="relative grid size-9 place-items-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"><ListTodo size={17}/>{todos.length>0&&<span className="absolute right-1 top-1 min-w-4 rounded-full bg-red-600 px-1 text-center text-[9px] font-bold leading-4 text-white">{todos.length>9?"9+":todos.length}</span>}</button>
  {open&&<div className="absolute right-0 top-11 z-50 w-[calc(100vw-24px)] max-w-[420px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
   <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><div><div className="flex items-center gap-2 text-sm font-bold"><TriangleAlert size={15} className="text-red-600"/>영업 투두리스트</div><div className="mt-0.5 text-[11px] text-slate-400">전체 직원 공통 · 오늘 콜 관리 필요 {todos.length}건</div></div><button onClick={()=>setOpen(false)} className="grid size-7 place-items-center rounded-md text-slate-400 hover:bg-slate-100"><X size={15}/></button></div>
   <div className="max-h-[430px] overflow-y-auto">{todos.length===0?<div className="px-4 py-10 text-center text-sm text-slate-400">오늘 콜 관리가 필요한 DB가 없습니다.</div>:todos.map(({lead,warning})=><div key={`${lead.source}-${lead.id}`} className="border-b border-slate-100 px-4 py-3 last:border-0"><div className="flex items-start justify-between gap-3"><button className="min-w-0 text-left" onClick={()=>{setOpen(false);router.push("/leads")}}><div className="flex flex-wrap items-center gap-2"><b className="text-sm text-slate-900">{lead.name}</b><span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">{lead.sourceLabel}</span><span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">{lead.stage}</span></div><div className="mt-1 text-xs text-slate-500">{lead.phone} · 오늘 부재 {warning.noAnswerCount}/{DAILY_NO_ANSWER_THRESHOLD} · {warning.remaining}회 남음</div></button></div></div>)}</div>
   <button type="button" onClick={()=>{setOpen(false);router.push("/leads")}} className="w-full border-t border-slate-100 px-4 py-3 text-center text-xs font-bold text-blue-700 hover:bg-blue-50">DB 관리에서 전체 확인</button>
  </div>}
 </div>;
}
