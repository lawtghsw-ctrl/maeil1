import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export const won = (n:number) => `₩${Math.round(n || 0).toLocaleString("ko-KR")}`;
export function normalizePhoneDigits(v:string){
 let d=(v||"").replace(/\D/g,"");
 if(!d)return "";
 // Meta/Google Sheet에서 한국 국가번호 또는 앞자리 0이 빠진 휴대폰 번호를 보정합니다.
 if(d.startsWith("82")&&d.length>=11)d=`0${d.slice(2)}`;
 if(d.length===10&&d.startsWith("10"))d=`0${d}`;
 return d.slice(0,11);
}
export function formatPhone(v:string){
 const d=normalizePhoneDigits(v);
 if(!d)return "";
 if(d.startsWith("02")){
  if(d.length<=2)return d;
  if(d.length<=5)return `${d.slice(0,2)}-${d.slice(2)}`;
  if(d.length<=9)return `${d.slice(0,2)}-${d.slice(2,5)}-${d.slice(5)}`;
  return `${d.slice(0,2)}-${d.slice(2,6)}-${d.slice(6,10)}`;
 }
 if(d.length<=3)return d;
 if(d.length<=7)return `${d.slice(0,3)}-${d.slice(3)}`;
 if(d.length===10)return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
 return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;
}
export function formatBirthNumber(v:string){
 const d=(v||"").replace(/\D/g,"").slice(0,13);
 return d.length<=6?d:`${d.slice(0,6)}-${d.slice(6)}`;
}
export const phoneDisplay = (v:string) => formatPhone(v);
export function duplicateCustomerTag<T extends {id:string;name:string;phone:string}>(customers:T[],customer?:T){
 if(!customer)return "";
 const name=(customer.name||"").trim().replace(/\s+/g," ").toLowerCase();
 if(!name)return "";
 const matches=customers.filter(c=>(c.name||"").trim().replace(/\s+/g," ").toLowerCase()===name);
 if(matches.length<2)return "";
 const digits=(customer.phone||"").replace(/\D/g,"");
 const suffix=digits.slice(-4);
 return suffix?`동명 · ${suffix}`:"동명이인";
}
export const isoDate = (v:string) => (v || "").slice(0,10);
export function inRange(date:string,start:string,end:string){const d=isoDate(date);return (!start||d>=start)&&(!end||d<=end)}

export function isEformSignedStatus(status?:string){
 const code=(status||"").trim().toLowerCase();
 return code==="003"||code==="doc_complete"||code.includes("accept_participant")||code.includes("accept_external");
}
