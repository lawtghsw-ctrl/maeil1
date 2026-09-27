import {createClient} from "@supabase/supabase-js";

export function createAdminClient(){
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
 const key=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)throw new Error("SUPABASE_SECRET_KEY(또는 SUPABASE_SERVICE_ROLE_KEY)가 필요합니다.");
 return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
}
