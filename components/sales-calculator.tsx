"use client";

import {useMemo,useState} from "react";
import {Calculator,Copy,X} from "lucide-react";
import {Button,Card} from "@/components/ui";
import {won} from "@/lib/utils";

const inputClass="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100";
const moneyInput=(v:number)=>v?Math.round(v).toLocaleString("ko-KR"):"";
function parseMoney(v:string){const n=Number(v.replace(/[^0-9-]/g,""));return Number.isFinite(n)?Math.max(0,n):0}

const PERIOD_OPTIONS=[
 {key:"1w",label:"1주",days:7},
 {key:"2w",label:"2주",days:14},
 {key:"3w",label:"3주",days:21},
 {key:"4w",label:"4주",days:28},
 {key:"2m",label:"2달",days:60},
 {key:"custom",label:"직접입력",days:0},
] as const;

type PeriodKey=(typeof PERIOD_OPTIONS)[number]["key"];

function MoneyField({label,value,onChange,placeholder="0"}:{label:string;value:number;onChange:(v:number)=>void;placeholder?:string}){
 return <label className="text-sm font-semibold text-slate-700">{label}<input inputMode="numeric" className={`${inputClass} mt-1.5`} value={moneyInput(value)} placeholder={placeholder} onChange={e=>onChange(parseMoney(e.target.value))}/></label>
}

