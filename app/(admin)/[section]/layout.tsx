import type {ReactNode} from "react";
import {notFound,redirect} from "next/navigation";
import {createClient} from "@/lib/supabase/server";
import {isAdminOnlyPath,normalizeRole} from "@/lib/rbac";

export default async function SectionLayout({children,params}:{children:ReactNode;params:Promise<{section:string}>}){
 const {section}=await params;
 if(!["changes","analytics","leads","accidents","customers","db","contracts","payments","repayments","settlements","lenders","board"].includes(section))notFound();
 if(!isAdminOnlyPath(`/${section}`))return children;

 const supabase=await createClient();
 const {data,error:authError}=await supabase.auth.getUser();
 const user=data?.user;
 if(authError||!user)redirect("/login");

 const {data:profile,error:profileError}=await supabase.from("profiles").select("role").eq("id",user.id).maybeSingle();
 if(profileError||!profile||normalizeRole(profile.role)!=="ADMIN")redirect("/");
 return children;
}
