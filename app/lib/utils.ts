import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export const won = (n:number) => `₩${Math.round(n || 0).toLocaleString("ko-KR")}`;
export const phoneDisplay = (v:string) => v;
export const isoDate = (v:string) => (v || "").slice(0,10);
export function inRange(date:string,start:string,end:string){const d=isoDate(date);return (!start||d>=start)&&(!end||d<=end)}
