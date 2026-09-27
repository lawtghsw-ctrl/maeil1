"use client";
import Link from "next/link";
import {usePathname,useRouter} from "next/navigation";
import {useEffect,useState} from "react";
import {LayoutDashboard,Users,FileSignature,WalletCards,CalendarClock,Calculator,Building2,MessagesSquare,ShieldCheck,LogOut,Menu,X,Inbox,History,Activity,LockKeyhole} from "lucide-react";
import {cn} from "@/lib/utils";
import {createClient} from "@/lib/supabase/client";
import {BRAND_NAME} from "@/lib/brand";
import {useRole} from "@/components/role-provider";

export const menu=[
 ["대시보드","/",LayoutDashboard,false],
 ["신규 DB","/leads",Inbox,false],
 ["고객 관리","/customers",Users,false],
 ["계약 관리","/contracts",FileSignature,false],
 ["입금/분납 관리","/payments",WalletCards,false],
 ["상환 일정 관리","/repayments",CalendarClock,false],
 ["정산","/settlements",Calculator,true],
 ["사채업체 관리","/lenders",Building2,false],
 ["내부 게시판","/board",MessagesSquare,false],
 ["기간별 변동내역","/changes",History,true],
 ["데이터 집계","/analytics",Activity,true],
] as const;

function NavItems({pathname,isAdmin,onNavigate}:{pathname:string;isAdmin:boolean;onNavigate?:()=>void}){
 const visible=menu.filter(([, , ,adminOnly])=>isAdmin||!adminOnly);
 return <nav className="flex-1 overflow-y-auto p-3">{visible.map(([label,href,Icon,adminOnly])=>{const active=href==="/"?pathname==="/":pathname.startsWith(href);return <Link key={href} href={href} onClick={onNavigate} className={cn("mb-1 flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition",active?"bg-blue-50 text-blue-700":"text-slate-600 hover:bg-slate-50 hover:text-slate-950")}><Icon size={18}/>{label}{adminOnly&&<LockKeyhole size={12} className="ml-auto text-slate-300"/>}</Link>})}</nav>;
}

function ProfileBlock({profile,onLogout}:{profile:{name:string;roleLabel:string;isAdmin:boolean};onLogout:()=>void}){
 return <div className="border-t border-slate-100 p-4"><div className="rounded-xl bg-slate-50 p-3"><div className="flex items-center gap-3"><div className={`grid size-9 place-items-center rounded-full text-xs font-bold text-white ${profile.isAdmin?"bg-blue-700":"bg-slate-800"}`}>{profile.name.slice(0,1)}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-bold">{profile.name}</div><div className={`text-xs font-semibold ${profile.isAdmin?"text-blue-600":"text-slate-500"}`}>{profile.roleLabel}</div></div><button title="로그아웃" onClick={onLogout} className="grid size-8 place-items-center rounded-lg text-slate-400 hover:bg-white hover:text-red-600"><LogOut size={16}/></button></div></div></div>;
}

function Brand({close}:{close?:()=>void}){
 return <div className="flex h-16 items-center gap-3 border-b border-slate-100 px-5"><div className="grid size-9 place-items-center rounded-lg bg-blue-600 text-white"><ShieldCheck size={19}/></div><div className="min-w-0 flex-1"><div className="font-bold text-slate-900">{BRAND_NAME} Admin</div><div className="text-[10px] font-semibold tracking-widest text-slate-400">DEBT RELIEF CENTER</div></div>{close&&<button onClick={close} className="grid size-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100" aria-label="메뉴 닫기"><X size={20}/></button>}</div>;
}

export function Sidebar(){
 const pathname=usePathname();const router=useRouter();const [mobileOpen,setMobileOpen]=useState(false);const {name,isAdmin,roleLabel}=useRole();
 useEffect(()=>{setMobileOpen(false)},[pathname]);
 async function logout(){const supabase=createClient();await supabase.auth.signOut();router.replace("/login");router.refresh()}
 const profile={name,roleLabel,isAdmin};
 return <>
  <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] border-r border-slate-200 bg-white lg:flex lg:flex-col"><Brand/><NavItems pathname={pathname} isAdmin={isAdmin}/><ProfileBlock profile={profile} onLogout={logout}/></aside>
  <button onClick={()=>setMobileOpen(true)} className="fixed left-3 top-3 z-50 grid size-10 place-items-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm lg:hidden" aria-label="메뉴 열기"><Menu size={21}/></button>
  {mobileOpen&&<div className="fixed inset-0 z-[80] lg:hidden"><button aria-label="메뉴 닫기" className="absolute inset-0 bg-slate-950/35" onClick={()=>setMobileOpen(false)}/><aside className="absolute inset-y-0 left-0 flex w-[280px] max-w-[86vw] flex-col bg-white shadow-2xl"><Brand close={()=>setMobileOpen(false)}/><NavItems pathname={pathname} isAdmin={isAdmin} onNavigate={()=>setMobileOpen(false)}/><ProfileBlock profile={profile} onLogout={logout}/></aside></div>}
 </>;
}
