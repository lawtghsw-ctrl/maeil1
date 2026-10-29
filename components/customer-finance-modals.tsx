"use client";
import {useEffect,useMemo,useRef,useState,type ReactNode} from "react";
import {Plus,Trash2} from "lucide-react";
import {Badge,Button,Card,Modal} from "@/components/ui";
import {Customer,CustomerAdditionalContractRow,CustomerRecoveryRow,useAdminStore} from "@/components/store";
import {won} from "@/lib/utils";

const field="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100 disabled:text-slate-500";
const textarea="min-h-20 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100";
const paymentMethods=["계좌이체","카드","현금","기타"];
function today(){return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}
function NumberInput({value,onChange}:{value:number;onChange:(v:number)=>void}){return <input inputMode="numeric" className={field} value={value?value.toLocaleString("ko-KR"):""} placeholder="0" onChange={e=>{const raw=e.target.value.replace(/[^0-9]/g,"");onChange(raw?Number(raw):0)}}/>}
function Label({text,children}:{text:string;children:ReactNode}){return <label className="text-sm font-semibold">{text}<div className="mt-1.5">{children}</div></label>}

const emptyAdditional=():CustomerAdditionalContractRow=>({contractDate:today(),contractAmount:0,prepaidAmount:0,installmentMonths:0,lenderUnitPrice:0,lenderCount:0,isRenegotiation:false,memo:""});
export function AdditionalContractsModal({open,customer,onClose}:{open:boolean;customer:Customer;onClose:()=>void}){
 const s=useAdminStore();
 const makeRows=()=>s.additionalContracts.filter(x=>x.customerId===customer.id).sort((a,b)=>(a.createdTime||"").localeCompare(b.createdTime||"")).map(({id,contractDate,contractAmount,prepaidAmount,installmentMonths,lenderUnitPrice,lenderCount,isRenegotiation,memo})=>({id,contractDate,contractAmount,prepaidAmount,installmentMonths,lenderUnitPrice,lenderCount,isRenegotiation,memo}));
 const [selectedIndex,setSelectedIndex]=useState(0);
 const [rows,setRows]=useState<CustomerAdditionalContractRow[]>(makeRows);
 useEffect(()=>{if(open){setRows(makeRows());setSelectedIndex(0)}},[open,customer.id]);
 const extraTotal=rows.reduce((sum,x)=>sum+(x.contractAmount||0),0);const base=customer.baseContractAmount??Math.max(0,customer.contractAmount-s.additionalContracts.filter(x=>x.customerId===customer.id).reduce((a,b)=>a+b.contractAmount,0));
 const renegotiationUnitPrice=Math.round((customer.lenderUnitPrice||0)*0.5);
 function update(i:number,p:Partial<CustomerAdditionalContractRow>){setRows(r=>r.map((x,n)=>{if(n!==i)return x;const next={...x,...p};if(next.isRenegotiation){next.installmentMonths=0;next.lenderUnitPrice=renegotiationUnitPrice}return next}))}
 function toggleRenegotiation(i:number,checked:boolean){update(i,checked?{isRenegotiation:true,installmentMonths:0,lenderUnitPrice:renegotiationUnitPrice}:{isRenegotiation:false,lenderUnitPrice:0})}
 function remove(i:number){if(window.confirm("이 추가 계약을 삭제할까요? 저장 버튼을 눌러야 최종 반영됩니다."))setRows(r=>r.filter((_,n)=>n!==i))}
 async function save(){try{await s.setCustomerAdditionalContracts(customer.id,rows);onClose()}catch(e){alert(e instanceof Error?e.message:"추가계약 저장 실패")}}
 return <Modal open={open} title={`${customer.name} · 추가 계약`} onClose={onClose}><div className="space-y-4"><div className="grid gap-3 sm:grid-cols-3"><Card className="p-3"><div className="text-xs font-semibold text-slate-500">최초 계약금액</div><div className="mt-1 font-bold">{won(base)}</div></Card><Card className="p-3"><div className="text-xs font-semibold text-slate-500">추가 계약 합계</div><div className="mt-1 font-bold text-blue-700">{won(extraTotal)}</div></Card><Card className="p-3"><div className="text-xs font-semibold text-slate-500">총 계약금액</div><div className="mt-1 font-bold">{won(base+extraTotal)}</div></Card></div><div className="rounded-lg bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700">추가 계약은 계속 누적 저장되며 언제든 수정·삭제·추가할 수 있습니다. 정산의 계약매출에는 각 추가 계약의 계약일에 추가 계약금액만 별도로 반영되며, 기존 최초 계약금액을 다시 합산하지 않습니다. 추가 계약 및 재조율 계약의 선납금은 입금/분납 관리에 자동으로 완료 입금으로 연동되며 일정 공지의 수임료 납부 내역에도 표시됩니다.</div><div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]"><aside className="space-y-2 rounded-xl border border-slate-200 p-3"><h3 className="text-sm font-bold">추가 계약 목록</h3>{rows.map((item,i)=><button type="button" key={item.id||i} onClick={()=>setSelectedIndex(i)} className={`block w-full rounded-lg border p-3 text-left text-sm ${i===selectedIndex?"border-blue-400 bg-blue-50":"border-slate-200 hover:bg-slate-50"}`}><div className="font-semibold">추가 계약 {i+1} {item.isRenegotiation?"· 재조율":""}</div><div className="mt-1 text-xs text-slate-600">{item.contractDate||"날짜 미지정"} · {won(item.contractAmount)}</div></button>)}<button type="button" className="w-full rounded-lg border border-dashed border-blue-300 p-2 text-sm font-semibold text-blue-700" onClick={()=>{setSelectedIndex(rows.length);setRows(x=>[...x,emptyAdditional()])}}>+ 추가 계약 등록</button></aside><div className="min-w-0"><h3 className="mb-3 text-sm font-bold">선택 추가 계약 상세</h3>{rows.map((r,i)=>i===selectedIndex?<div key={r.id||`new-${i}`} className="rounded-xl border border-slate-200 bg-slate-50/50 p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><b>추가 계약 {i+1}</b>{r.id?<Badge tone="blue">저장됨</Badge>:<Badge tone="amber">신규</Badge>}{r.isRenegotiation&&<Badge tone="red">재조율</Badge>}</div><div className="flex items-center gap-3"><label className="flex cursor-pointer items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-semibold text-orange-800"><input type="checkbox" checked={!!r.isRenegotiation} onChange={e=>toggleRenegotiation(i,e.target.checked)}/>재조율</label><Button variant="danger" onClick={()=>remove(i)}><Trash2 size={14}/>삭제</Button></div></div>{r.isRenegotiation&&<div className="mb-3 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs leading-5 text-orange-800">재조율 계약입니다. 업체당 단가는 기존 계약의 50%인 <b>{won(renegotiationUnitPrice)}</b>으로 자동 적용되며, 이 업체수는 고객의 전체 업체수에 합산되지 않습니다. 재조율 선납금도 입력할 수 있으며 입금/분납과 일정 공지에 자동 반영됩니다.</div>}<div className="grid gap-3 sm:grid-cols-2"><Label text="계약일"><input type="date" className={field} value={r.contractDate} onChange={e=>update(i,{contractDate:e.target.value})}/></Label><Label text="추가계약금액"><NumberInput value={r.contractAmount} onChange={v=>update(i,{contractAmount:v})}/></Label><Label text={r.isRenegotiation?"재조율 선납금":"선납금"}><NumberInput value={r.prepaidAmount} onChange={v=>update(i,{prepaidAmount:v})}/></Label>{!r.isRenegotiation&&<Label text="분납기간(개월)"><NumberInput value={r.installmentMonths} onChange={v=>update(i,{installmentMonths:v})}/></Label>}<Label text="업체당 단가"><input className={field} value={(r.isRenegotiation?renegotiationUnitPrice:r.lenderUnitPrice)?(r.isRenegotiation?renegotiationUnitPrice:r.lenderUnitPrice).toLocaleString("ko-KR"):""} placeholder="0" readOnly={!!r.isRenegotiation} onChange={e=>{if(r.isRenegotiation)return;const raw=e.target.value.replace(/[^0-9]/g,"");update(i,{lenderUnitPrice:raw?Number(raw):0})}}/></Label><Label text="업체수"><NumberInput value={r.lenderCount} onChange={v=>update(i,{lenderCount:v,lenderUnitPrice:r.isRenegotiation?renegotiationUnitPrice:r.lenderUnitPrice})}/></Label><label className="sm:col-span-2 text-sm font-semibold">메모<textarea className={`${textarea} mt-1.5`} value={r.memo} onChange={e=>update(i,{memo:e.target.value})}/></label></div></div>:null)}</div></div><button type="button" onClick={()=>{setSelectedIndex(rows.length);setRows(x=>[...x,emptyAdditional()])}} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-blue-300 py-3 text-sm font-semibold text-blue-700 hover:bg-blue-50"><Plus size={15}/>추가 계약 등록</button><div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>취소</Button><Button onClick={save}>저장</Button></div></div></Modal>
}

