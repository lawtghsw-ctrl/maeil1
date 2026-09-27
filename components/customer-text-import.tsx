"use client";
import {useEffect,useState} from "react";
import {ClipboardPaste,Sparkles} from "lucide-react";
import {Button} from "@/components/ui";
import {Customer} from "@/components/store";
import {parseCustomerText} from "@/lib/customer-text-parser";

type CustomerForm=Omit<Customer,"id">;
const box="min-h-36 w-full rounded-xl border border-blue-200 bg-white px-3 py-3 text-sm leading-6 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100";

export function CustomerTextImport({open,form,setForm}:{open:boolean;form:CustomerForm;setForm:(v:CustomerForm)=>void}){
  const [expanded,setExpanded]=useState(false);
  const [text,setText]=useState("");
  const [message,setMessage]=useState("");
  useEffect(()=>{if(!open){setExpanded(false);setText("");setMessage("")}},[open]);

  function apply(source:string){
    const result=parseCustomerText(source);
    const keys=Object.keys(result.patch);
    if(!keys.length){setMessage("자동으로 찾은 항목이 없습니다. 형식을 확인한 뒤 직접 입력해주세요.");return;}
    const patch=result.patch;
    setForm({
      ...form,
      ...(patch.createdAt?{createdAt:patch.createdAt}:{}),
      ...(patch.name?{name:patch.name}:{}),
      ...(patch.phone?{phone:patch.phone}:{}),
      ...(patch.address?{address:patch.address}:{}),
      ...(patch.birthNumber?{birthNumber:patch.birthNumber}:{}),
      ...(patch.manager?{manager:patch.manager}:{}),
      ...(patch.coordinationManager?{coordinationManager:patch.coordinationManager}:{}),
      ...(patch.contractDate?{contractDate:patch.contractDate}:{}),
      ...(patch.contractAmount!==undefined?{contractAmount:patch.contractAmount}:{}),
      ...(patch.prepaidAmount!==undefined?{prepaidAmount:patch.prepaidAmount}:{}),
      ...(patch.installmentMonths!==undefined?{installmentMonths:patch.installmentMonths}:{}),
      ...(patch.lenderUnitPrice!==undefined?{lenderUnitPrice:patch.lenderUnitPrice}:{}),
      ...(patch.lenderCount!==undefined?{lenderCount:patch.lenderCount}:{}),
      ...(patch.memo?{memo:[...new Set(`${form.memo||""}\n${patch.memo}`.split("\n").map(v=>v.trim()).filter(Boolean))].join("\n")}:{}),
    });
    const inferred=result.inferred.length?` · 자동계산 ${result.inferred.length}건`:"";
    setMessage(`${keys.length}개 항목을 채웠습니다${inferred}. 아래 입력값을 확인한 뒤 등록해주세요.`);
  }

  return <div className="sm:col-span-2">
    <button type="button" onClick={()=>setExpanded(v=>!v)} className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition ${expanded?"border-blue-300 bg-blue-50":"border-blue-200 bg-blue-50/50 hover:bg-blue-50"}`}>
      <span className="flex items-center gap-2"><ClipboardPaste size={17} className="text-blue-600"/><span><span className="block text-sm font-bold text-blue-900">텍스트로 자동입력</span><span className="mt-0.5 block text-xs font-normal text-blue-600">카톡·문자로 받은 고객정보를 통째로 붙여넣으세요.</span></span></span>
      <span className="text-xs font-bold text-blue-700">{expanded?"닫기":"열기"}</span>
    </button>
    {expanded&&<div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/40 p-3">
      <textarea
        className={box}
        value={text}
        onChange={e=>{setText(e.target.value);setMessage("")}}
        onPaste={e=>{const pasted=e.clipboardData.getData("text");if(!pasted)return;e.preventDefault();setText(pasted);apply(pasted)}}
        placeholder={`예)\n이름 박찬우\n연락처 010-1234-5678\n주소 청주시 ...\n계약금액 44만원\n선납금 10만원\n분납 3개월\n업체당 단가 22만원\n업체수 2개`}
      />
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className={`text-xs ${message.startsWith("자동으로")?"text-amber-700":"text-slate-500"}`}>{message||"붙여넣으면 즉시 자동입력됩니다. 인식이 안 되면 아래 버튼을 눌러 다시 추출할 수 있습니다."}</div>
        <Button variant="secondary" onClick={()=>apply(text)} disabled={!text.trim()} className="shrink-0"><Sparkles size={15}/>정보 추출</Button>
      </div>
      <div className="mt-2 text-[11px] leading-5 text-slate-400">외부 AI로 전송하지 않고 현재 브라우저에서만 텍스트를 분석합니다. 자동입력 후 반드시 이름·연락처·금액을 확인하세요.</div>
    </div>}
  </div>;
}
