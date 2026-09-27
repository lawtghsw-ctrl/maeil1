"use client";

import {useEffect,useMemo,useRef,useState} from "react";
import {CalendarDays,ChevronLeft,ChevronRight} from "lucide-react";
import {cn} from "@/lib/utils";

function parseDate(value:string){
 const [y,m,d]=value.split("-").map(Number);
 return y&&m&&d?new Date(y,m-1,d):null;
}
function iso(d:Date){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`}
function addMonths(d:Date,n:number){return new Date(d.getFullYear(),d.getMonth()+n,1)}
function todayIso(){return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}
function monthStart(value:string){const d=parseDate(value)||parseDate(todayIso())||new Date();return new Date(d.getFullYear(),d.getMonth(),1)}
function displayDate(value:string){if(!value)return "";const [y,m,d]=value.split("-");return `${y}.${m}.${d}`}

export function DateRangePicker({start,end,onChange,className}:{start:string;end:string;onChange:(start:string,end:string)=>void;className?:string}){
 const [open,setOpen]=useState(false);
 const [cursor,setCursor]=useState(()=>monthStart(start||end));
 const [anchor,setAnchor]=useState<string|null>(null);
 const [draftStart,setDraftStart]=useState(start);
 const [draftEnd,setDraftEnd]=useState(end);
 const root=useRef<HTMLDivElement>(null);

 function closeWithoutApply(){setOpen(false);setAnchor(null);setDraftStart(start);setDraftEnd(end)}
 function toggleOpen(){
  if(open){closeWithoutApply();return}
  setDraftStart(start);setDraftEnd(end);setAnchor(null);setCursor(monthStart(start||end));setOpen(true);
 }

 useEffect(()=>{if(!open)return;const close=(e:MouseEvent)=>{if(root.current&&!root.current.contains(e.target as Node))closeWithoutApply()};document.addEventListener("mousedown",close);return()=>document.removeEventListener("mousedown",close)},[open,start,end]);
 useEffect(()=>{if(!open){setDraftStart(start);setDraftEnd(end);setAnchor(null)}},[start,end,open]);

 const days=useMemo(()=>{const first=new Date(cursor.getFullYear(),cursor.getMonth(),1);const last=new Date(cursor.getFullYear(),cursor.getMonth()+1,0);const list:(Date|null)[]=[];for(let i=0;i<first.getDay();i++)list.push(null);for(let d=1;d<=last.getDate();d++)list.push(new Date(cursor.getFullYear(),cursor.getMonth(),d));while(list.length%7)list.push(null);return list},[cursor]);

 function pick(day:string){
  if(!anchor){setAnchor(day);setDraftStart(day);setDraftEnd("");return}
  const nextStart=day<anchor?day:anchor;
  const nextEnd=day<anchor?anchor:day;
  setDraftStart(nextStart);setDraftEnd(nextEnd);setAnchor(null);
 }
 function quickToday(){const t=todayIso();setDraftStart(t);setDraftEnd(t);setAnchor(null);setCursor(monthStart(t))}
 function quickMonth(){const t=parseDate(todayIso())||new Date();const s=iso(new Date(t.getFullYear(),t.getMonth(),1));const e=iso(new Date(t.getFullYear(),t.getMonth()+1,0));setDraftStart(s);setDraftEnd(e);setAnchor(null);setCursor(monthStart(s))}
 function quickHalf(first:boolean){
  const y=cursor.getFullYear();const m=cursor.getMonth();
  const s=first?new Date(y,m,1):new Date(y,m,16);
  const e=first?new Date(y,m,15):new Date(y,m+1,0);
  setDraftStart(iso(s));setDraftEnd(iso(e));setAnchor(null);
 }
 function apply(){if(!draftStart||!draftEnd)return;onChange(draftStart,draftEnd);setOpen(false);setAnchor(null)}

 return <div ref={root} className={cn("relative",className)}>
  <button type="button" onClick={toggleOpen} className="flex h-10 w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:w-auto sm:min-w-[250px]">
   <span className="flex items-center gap-2"><CalendarDays size={16} className="text-slate-400"/>{start&&end?`${displayDate(start)} ~ ${displayDate(end)}`:start?`${displayDate(start)} ~ 종료일 선택`:"기간 선택"}</span>
  </button>
  {open&&<div className="absolute right-0 z-[85] mt-2 w-[340px] max-w-[calc(100vw-24px)] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
   <div className="mb-3 flex items-center justify-between"><button type="button" onClick={()=>setCursor(addMonths(cursor,-1))} className="grid size-9 place-items-center rounded-lg hover:bg-slate-100"><ChevronLeft size={17}/></button><div className="font-bold">{cursor.getFullYear()}년 {cursor.getMonth()+1}월</div><button type="button" onClick={()=>setCursor(addMonths(cursor,1))} className="grid size-9 place-items-center rounded-lg hover:bg-slate-100"><ChevronRight size={17}/></button></div>
   <div className="mb-1 grid grid-cols-7 text-center text-[11px] font-semibold text-slate-400">{["일","월","화","수","목","금","토"].map(x=><div key={x} className="py-1">{x}</div>)}</div>
   <div className="grid grid-cols-7 gap-y-1">{days.map((d,i)=>{if(!d)return <div key={`e-${i}`} className="h-9"/>;const v=iso(d);const rangeStart=anchor||draftStart;const rangeEnd=anchor?anchor:draftEnd;const low=rangeStart&&rangeEnd?(rangeStart<rangeEnd?rangeStart:rangeEnd):rangeStart;const high=rangeStart&&rangeEnd?(rangeStart<rangeEnd?rangeEnd:rangeStart):rangeStart;const inRange=!!low&&!!high&&v>=low&&v<=high;const edge=v===low||v===high;const isToday=v===todayIso();return <button type="button" key={v} onClick={()=>pick(v)} className={cn("mx-auto grid size-9 place-items-center rounded-lg text-sm transition hover:bg-blue-50 hover:text-blue-700",inRange&&"bg-blue-50 text-blue-700",edge&&"bg-blue-600 font-bold text-white hover:bg-blue-600 hover:text-white",isToday&&!edge&&"font-bold text-blue-700")}>{d.getDate()}</button>})}</div>
   <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">{anchor?`${displayDate(anchor)}부터 조회할 종료일을 선택하세요.`:draftStart&&draftEnd?`${displayDate(draftStart)} ~ ${displayDate(draftEnd)} 선택됨 · 확인을 눌러 적용하세요.`:"시작일을 누른 뒤 종료일을 선택하세요."}</div>
   <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
    <div className="flex gap-2"><button type="button" onClick={()=>quickHalf(true)} className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-semibold hover:bg-slate-50">1분기</button><button type="button" onClick={()=>quickHalf(false)} className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-semibold hover:bg-slate-50">2분기</button></div>
    <div className="flex gap-2"><button type="button" onClick={quickToday} className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-semibold hover:bg-slate-50">오늘</button><button type="button" onClick={quickMonth} className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-semibold hover:bg-slate-50">이번달</button><button type="button" onClick={apply} disabled={!draftStart||!draftEnd} className="h-8 rounded-lg bg-blue-600 px-4 text-xs font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300">확인</button></div>
   </div>
  </div>}
 </div>
}
