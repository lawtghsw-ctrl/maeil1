"use client";

import {useState} from "react";
import {Customer,Manager} from "@/components/store";
import {Button} from "@/components/ui";
import {CustomerTextImport} from "@/components/customer-text-import";
import {buildSalaryInstallmentPlan,SalaryInstallmentPlan} from "@/lib/installment-plan";
import {formatBirthNumber,formatPhone,won} from "@/lib/utils";

const field="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-base outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 sm:h-10 sm:text-sm";
const textarea="min-h-28 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-base outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 sm:text-sm";
const activeManagers:Manager[]=["신홍규","이중호"];
const staffManager=(v:Manager)=>String(v||"").trim()||"신홍규";
const managerOptions=(current?:Manager)=>{const value=staffManager(current||"");return activeManagers.includes(value)?activeManagers:[value,...activeManagers]};
function NumberInput({value,onChange,min=0,max,disabled=false}:{value:number;onChange:(v:number)=>void;min?:number;max?:number;disabled?:boolean}){const display=value?value.toLocaleString("ko-KR"):"";return <input inputMode="numeric" disabled={disabled} className={`${field} ${disabled?"bg-slate-100 text-slate-500":""}`} value={display} placeholder="0" onChange={e=>{const raw=e.target.value.replace(/[^0-9-]/g,"");const n=raw===""?0:Number(raw);let next=Number.isFinite(n)?Math.max(min,n):min;if(max!==undefined)next=Math.min(max,next);onChange(next)}}/>}
function Label({text,children}:{text:string;children:React.ReactNode}){return <label className="text-sm font-semibold text-slate-700">{text}<div className="mt-1.5">{children}</div></label>}
function SectionTitle({title,description}:{title:string;description?:string}){return <div className="mb-3"><div className="text-sm font-black text-slate-900">{title}</div>{description&&<div className="mt-1 text-xs leading-5 text-slate-500">{description}</div>}</div>}

