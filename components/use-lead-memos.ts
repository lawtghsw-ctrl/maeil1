"use client";
import {useState,type Dispatch,type SetStateAction} from "react";
import type {createClient} from "@/lib/supabase/client";
import {createLeadMemoDrafts} from "@/lib/lead-memo-drafts";

export function useLeadMemos<T extends {id:string;memo:string}>(
 table:"meta_leads",client:ReturnType<typeof createClient>,setRows:Dispatch<SetStateAction<T[]>>,
){
 const [memoDrafts]=useState(createLeadMemoDrafts);
 function editMemo(id:string,value:string){
  memoDrafts.edit(id,value);
  setRows(previous=>previous.map(row=>row.id===id?{...row,memo:value}:row));
 }
 async function saveMemo(id:string){
  try{
   await memoDrafts.save(id,async value=>{
    const {data,error}=await client.from(table).update({memo:value}).eq("id",id).select("id").single();
    if(error)throw new Error(error.message);
    if(data?.id!==id)throw new Error("메모를 저장할 대상을 확인하지 못했습니다.");
   });
  }catch(error){
   alert(`메모 저장에 실패했습니다. 입력 내용은 유지했습니다. 메모를 다시 선택한 뒤 다른 곳을 눌러 재시도해주세요.\n${error instanceof Error?error.message:String(error)}`);
  }
 }
 return {memoDrafts,editMemo,saveMemo};
}