const emptyRecovery=():CustomerRecoveryRow=>({
 recoveryDate:today(),lenderName:"",recoveryType:"",amount:0,paymentMethod:"계좌이체",memo:"",depositorName:"",
 successFeeAmount:0,installmentAmount:0,clientReturnAmount:0,accountingVersion:2,
});
export function RecoveriesModal({open,customer,onClose}:{open:boolean;customer:Customer;onClose:()=>void}){
 const s=useAdminStore();
 const makeRows=()=>s.recoveries.filter(x=>x.customerId===customer.id)
  .sort((a,b)=>(a.createdTime||"").localeCompare(b.createdTime||""))
  .map(({id,recoveryDate,lenderName,recoveryType,amount,paymentMethod,memo,depositorName,successFeeAmount,installmentAmount,clientReturnAmount,accountingVersion,rowVersion})=>{
   const legacy=(accountingVersion??1)<2;
   const split=s.recoverySplits.find(x=>x.recoveryId===id);
   const returned=s.recoveryRefunds.filter(x=>x.recoveryId===id).reduce((sum,x)=>sum+x.amount,0);
   return {id,recoveryDate,lenderName,recoveryType,amount,paymentMethod,memo,depositorName,
    successFeeAmount:successFeeAmount??Math.floor(amount/2),
    installmentAmount:legacy?(split?.appliedFee??0):(installmentAmount??0),
    clientReturnAmount:legacy?returned:(clientReturnAmount??0),
    accountingVersion:accountingVersion??1,rowVersion};
  });
 const [selectedIndex,setSelectedIndex]=useState(0);
 const [rows,setRows]=useState<CustomerRecoveryRow[]>(makeRows);
 const [saving,setSaving]=useState(false);
 const [saveError,setSaveError]=useState("");
 const savingRef=useRef(false);
 const originalVersions=useRef<Record<string,number>>({});
 // Keep a modal-session snapshot so realtime refreshes cannot overwrite current edits.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 useEffect(()=>{if(open){const saved=makeRows();originalVersions.current=Object.fromEntries(saved.flatMap(row=>row.id?[[row.id,row.rowVersion||1]]:[]));setRows(saved);setSelectedIndex(0);setSaveError("")}},[open,customer.id]);
 const lenderNames=useMemo(()=>Array.from(new Set([...s.lenders.filter(l=>l.customerIds.includes(customer.id)).map(l=>l.name),...s.lenders.map(l=>l.name)].filter(Boolean))),[s.lenders,customer.id]);
 const total=rows.reduce((sum,x)=>sum+(x.amount||0),0);
 const selected=rows[selectedIndex];
 const successFee=selected?Math.floor(selected.amount/2):0;
 const distributable=selected?selected.amount-successFee:0;
 const allocated=selected?(selected.installmentAmount||0)+(selected.clientReturnAmount||0):0;
 function update(i:number,patch:Partial<CustomerRecoveryRow>){
  if(savingRef.current)return;
  setSaveError("");
  setRows(previous=>previous.map((row,index)=>{
   if(index!==i||!Object.entries(patch).some(([key,value])=>row[key as keyof CustomerRecoveryRow]!==value))return row;
   const next={...row,...patch};
   return {...next,successFeeAmount:Math.floor(next.amount/2),accountingVersion:2};
  }));
 }
 function add(){
  if(savingRef.current)return;
  setSelectedIndex(rows.length);setRows(previous=>[...previous,emptyRecovery()]);setSaveError("");
 }
 function remove(index:number){
  if(savingRef.current||!window.confirm("이 환수 기록과 연결된 정산을 삭제할까요? 저장 버튼을 눌러야 최종 반영됩니다."))return;
  setRows(previous=>previous.filter((_,i)=>i!==index));
  setSelectedIndex(current=>Math.min(current,Math.max(0,rows.length-2)));setSaveError("");
 }
 function close(){if(!savingRef.current)onClose()}
 async function save(){
  if(savingRef.current)return;
  for(const [index,row] of rows.entries()){
   if((row.accountingVersion??1)<2)continue;
   const fee=Math.floor(row.amount/2),installment=row.installmentAmount||0,returned=row.clientReturnAmount||0;
   if(![row.amount,installment,returned].every(value=>Number.isSafeInteger(value)&&value>=0)){
    setSaveError(`환수 ${index+1}: 금액은 0 이상의 원 단위 숫자로 입력해주세요.`);return;
   }
   if(row.amount>0&&(!row.recoveryDate||!row.depositorName?.trim())){
    setSaveError(`환수 ${index+1}: 환수일과 실제 입금 예금주를 입력해주세요.`);return;
   }
   if(installment+returned>row.amount-fee){
    setSaveError(`환수 ${index+1}: 분납금과 의뢰인 반환금 합계는 성공보수를 제외한 ${won(row.amount-fee)}을 초과할 수 없습니다.`);return;
   }
  }
  savingRef.current=true;setSaving(true);setSaveError("");
  try{await s.setCustomerRecoveries(customer.id,rows,originalVersions.current);onClose()}
  catch(error){setSaveError(error instanceof Error?error.message:"환수 저장 실패")}
  finally{savingRef.current=false;setSaving(false)}
 }
 return <Modal open={open} title={`${customer.name} · 환수 등록`} onClose={close}>
  <div className="space-y-4">
   <div className="flex items-center justify-between rounded-xl bg-emerald-50 px-4 py-3">
    <div><div className="text-xs font-semibold text-emerald-700">등록된 환수 총액</div><div className="mt-1 text-lg font-bold text-emerald-800">{won(total)}</div></div>
    <Badge tone="green">정산표 자동 연동</Badge>
   </div>
   <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
    환수 총액은 로펌 정산표에 실제 입금 1건으로 반영합니다. 성공보수 50%와 환수 분납금은 매출 분류이며, 의뢰인 반환 출금은 별도로 반영합니다. 분납금과 반환금은 직접 입력해주세요.
    의뢰인 반환금은 기존 반환 이력과 중복되지 않도록 별도 출금으로 반영합니다.
   </div>
   <datalist id={`recovery-lenders-${customer.id}`}>{lenderNames.map(name=><option key={name} value={name}/>)}</datalist>
   <fieldset disabled={saving} className="min-w-0 space-y-4">
    <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
     <aside className="space-y-2 rounded-xl border border-slate-200 p-3">
      <h3 className="text-sm font-bold">환수 내역 목록</h3>
      {rows.map((item,index)=><button type="button" key={item.id||index} onClick={()=>setSelectedIndex(index)}
       className={`block w-full rounded-lg border p-3 text-left text-sm ${index===selectedIndex?"border-emerald-400 bg-emerald-50":"border-slate-200 hover:bg-slate-50"}`}>
       <div className="font-semibold">{item.lenderName||`환수 ${index+1}`}</div>
       <div className="mt-1 text-xs text-slate-600">{item.recoveryDate||"날짜 미지정"} · {won(item.amount)}</div>
      </button>)}
      <button type="button" className="w-full rounded-lg border border-dashed border-emerald-300 p-2 text-sm font-semibold text-emerald-700" onClick={add}>+ 환수 건 추가</button>
     </aside>
     <div className="min-w-0">
      <h3 className="mb-3 text-sm font-bold">선택 환수 상세</h3>
      {selected?<div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4">
       <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2"><b>환수 {selectedIndex+1}</b>{selected.id?<Badge tone="green">저장됨</Badge>:<Badge tone="amber">신규</Badge>}</div>
        <Button variant="danger" onClick={()=>remove(selectedIndex)}><Trash2 size={14}/>삭제</Button>
       </div>
       {(selected.accountingVersion??1)<2&&<p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">기존 입금·정산 내역을 유지하고 있습니다. 이 환수 건을 수정한 뒤 저장하면 아래 금액을 기준으로 정산이 반영됩니다.</p>}
       <div className="grid gap-3 sm:grid-cols-2">
        <Label text="환수일"><input type="date" className={field} value={selected.recoveryDate} onChange={e=>update(selectedIndex,{recoveryDate:e.target.value})}/></Label>
        <Label text="업체명"><input list={`recovery-lenders-${customer.id}`} className={field} value={selected.lenderName} onChange={e=>update(selectedIndex,{lenderName:e.target.value})} placeholder="업체명 검색 또는 직접 입력"/></Label>
        <Label text="실제 입금 예금주"><input className={field} value={selected.depositorName||""} onChange={e=>update(selectedIndex,{depositorName:e.target.value})} placeholder="업체에서 보낸 실제 입금자명"/></Label>
        <Label text="환수 금액"><NumberInput value={selected.amount} onChange={value=>update(selectedIndex,{amount:value})}/></Label>
        <Label text="환수 성공보수 (50% 자동)"><input className={field} value={successFee.toLocaleString("ko-KR")} readOnly aria-readonly="true"/></Label>
        <Label text="환수 분납금"><NumberInput value={selected.installmentAmount||0} onChange={value=>update(selectedIndex,{installmentAmount:value})}/></Label>
        <Label text="의뢰인 환수 반환금 (출금)"><NumberInput value={selected.clientReturnAmount||0} onChange={value=>update(selectedIndex,{clientReturnAmount:value})}/></Label>
        <Label text="입금방법"><select className={field} value={selected.paymentMethod} onChange={e=>update(selectedIndex,{paymentMethod:e.target.value})}>{paymentMethods.map(method=><option key={method}>{method}</option>)}</select></Label>
        <label className="text-sm font-semibold sm:col-span-2">메모<textarea className={`${textarea} mt-1.5`} value={selected.memo} onChange={e=>update(selectedIndex,{memo:e.target.value})}/></label>
       </div>
       <div className={`mt-3 rounded-lg px-3 py-2 text-xs leading-5 ${allocated>distributable?"bg-red-50 text-red-700":"bg-blue-50 text-blue-800"}`}>
        성공보수 제외 {won(distributable)} · 분납금 {won(selected.installmentAmount||0)} · 의뢰인 반환금 {won(selected.clientReturnAmount||0)}
        {allocated>distributable&&<div>분납금과 반환금 합계가 성공보수 제외 금액을 초과했습니다.</div>}
       </div>
      </div>:<p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">환수 건을 추가하면 상세 내역을 입력할 수 있습니다.</p>}
     </div>
    </div>
    <button type="button" onClick={add} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-300 py-3 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"><Plus size={15}/>환수 건 추가</button>
   </fieldset>
   {saveError&&<p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{saveError}</p>}
   <div className="flex justify-end gap-2"><Button variant="secondary" disabled={saving} onClick={close}>취소</Button><Button disabled={saving} onClick={save}>{saving?"저장 중...":"저장"}</Button></div>
  </div>
 </Modal>
}
