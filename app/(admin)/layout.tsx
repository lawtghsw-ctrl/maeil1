import {redirect} from "next/navigation";
import {Sidebar} from "@/components/sidebar";
import {Header} from "@/components/header";
import {AdminStoreProvider} from "@/components/store";
import {RoleProvider} from "@/components/role-provider";
import {AccessGuard} from "@/components/access-guard";
import {createClient} from "@/lib/supabase/server";
export default async function AdminLayout({children}:{children:React.ReactNode}){
 const supabase=await createClient();
 const {data:{user}}=await supabase.auth.getUser();
 if(!user)redirect("/login");
 const {data:profile}=await supabase.from("profiles").select("name,role").eq("id",user.id).maybeSingle();
 const initialProfile={name:profile?.name||user.email||"사용자",role:profile?.role||"STAFF"};
 return <RoleProvider initialProfile={initialProfile}><AdminStoreProvider><Sidebar/><div className="min-h-screen lg:pl-[248px]"><Header/><main className="min-w-0 max-w-full overflow-x-hidden p-3 sm:p-4 lg:p-7"><AccessGuard>{children}</AccessGuard></main></div></AdminStoreProvider></RoleProvider>;
}
