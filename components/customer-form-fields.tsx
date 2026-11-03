"use client";

import {Customer,Manager} from "@/components/store";
import {Button} from "@/components/ui";
import {CustomerTextImport} from "@/components/customer-text-import";
import {buildInstallmentPlan,customerInstallmentSignature,getCustomerInstallmentPlan,getCustomerInstallmentTotal} from "@/lib/installment-plan";
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
 const autoEnabled=form.autoCreateInstallments!==false;
 const totalAmount=getCustomerInstallmentTotal(form);
 const currentSignature=customerInstallmentSignature(form);
 const planRows=form.installmentPlanSignature===currentSignature?form.installmentRows:undefined;
 const previewTotal=planRows?.reduce((sum,row)=>sum+row.amount,0)||0;
 const firstDate=form.installmentFirstDate||form.contractDate||form.createdAt;
 const monthlyAmount=form.installmentMonths>0?Math.floor(totalAmount/form.installmentMonths):0;
 function patch(next:Partial<Omit<Customer,"id">>){setForm({...form,...next})}
 function calculate(){
  if(form.prepaidAmount>form.contractAmount)return window.alert("선납금은 계약금액보다 클 수 없습니다.");
  try{
   const plan=buildInstallmentPlan({totalAmount,months:form.installmentMonths,firstPaymentDate:firstDate});
   const next={...form,installmentMonths:plan.months,installmentRows:plan.rows};
   setForm({...next,installmentPlanSignature:customerInstallmentSignature(next)});
  }catch(error){window.alert(error instanceof Error?error.message:"분납 입력값을 확인해주세요.")}
 }
 function updatePlanRow(index:number,next:Partial<{dueDate:string;amount:number}>){
  if(!planRows)return;
  patch({installmentRows:planRows.map((row,i)=>i===index?{...row,...next}:row)});
 }
 function submit(){
  if(form.contractAmount>0&&form.prepaidAmount>form.contractAmount)return window.alert("선납금은 계약금액보다 클 수 없습니다.");
  if(!editing){try{getCustomerInstallmentPlan(form)}catch(error){return window.alert(error instanceof Error?error.message:"분납 입력값을 확인해주세요.")}}
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
   <SectionTitle title="계약 · 분납 일정" description={editing?"계약정보를 수정합니다. 기존 납부 일정은 입금/분납관리에서 변경해주세요.":"총 분납금과 개월 수, 첫 납부일을 직접 입력해 일정을 만듭니다."}/>
   <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
    <Label text="계약일"><input type="date" className={field} value={form.contractDate} onChange={e=>patch({contractDate:e.target.value})}/></Label>
    <Label text="계약금액"><NumberInput value={form.contractAmount} onChange={v=>patch({contractAmount:v})}/></Label>
    <Label text="선납금"><NumberInput value={form.prepaidAmount} onChange={v=>patch({prepaidAmount:v})}/></Label>
    {editing&&<Label text="분납 개월 수"><NumberInput max={600} value={form.installmentMonths} onChange={v=>patch({installmentMonths:v})}/></Label>}
    <Label text="업체당 단가"><NumberInput value={form.lenderUnitPrice} onChange={v=>patch({lenderUnitPrice:v})}/></Label>
    <Label text="업체수"><NumberInput value={form.lenderCount} onChange={v=>patch({lenderCount:v})}/></Label>
   </div>
   {!editing&&<label className={"mt-4 flex items-start gap-3 rounded-xl border px-4 py-3 "+(autoEnabled?"border-blue-200 bg-white":"border-slate-200 bg-slate-50")}><input type="checkbox" checked={autoEnabled} onChange={e=>patch({autoCreateInstallments:e.target.checked})} className="mt-0.5 h-4 w-4 accent-blue-600"/><div><div className="text-sm font-bold text-slate-800">등록 시 분납 일정 함께 생성</div><div className="mt-0.5 text-xs leading-5 text-slate-500">선납금은 완료 입금으로, 아래 분납표는 입금 전 예정 일정으로 등록합니다.</div></div></label>}
   {!editing&&autoEnabled&&<div className="mt-4 space-y-4">
    <p className="text-xs text-slate-600">총 분납금의 기본값은 계약금액에서 선납금을 뺀 금액이며, 직접 변경할 수 있습니다.</p>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
     <Label text="총 분납금"><NumberInput value={totalAmount} onChange={v=>patch({installmentTotal:v})}/></Label>
     <Label text="분납 개월 수"><NumberInput min={1} max={600} value={form.installmentMonths} onChange={v=>patch({installmentMonths:v})}/></Label>
     <Label text="첫 납부일"><input type="date" className={field} value={firstDate} onChange={e=>patch({installmentFirstDate:e.target.value})}/></Label>
     <Label text="월 분납금"><input className={field+" bg-slate-100 font-bold text-blue-700"} value={monthlyAmount>0?won(monthlyAmount):"-"} readOnly/></Label>
    </div>
    <p className="text-xs leading-5 text-slate-600">첫 납부일의 일자로 매월 반복합니다{firstDate?" · 매월 "+Number(firstDate.slice(-2))+"일":""}. 해당 날짜가 없는 달은 말일로 잡고, 나누어떨어지지 않는 금액은 마지막 회차에 반영합니다.</p>
    <div className="flex flex-wrap items-center gap-3"><Button onClick={calculate}>일정 만들기</Button><span className="text-xs font-semibold text-slate-600">{planRows?"아래 예정표를 확인한 뒤 등록해주세요.":"입력값을 바꾸면 일정을 다시 만들어주세요."}</span></div>
    {planRows&&planRows.length>0&&<div className="overflow-hidden rounded-xl border border-blue-100 bg-white"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-blue-100 bg-blue-50/60 px-4 py-3"><b className="text-sm text-blue-900">분납 예정표 · 회차별 수정 가능</b><span className="text-xs font-semibold text-blue-700">{planRows.length}회 · 합계 {won(previewTotal)}</span></div><div className="max-h-96 divide-y divide-slate-100 overflow-y-auto">{planRows.map((row,index)=><div key={index} className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 px-4 py-3"><b className="text-xs text-slate-500">{index+1}회</b><label className="text-xs font-semibold text-slate-600">납부일<input type="date" className={field+" mt-1"} value={row.dueDate} onChange={e=>updatePlanRow(index,{dueDate:e.target.value})}/></label><label className="text-xs font-semibold text-slate-600">분납금<NumberInput value={row.amount} onChange={v=>updatePlanRow(index,{amount:v})}/></label></div>)}</div>{previewTotal!==totalAmount&&<p role="status" className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800">예정표 합계가 총 분납금 {won(totalAmount)}과 일치하도록 회차별 금액을 조정해주세요.</p>}</div>}
    {totalAmount===0&&<p className="text-xs text-slate-500">총 분납금이 0원이면 분납 일정을 생성하지 않습니다.</p>}
   </div>}
   {editing&&<p className="mt-4 text-xs text-slate-500">고객정보 저장으로 기존 분납 일정의 날짜·금액은 변경되지 않습니다.</p>}
  </section>
  <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
   <SectionTitle title="사고 위험 · 메모"/>
   <label className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${form.isAccidentRisk?"border-amber-300 bg-amber-50":"border-slate-200 bg-slate-50"}`}><input type="checkbox" checked={!!form.isAccidentRisk} disabled={!!form.isAccident} onChange={e=>patch({isAccidentRisk:e.target.checked})} className="mt-0.5 h-4 w-4 accent-amber-600"/><div><div className={form.isAccidentRisk?"text-sm font-black text-amber-800":"text-sm font-bold text-slate-700"}>{form.isAccident?"사고자로 등록됨":form.isAccidentRisk?"사고 위험자로 등록":"사고 위험자 등록"}</div><div className="mt-0.5 text-xs leading-5 text-slate-500">위험자로 체크하면 사고자 조회의 ‘사고 위험자’ 탭에 분류됩니다. 실제 사고자 전환은 사고자 조회에서 처리합니다.</div></div></label>
   <div className="mt-4"><Label text="메모"><textarea className={textarea} value={form.memo} onChange={e=>patch({memo:e.target.value})}/></Label></div>
  </section>
  <div className="sticky bottom-0 -mx-4 -mb-4 flex justify-end gap-2 border-t border-slate-100 bg-white/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:-mb-6 sm:px-6"><Button variant="secondary" onClick={onClose}>취소</Button><Button onClick={submit}>{saveLabel|| (editing?"수정 저장":"등록")}</Button></div>
 </div>
}
