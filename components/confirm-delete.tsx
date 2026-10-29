"use client";
import {useRef,useState} from "react";
import {Modal,Button} from "@/components/ui";
export function ConfirmDelete({open,name,label="정보",description,onClose,onConfirm}:{open:boolean;name:string;label?:string;description?:string;onClose:()=>void;onConfirm:()=>void|Promise<void>}){
 const [saving,setSaving]=useState(false);
 const [error,setError]=useState("");
 const pending=useRef(false);
 const close=()=>{if(!pending.current){setError("");onClose()}};
 async function confirm(){
  if(pending.current)return;
  pending.current=true;setSaving(true);setError("");
  try{await onConfirm();onClose()}catch(e){setError(e instanceof Error?e.message:"삭제하지 못했습니다. 다시 시도해주세요.")}
  finally{pending.current=false;setSaving(false)}
 }
 return <Modal open={open} title="삭제 확인" onClose={close} busy={saving}><div className="space-y-5" aria-busy={saving}><div className="rounded-xl bg-red-50 p-4 text-sm text-red-800"><b>{name}</b>의 {label}를 정말로 삭제하시겠습니까?<br/><span className="text-xs text-red-600">삭제한 데이터는 이 테스트 버전에서 복구할 수 없습니다.</span></div>{description&&<p className="whitespace-pre-line rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">{description}</p>}{error&&<div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">삭제 실패: {error}</div>}<div className="flex justify-end gap-2"><Button variant="secondary" onClick={close} disabled={saving}>아니오</Button><Button variant="danger" onClick={confirm} disabled={saving}>{saving?"삭제 중...":"예, 삭제"}</Button></div></div></Modal>;
}