export function CustomerFormFields({open,form,setForm,editing=false,showTextImport=true,onClose,onSave,saveLabel}:{open:boolean;form:Omit<Customer,"id">;setForm:(v:Omit<Customer,"id">)=>void;editing?:boolean;showTextImport?:boolean;onClose:()=>void;onSave:()=>void;saveLabel?:string}){
 const [calculated,setCalculated]=useState<{signature:string;plan:SalaryInstallmentPlan}|null>(null);
 const autoEnabled=form.autoCreateInstallments!==false;
 const calculationSignature=(value:Omit<Customer,"id">)=>JSON.stringify([value.contractAmount,value.prepaidAmount,value.monthlyNetSalary||0,value.salaryDay||0,value.contractDate||value.createdAt]);
 const currentSignature=calculationSignature(form);
 const plan=calculated?.signature===currentSignature?calculated.plan:null;
 function patch(next:Partial<Omit<Customer,"id">>){setForm({...form,...next})}
 function calculate(){
  if(form.prepaidAmount>form.contractAmount)return window.alert("선납금은 계약금액보다 클 수 없습니다.");
  if((form.monthlyNetSalary||0)<=0||(form.salaryDay||0)<1||(form.salaryDay||0)>31)return window.alert("세후 월급여와 급여일(1~31일)을 입력해주세요.");
  const nextPlan=buildSalaryInstallmentPlan({contractAmount:form.contractAmount,prepaidAmount:form.prepaidAmount,monthlyNetSalary:form.monthlyNetSalary||0,salaryDay:form.salaryDay||0,baseDate:form.contractDate||form.createdAt});
  if(!nextPlan.rows.length&&form.contractAmount>form.prepaidAmount)return window.alert("계산할 수 없습니다. 계약일과 급여를 확인해주세요. 분납 횟수가 지나치게 많다면 급여 입력값을 확인해주세요.");
  setCalculated({signature:currentSignature,plan:nextPlan});
  setForm({...form,installmentMonths:nextPlan.months});
 }
 function submit(){
  if(form.contractAmount>0&&form.prepaidAmount>form.contractAmount)return window.alert("선납금은 계약금액보다 클 수 없습니다.");
  if(!editing&&autoEnabled&&!plan)return window.alert("계약금액, 선납금, 세후 월급여 또는 급여일 입력 후 [계산하기]를 눌러주세요. 계산 후 값을 수정했다면 다시 계산해야 합니다.");
  if(!editing&&autoEnabled&&form.contractAmount>form.prepaidAmount&&!plan?.rows.length)return window.alert("자동 분납 일정을 만들려면 올바른 세후 월급여와 급여일을 입력하고 [계산하기]를 눌러주세요.");
  onSave();
 }
 return <div className="space-y-5">
  {!editing&&showTextImport&&<div className="rounded-2xl border border-blue-100 bg-blue-50/40 p-4"><CustomerTextImport open={open} form={form} setForm={setForm}/></div>}
  <section className="rounded-2xl border border-slate-200 bg-slate-50/35 p-4 sm:p-5">
   <SectionTitle title="기본정보" description="고객 식별정보와 담당자를 한 번에 확인할 수 있게 배치했습니다."/>
   <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
    <Label text="등록일"><input type="date" className={field} value={form.createdAt} onChange={e=>patch({createdAt:e.target.value})}/></Label>
    <Label text="고객명"><input className={field} value={form.name} onChange={e=>patch({name:e.target.value})}/></Label>
    <Label text="연락처"><input className={field} value={form.phone} onChange={e=>patch({phone:formatPhone(e.target.value)})} inputMode="numeric" placeholder="010-1234-5678"/></Label>
    <Label text="주소"><input className={field} value={form.address} onChange={e=>patch({address:e.target.value})} placeholder="계약서에 입력할 주소"/></Label>
    <Label text="생년월일/주민번호"><input className={field} value={form.birthNumber} onChange={e=>patch({birthNumber:formatBirthNumber(e.target.value)})} inputMode="numeric" placeholder="000000-0000000"/></Label>
    <Label text="영업 담당자"><select className={field} value={form.manager} onChange={e=>patch({manager:e.target.value as Manager})}>{managerOptions(form.manager).map(m=><option key={m}>{m}</option>)}</select></Label>
    <Label text="조율 담당자"><select className={field} value={form.coordinationManager} onChange={e=>patch({coordinationManager:e.target.value as Manager})}>{managerOptions(form.coordinationManager).map(m=><option key={m}>{m}</option>)}</select></Label>
   </div>
  </section>
  <section className="rounded-2xl border border-blue-200 bg-blue-50/30 p-4 sm:p-5">
   <SectionTitle title="계약 · 분납 자동계산" description="금액과 급여일을 모두 입력한 다음 [계산하기]를 눌러 분납표를 생성합니다. 수정 시 다시 계산해야 합니다."/>
   <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
    <Label text="계약일"><input type="date" className={field} value={form.contractDate} onChange={e=>patch({contractDate:e.target.value})}/></Label>
    <Label text="계약금액"><NumberInput value={form.contractAmount} onChange={v=>patch({contractAmount:v})}/></Label>
    <Label text="선납금"><NumberInput value={form.prepaidAmount} onChange={v=>patch({prepaidAmount:v})}/></Label>
    <Label text="세후 월급여"><NumberInput value={form.monthlyNetSalary||0} onChange={v=>patch({monthlyNetSalary:v})}/></Label>
    <Label text="급여일 (1~31일)"><NumberInput min={1} max={31} value={form.salaryDay||0} onChange={v=>patch({salaryDay:v})}/></Label>
    <Label text="월 15% 기준액"><input className={`${field} bg-slate-100 font-bold text-blue-700`} value={plan?.monthlyTarget?won(plan.monthlyTarget):"-"} disabled/></Label>
    <Label text="자동 분납기간"><input className={`${field} bg-slate-100 font-bold`} value={editing?(form.installmentMonths?`${form.installmentMonths}개월`:"-"):(plan?.months?`${plan.months}개월`:"-")} disabled/></Label>
    <Label text="업체당 단가"><NumberInput value={form.lenderUnitPrice} onChange={v=>patch({lenderUnitPrice:v})}/></Label>
    <Label text="업체수"><NumberInput value={form.lenderCount} onChange={v=>patch({lenderCount:v})}/></Label>
   </div>
   <div className="mt-4 flex flex-wrap items-center gap-3"><Button className="bg-blue-600 px-6 text-white hover:bg-blue-700" onClick={calculate}>계산하기</Button><span className="text-xs font-semibold text-slate-600">{plan?"계산 완료 · 아래 분납표를 확인하세요.":"입력 중 자동 계산하지 않습니다. 계산하기를 눌러주세요."}</span></div>
   {!editing&&<label className={`mt-4 flex items-start gap-3 rounded-xl border px-4 py-3 ${autoEnabled?"border-blue-200 bg-white":"border-slate-200 bg-slate-50"}`}><input type="checkbox" checked={autoEnabled} onChange={e=>patch({autoCreateInstallments:e.target.checked})} className="mt-0.5 h-4 w-4 accent-blue-600"/><div><div className="text-sm font-bold text-slate-800">분납 일정 자동 생성</div><div className="mt-0.5 text-xs leading-5 text-slate-500">등록과 동시에 선납금은 완료 입금으로, 나머지 분납은 급여일 기준 예정 일정으로 자동 생성합니다.</div></div></label>}
   {editing&&plan&&<div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">기존 고객 수정: 계산 결과는 미리보기 전용이며, 저장해도 기존 분납 일정은 자동 변경되지 않습니다. 일정 변경은 입금/분납관리에서 진행해주세요.</div>}
   {autoEnabled&&plan&&plan.rows.length>0&&<div className="mt-4 overflow-hidden rounded-xl border border-blue-100 bg-white"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-blue-100 bg-blue-50/60 px-4 py-3"><div className="text-sm font-black text-blue-900">자동 생성 예정표</div><div className="text-xs font-semibold text-blue-700">잔액 {won(plan.remaining)} · {plan.mode==="three_month_equal"?"3개월 균등":"월급여 15%"}</div></div><div className="grid gap-px bg-slate-100 sm:grid-cols-2 xl:grid-cols-3">{plan.rows.map((row,i)=><div key={`${row.dueDate}-${i}`} className="flex items-center justify-between bg-white px-4 py-3 text-sm"><span className="font-semibold text-slate-600">{i+1}회 · {row.dueDate}</span><b>{won(row.amount)}</b></div>)}</div></div>}
   {autoEnabled&&plan&&plan.rows.length===0&&form.contractAmount>form.prepaidAmount&&<div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800">자동 분납을 만들려면 세후 월급여와 급여일을 입력해주세요. 계약일이 없으면 등록일 기준으로 계산합니다.</div>}
  </section>
  <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
   <SectionTitle title="사고 위험 · 메모"/>
   <label className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${form.isAccidentRisk?"border-amber-300 bg-amber-50":"border-slate-200 bg-slate-50"}`}><input type="checkbox" checked={!!form.isAccidentRisk} disabled={!!form.isAccident} onChange={e=>patch({isAccidentRisk:e.target.checked})} className="mt-0.5 h-4 w-4 accent-amber-600"/><div><div className={form.isAccidentRisk?"text-sm font-black text-amber-800":"text-sm font-bold text-slate-700"}>{form.isAccident?"사고자로 등록됨":form.isAccidentRisk?"사고 위험자로 등록":"사고 위험자 등록"}</div><div className="mt-0.5 text-xs leading-5 text-slate-500">위험자로 체크하면 사고자 조회의 ‘사고 위험자’ 탭에 분류됩니다. 실제 사고자 전환은 사고자 조회에서 처리합니다.</div></div></label>
   <div className="mt-4"><Label text="메모"><textarea className={textarea} value={form.memo} onChange={e=>patch({memo:e.target.value})}/></Label></div>
  </section>
  <div className="sticky bottom-0 -mx-4 -mb-4 flex justify-end gap-2 border-t border-slate-100 bg-white/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:-mb-6 sm:px-6"><Button variant="secondary" onClick={onClose}>취소</Button><Button onClick={submit}>{saveLabel|| (editing?"수정 저장":"등록")}</Button></div>
 </div>
}
