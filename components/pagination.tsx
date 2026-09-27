"use client";
import {ChevronLeft,ChevronRight} from "lucide-react";
import {Button} from "@/components/ui";
export const PAGE_SIZE=50;
export function Pagination({page,total,onChange,pageSize=PAGE_SIZE}:{page:number;total:number;onChange:(p:number)=>void;pageSize?:number}){const pages=Math.max(1,Math.ceil(total/pageSize));if(pages<=1)return null;return <div className="flex items-center justify-center gap-2 border-t border-slate-100 px-4 py-4"><Button variant="secondary" onClick={()=>onChange(Math.max(1,page-1))}><ChevronLeft size={15}/>이전</Button><span className="min-w-20 text-center text-sm text-slate-500">{page} / {pages}</span><Button variant="secondary" onClick={()=>onChange(Math.min(pages,page+1))}>다음<ChevronRight size={15}/></Button></div>}
export function pageRows<T>(rows:T[],page:number,pageSize=PAGE_SIZE){return rows.slice((page-1)*pageSize,page*pageSize)}
