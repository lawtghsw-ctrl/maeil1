"use client";
import Link from "next/link";
import {usePathname,useRouter} from "next/navigation";
import {useEffect,useId,useState} from "react";
import {LayoutDashboard,Users,FileSignature,WalletCards,CalendarClock,Calculator,Building2,MessagesSquare,LogOut,Menu,X,Inbox,History,Activity,TriangleAlert,ChevronDown} from "lucide-react";
import {BrandLogo} from "@/components/brand-logo";
import {cn} from "@/lib/utils";
import {createClient} from "@/lib/supabase/client";
import {useRole} from "@/components/role-provider";
export const menu=[["대시보드","/",LayoutDashboard],["DB 관리","/leads",Inbox],["고객 관리","/customers",Users],["계약 관리","/contracts",FileSignature],["입금/분납 관리","/payments",WalletCards],["상환 일정 관리","/repayments",CalendarClock],["사채업체 관리","/lenders",Building2],["사고자 조회","/accidents",TriangleAlert],["내부 게시판","/board",MessagesSquare]] as const;
export const adminMenu=[["정산","/settlements",Calculator],["기간별 변동내역","/changes",History],["데이터 집계","/analytics",Activity]] as const;

function NavItems({pathname,onNavigate,isAdmin}:{pathname:string;onNavigate?:()=>void;isAdmin:boolean}){
 const [adminOpen,setAdminOpen]=useState(false);
 const adminMenuId=useId();
 return <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3"><div>{menu.map(([label,href,Icon])=>{const active=href==="/"?pathname==="/":pathname.startsWith(href);return <Link key={href} href={href} onClick={onNavigate} className={cn("mb-1 flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition",active?"bg-blue-50 text-blue-700":"text-slate-600 hover:bg-slate-50 hover:text-slate-950")}><Icon size={18}/>{label}</Link>})}</div>{isAdmin&&<div className="mt-auto shrink-0 pt-3"><div className="rounded-xl border border-slate-200 bg-slate-50/70"><button type="button" onClick={()=>setAdminOpen(open=>!open)} aria-expanded={adminOpen} aria-controls={adminMenuId} className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left text-xs font-semibold text-slate-600 hover:bg-slate-100"><span>관리자 전용 메뉴</span><ChevronDown size={16} aria-hidden="true" className={cn("shrink-0 transition-transform",adminOpen&&"rotate-180")}/></button><div id={adminMenuId} hidden={!adminOpen} className="px-1.5 pb-1.5">{adminMenu.map(([label,href,Icon])=><Link key={href} href={href} onClick={onNavigate} className={cn("mb-1 flex h-10 items-center gap-2 rounded-lg px-2 text-xs font-medium transition",pathname.startsWith(href)?"bg-blue-50 text-blue-700":"text-slate-600 hover:bg-white hover:text-slate-950")}><Icon size={16}/>{label}</Link>)}</div></div></div>}</nav>
}

function ProfileBlock({profile,onLogout}:{profile:{name:string;role:string};onLogout:()=>void}){
 return <div className="border-t border-slate-100 p-4"><div className="rounded-xl bg-slate-50 p-3"><div className="flex items-center gap-3"><div className="grid size-9 place-items-center rounded-full bg-slate-800 text-xs font-bold text-white">{profile.name.slice(0,1)}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-bold">{profile.name}</div><div className="text-xs text-slate-500">{profile.role}</div></div><button title="로그아웃" onClick={onLogout} className="grid size-8 place-items-center rounded-lg text-slate-400 hover:bg-white hover:text-red-600"><LogOut size={16}/></button></div></div></div>;
}

function Brand({close}:{close?:()=>void}){
 return <div className="flex h-16 items-center gap-3 border-b border-slate-100 px-5"><BrandLogo className="flex-1"/>{close&&<button onClick={close} className="grid size-9 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100" aria-label="메뉴 닫기"><X size={20}/></button>}</div>;
}

export function Sidebar(){
 const pathname=usePathname();const router=useRouter();const [mobileOpen,setMobileOpen]=useState(false);
 const {name,roleLabel,isAdmin}=useRole();
 const profile={name,role:roleLabel};
 useEffect(()=>{setMobileOpen(false)},[pathname]);
 async function logout(){const supabase=createClient();await supabase.auth.signOut();router.replace("/login");router.refresh()}
 return <>
  <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] border-r border-slate-200 bg-white lg:flex lg:flex-col"><Brand/><NavItems pathname={pathname} isAdmin={isAdmin}/><ProfileBlock profile={profile} onLogout={logout}/></aside>
  <button onClick={()=>setMobileOpen(true)} className="fixed left-3 top-3 z-50 grid size-10 place-items-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm lg:hidden" aria-label="메뉴 열기"><Menu size={21}/></button>
  {mobileOpen&&<div className="fixed inset-0 z-[80] lg:hidden"><button aria-label="메뉴 닫기" className="absolute inset-0 bg-slate-950/35" onClick={()=>setMobileOpen(false)}/><aside className="absolute inset-y-0 left-0 flex w-[280px] max-w-[86vw] flex-col bg-white shadow-2xl"><Brand close={()=>setMobileOpen(false)}/><NavItems pathname={pathname} onNavigate={()=>setMobileOpen(false)} isAdmin={isAdmin}/><ProfileBlock profile={profile} onLogout={logout}/></aside></div>}
 </>
}
