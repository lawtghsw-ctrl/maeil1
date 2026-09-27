"use client";
import {usePathname,useRouter} from "next/navigation";
import {useEffect} from "react";
import {ShieldAlert} from "lucide-react";
import {isAdminOnlyPath} from "@/lib/rbac";
import {useRole} from "@/components/role-provider";

export function AccessGuard({children}:{children:React.ReactNode}){
 const pathname=usePathname();
 const router=useRouter();
 const {isAdmin}=useRole();
 const denied=!isAdmin&&isAdminOnlyPath(pathname);
 useEffect(()=>{if(denied)router.replace("/")},[denied,router]);
 if(denied)return <div className="grid min-h-[50vh] place-items-center"><div className="rounded-2xl border border-amber-200 bg-white p-6 text-center shadow-sm"><ShieldAlert className="mx-auto text-amber-600"/><div className="mt-3 font-bold text-slate-900">최종관리자 전용 메뉴입니다.</div><div className="mt-1 text-sm text-slate-500">대시보드로 이동합니다.</div></div></div>;
 return children;
}