function NumberField({label,value,onChange,suffix}:{label:string;value:number;onChange:(v:number)=>void;suffix?:string}){
 return <label className="text-sm font-semibold text-slate-700">{label}<div className="relative mt-1.5"><input inputMode="numeric" className={`${inputClass} ${suffix?"pr-10":""}`} value={value?String(value):""} placeholder="0" onChange={e=>{const n=Number(e.target.value.replace(/[^0-9.]/g,""));onChange(Number.isFinite(n)?Math.max(0,n):0)}}/>{suffix&&<span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400">{suffix}</span>}</div></label>
}

export function SalesCalculator({open,onClose}:{open:boolean;onClose:()=>void}){
 const [unitFee,setUnitFee]=useState(0);
 const [lenderCount,setLenderCount]=useState(0);
 const [dailyExtensionFee,setDailyExtensionFee]=useState(150000);
 const [period,setPeriod]=useState<PeriodKey>("1w");
 const [customDays,setCustomDays]=useState(7);

 const averageDays=useMemo(()=>{
  if(period==="custom")return Math.max(0,Math.round(customDays));
  return PERIOD_OPTIONS.find(x=>x.key===period)?.days||0;
 },[period,customDays]);

 const periodLabel=useMemo(()=>{
  if(period==="custom")return `${averageDays}일`;
  return PERIOD_OPTIONS.find(x=>x.key===period)?.label||"-";
 },[period,averageDays]);

 const result=useMemo(()=>{
  const totalFee=unitFee*lenderCount;
  const expectedExtensionCost=lenderCount*dailyExtensionFee*averageDays;
  const valueDifference=expectedExtensionCost-totalFee;
  const multiple=totalFee>0?expectedExtensionCost/totalFee:0;
  return{totalFee,expectedExtensionCost,valueDifference,multiple};
 },[unitFee,lenderCount,dailyExtensionFee,averageDays]);

 if(!open)return null;

 const salesMessage=result.expectedExtensionCost<=0
  ?"업체 수와 평균 연장기간을 입력하면 예상 연장비와 총 수임료를 비교한 상담 문구가 자동으로 만들어집니다."
  :result.valueDifference>=0
   ?`현재 입력 기준으로 업체 ${lenderCount}곳이 평균 ${periodLabel} 연장되고, 업체당 하루 연장비가 ${won(dailyExtensionFee)}이라고 가정하면 단순 연장비 부담은 약 ${won(result.expectedExtensionCost)}입니다. 업체당 수임단가 ${won(unitFee)}, 총 수임료 ${won(result.totalFee)}과 비교하면 약 ${won(result.valueDifference)}의 비용 차이가 있으며, 단순 연장비 기준으로 총 수임료 대비 약 ${result.multiple.toFixed(2)}배 수준의 기대가치를 설명할 수 있습니다.`
   :`현재 입력 기준 단순 예상 연장비는 약 ${won(result.expectedExtensionCost)}이고 총 수임료는 ${won(result.totalFee)}입니다. 이 경우 연장비 절감만으로 수임료 전체를 설명하기보다는 조율·대응·업체관리 등 제공 서비스 범위를 함께 안내하는 것이 적절합니다.`;

 async function copyMessage(){
  try{await navigator.clipboard.writeText(salesMessage);alert("영업 멘트를 복사했습니다.")}catch{alert("복사하지 못했습니다. 문구를 직접 선택해 복사해주세요.")}
 }

 function reset(){setUnitFee(0);setLenderCount(0);setDailyExtensionFee(150000);setPeriod("1w");setCustomDays(7)}

 return <div data-admin-edit-lock="true" className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/45 p-4">
  <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl">
   <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-4">
    <div><div className="flex items-center gap-2"><Calculator size={19} className="text-blue-600"/><h2 className="text-lg font-bold">영업 계산기</h2></div><p className="mt-1 text-xs text-slate-500">고객정보와 연결되지 않는 상담용 기대가치 계산기입니다.</p></div>
    <Button variant="secondary" onClick={onClose}><X size={15}/>닫기</Button>
   </div>
   <div className="space-y-5 p-5">
    <Card className="p-5">
     <div className="mb-4"><div className="font-bold">상담 조건 입력</div><div className="mt-1 text-xs leading-5 text-slate-500">연장비는 업체당 하루 150,000원을 기본값으로 사용합니다. 평균 연장기간은 기간 버튼을 선택하거나 일수를 직접 입력할 수 있습니다.</div></div>
     <div className="grid gap-4 sm:grid-cols-2">
      <MoneyField label="업체당 수임단가" value={unitFee} onChange={setUnitFee}/>
      <NumberField label="업체 수" value={lenderCount} onChange={v=>setLenderCount(Math.round(v))} suffix="곳"/>
      <MoneyField label="업체당 1일 연장비" value={dailyExtensionFee} onChange={setDailyExtensionFee}/>
      <div>
       <div className="text-sm font-semibold text-slate-700">평균 연장기간</div>
       <div className="mt-1.5 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {PERIOD_OPTIONS.map(option=><button key={option.key} type="button" onClick={()=>setPeriod(option.key)} className={`h-10 rounded-lg border px-2 text-xs font-semibold transition ${period===option.key?"border-blue-500 bg-blue-50 text-blue-700":"border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>{option.label}</button>)}
       </div>
       {period==="custom"&&<div className="mt-2"><NumberField label="평균 연장일수 직접입력" value={customDays} onChange={v=>setCustomDays(Math.round(v))} suffix="일"/></div>}
       {period!=="custom"&&<div className="mt-2 text-xs text-slate-500">선택 기간: <b className="text-slate-700">{periodLabel} = {averageDays}일</b></div>}
      </div>
     </div>
    </Card>

    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
     <ResultCard label="예상 연장비 부담" value={won(result.expectedExtensionCost)} sub={`${lenderCount}곳 × ${won(dailyExtensionFee)}/일 × ${averageDays}일`} accent="blue"/>
     <ResultCard label="총 수임료" value={won(result.totalFee)} sub={`${won(unitFee)} × ${lenderCount}곳`}/>
     <ResultCard label="예상 비용 차이" value={won(result.valueDifference)} sub="예상 연장비 - 총 수임료" accent={result.valueDifference>=0?"green":"amber"}/>
     <ResultCard label="수임료 대비 기대가치" value={result.totalFee>0?`${result.multiple.toFixed(2)}배`:"-"} sub="예상 연장비 ÷ 총 수임료" accent="blue"/>
    </div>

    <Card className="p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="font-bold">영업 상담용 문구</div><div className="mt-2 text-sm leading-7 text-slate-700">{salesMessage}</div></div><Button variant="secondary" className="shrink-0" onClick={()=>void copyMessage()}><Copy size={15}/>멘트 복사</Button></div></Card>

    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">※ 이 계산은 입력한 업체 수·1일 연장비·평균 연장일수를 단순 계산한 상담 참고값입니다. 실제 연장 발생 여부, 발생 기간 및 비용을 보장하는 수치로 안내하지 않습니다.</div>
    <div className="flex justify-end"><Button variant="secondary" onClick={reset}>입력 초기화</Button></div>
   </div>
  </div>
 </div>
}

function ResultCard({label,value,sub,accent="normal"}:{label:string;value:string;sub:string;accent?:"normal"|"blue"|"green"|"amber"}){
 const cls=accent==="blue"?"border-blue-100 bg-blue-50/60 text-blue-900":accent==="green"?"border-emerald-100 bg-emerald-50/60 text-emerald-900":accent==="amber"?"border-amber-100 bg-amber-50/60 text-amber-900":"border-slate-200 bg-white text-slate-900";
 return <div className={`rounded-xl border p-4 ${cls}`}><div className="text-xs font-semibold opacity-70">{label}</div><div className="mt-2 text-xl font-bold">{value}</div><div className="mt-1 text-[11px] opacity-65">{sub}</div></div>
}
