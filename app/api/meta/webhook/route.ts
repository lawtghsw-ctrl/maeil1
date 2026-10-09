import {createHmac, timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {createAdminClient} from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const env=(...names:string[])=>names.map(name=>process.env[name]?.trim()).find(Boolean)||"";

function verifyMetaSignature(rawBody:string,signatureHeader:string,appSecret:string){
 if(!appSecret)return true;
 if(!signatureHeader.startsWith("sha256="))return false;
 const received=signatureHeader.slice("sha256=".length);
 const expected=createHmac("sha256",appSecret).update(rawBody,"utf8").digest("hex");
 const a=Buffer.from(received,"hex");
 const b=Buffer.from(expected,"hex");
 return a.length===b.length&&timingSafeEqual(a,b);
}

function normalizePhone(value:string){
 let digits=value.replace(/\D/g,"");
 if(!digits)return "";
 if(digits.startsWith("82")&&digits.length>=11)digits=`0${digits.slice(2)}`;
 if(digits.length===10&&digits.startsWith("10"))digits=`0${digits}`;
 return digits.slice(0,11);
}

function formatPhone(value:string){
 const digits=normalizePhone(value);
 if(digits.length===11)return `${digits.slice(0,3)}-${digits.slice(3,7)}-${digits.slice(7)}`;
 if(digits.length===10)return `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
 return digits||value.trim();
}

type MetaField={name?:string;values?:unknown[]};
type MetaLead={id?:string;created_time?:string;field_data?:MetaField[]};

function extractField(lead:MetaLead,names:string[]){
 const fields=Array.isArray(lead.field_data)?lead.field_data:[];
 const wanted=new Set(names.map(name=>name.toLowerCase()));
 for(const field of fields){
  const name=String(field?.name||"").toLowerCase();
  if(!wanted.has(name))continue;
  const value=Array.isArray(field?.values)?field.values[0]:"";
  return String(value??"").trim();
 }
 return "";
}

async function fetchLead(leadgenId:string,accessToken:string,graphVersion:string){
 const url=new URL(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(leadgenId)}`);
 url.searchParams.set("fields","id,created_time,field_data");
 url.searchParams.set("access_token",accessToken);
 const response=await fetch(url,{cache:"no-store"});
 const data=await response.json().catch(()=>({}));
 if(!response.ok){
  const message=String(data?.error?.message||data?.message||`Meta Lead 조회 실패 (${response.status})`);
  throw new Error(message);
 }
 return data as MetaLead;
}

async function saveLead(leadgenId:string){
 const accessToken=env("META_PAGE_ACCESS_TOKEN","META_LEAD_ACCESS_TOKEN");
 const graphVersion=env("META_GRAPH_API_VERSION")||"v26.0";
 if(!accessToken)throw new Error("META_PAGE_ACCESS_TOKEN 환경변수가 필요합니다.");

 const lead=await fetchLead(leadgenId,accessToken,graphVersion);
 const customerName=extractField(lead,["full_name","name","customer_name"]);
 const phoneNumber=formatPhone(extractField(lead,["phone_number","phone","mobile_phone"]));
 const parsedCreatedAt=lead.created_time?new Date(lead.created_time):null;
 const createdAt=parsedCreatedAt&&!Number.isNaN(parsedCreatedAt.getTime())?parsedCreatedAt.toISOString():new Date().toISOString();

 if(!customerName&&!phoneNumber)throw new Error("Meta Lead에서 full_name / phone_number 값을 찾지 못했습니다.");

 const supabase=createAdminClient();
 const {error}=await supabase.from("meta_leads").upsert({
  meta_lead_id:String(lead.id||leadgenId),
  created_at:createdAt,
  customer_name:customerName,
  phone_number:phoneNumber,
  meta_native_lead_id:String(lead.id||leadgenId),
  lead_result:"신규DB",
  new_db_alert_enabled:true,
 },{onConflict:"meta_lead_id",ignoreDuplicates:true});
 if(error)throw new Error(error.message);
}

export async function GET(request:Request){
 const url=new URL(request.url);
 const mode=url.searchParams.get("hub.mode");
 const verifyToken=url.searchParams.get("hub.verify_token");
 const challenge=url.searchParams.get("hub.challenge")||"";
 const expected=env("META_WEBHOOK_VERIFY_TOKEN");

 if(mode==="subscribe"&&expected&&verifyToken===expected){
  return new Response(challenge,{status:200,headers:{"Content-Type":"text/plain"}});
 }
 return new Response("Forbidden",{status:403});
}

export async function POST(request:Request){
 try{
  const rawBody=await request.text();
  const appSecret=env("META_APP_SECRET");
  const signature=request.headers.get("x-hub-signature-256")||"";
  if(appSecret&&!verifyMetaSignature(rawBody,signature,appSecret)){
   return NextResponse.json({error:"Invalid Meta webhook signature"},{status:401});
  }

  const payload=JSON.parse(rawBody||"{}");
  if(payload?.object!=="page")return NextResponse.json({ok:true,ignored:true});

  const leadIds:string[]=[];
  for(const entry of Array.isArray(payload?.entry)?payload.entry:[]){
   for(const change of Array.isArray(entry?.changes)?entry.changes:[]){
    if(change?.field!=="leadgen")continue;
    const leadgenId=String(change?.value?.leadgen_id||"").trim();
    if(leadgenId)leadIds.push(leadgenId);
   }
  }

  const unique=[...new Set(leadIds)];
  const results=await Promise.allSettled(unique.map(saveLead));
  results.forEach((result,index)=>{
   if(result.status==="rejected")console.error("Meta lead sync failed",unique[index],result.reason);
  });

  return NextResponse.json({ok:true,received:unique.length,saved:results.filter(x=>x.status==="fulfilled").length});
 }catch(error){
  console.error("Meta webhook error",error);
  return NextResponse.json({error:error instanceof Error?error.message:"Meta webhook 처리 중 오류가 발생했습니다."},{status:500});
 }
}
