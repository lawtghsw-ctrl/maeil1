import {cn} from "@/lib/utils";
import {BRAND_NAME} from "@/lib/brand";

export function BrandLogo({className,variant="sidebar"}:{className?:string;variant?:"sidebar"|"login"}){
 const large=variant==="login";
 return <span className={cn("inline-flex min-w-0 items-center gap-2.5",className)}>
  <span className={cn("font-black tracking-tight text-blue-700",large?"text-3xl":"text-2xl")}>{BRAND_NAME}</span>
  <span className={cn("shrink-0 font-bold tracking-tight text-slate-900",large?"text-xl":"text-[15px]")}>Admin</span>
 </span>
}
