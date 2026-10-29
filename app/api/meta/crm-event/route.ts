import {createHash} from "node:crypto";
import {NextResponse} from "next/server";
import {createClient} from "@/lib/supabase/server";
import {createAdminClient} from "@/lib/supabase/admin";

export const runtime="nodejs";
export const dynamic="force-dynamic";

const env=(...names:string[])=>names.map(name=>String(process.env[name]||"").trim()).find(Boolean)||"";
const allowedResults=["신규","부재","설득필요","상담중","계약완료","전환완료","장기부재","불가","허수","전환","부재중","재연락","유효리드"] as const;
type LeadResult=typeof allowedResults[number];

const eventNames:Record<LeadResult,string>={
 "신규":"crm_new",
 "부재":"crm_no_answer",
 "설득필요":"crm_follow_up",
 "상담중":"crm_contacted",
 "계약완료":"crm_converted",
 "전환완료":"crm_converted",
 "장기부재":"crm_long_no_answer",
 "불가":"crm_disqualified",
 "허수":"crm_invalid",
 "전환":"crm_converted",
 // 구버전 호환
 "부재중":"crm_no_answer",
 "재연락":"crm_follow_up",
 "유효리드":"crm_qualified",
};

const metaSendResults=new Set<LeadResult>(["상담중","계약완료","전환완료","유효리드","전환"]);

function normalizePhoneForMeta(value:string){
 let digits=String(value||"").replace(/\D/g,"");
 if(!digits)return "";
 if(digits.startsWith("82"))return digits;
 if(digits.length===10&&digits.startsWith("10"))digits=`0${digits}`;
 if(digits.startsWith("0"))return `82${digits.slice(1)}`;
 return digits;
}

function sha256(value:string){return createHash("sha256").update(value,"utf8").digest("hex")}

async function markLead(id:string,patch:Record<string,unknown>){
 const admin=createAdminClient();
 const {error}=await admin.from("meta_leads").update(patch).eq("id",id);
 if(error)console.error("Meta CRM result bookkeeping failed",error);
}

export async function POST(request:Request){
 try{
  const auth=await createClient();
  const {data:{user}}=await auth.auth.getUser();
  if(!user)return NextResponse.json({error:"로그인이 필요합니다."},{status:401});

  const body=await request.json().catch(()=>({}));
  const leadId=String(body?.leadId||"").trim();
  const leadResult=String(body?.leadResult||"").trim() as LeadResult;
  if(!leadId||!allowedResults.includes(leadResult))return NextResponse.json({error:"전송할 신규DB와 Meta 결과값을 확인해주세요."},{status:400});
  if(!metaSendResults.has(leadResult))return NextResponse.json({ok:true,sent:false,skipped:true,message:"부재·설득필요·장기부재·불가·허수 등 내부 관리 상태는 Meta로 전송하지 않습니다."});

  const admin=createAdminClient();
  const {data:lead,error}=await admin.from("meta_leads").select("id,meta_lead_id,meta_native_lead_id,customer_name,phone_number,meta_event_name,meta_event_sent_at").eq("id",leadId).maybeSingle();
  if(error)throw new Error(error.message);
  if(!lead)return NextResponse.json({error:"신규DB를 찾을 수 없습니다."},{status:404});
  const sourceId=String(lead.meta_lead_id||"");
  const nativeId=String(lead.meta_native_lead_id||"").trim();
  if(sourceId.startsWith("manual:")||(!nativeId&&!sourceId.startsWith("gsheet:")&&!sourceId.startsWith("gsheet-instant:"))){
   return NextResponse.json({ok:true,sent:false,skipped:true,reason:"Meta 광고 출처가 확인되지 않은 DB는 전송 제외"});
  }

  const eventName=eventNames[leadResult];
  if((leadResult==="계약완료"||leadResult==="전환완료"||leadResult==="전환")&&lead.meta_event_name==="crm_converted"&&lead.meta_event_sent_at){
   return NextResponse.json({ok:true,sent:false,alreadySent:true,eventName,sentAt:lead.meta_event_sent_at});
  }

  const datasetId=env("META_CRM_DATASET_ID","META_PIXEL_ID");
  const accessToken=env("META_CRM_ACCESS_TOKEN","META_CONVERSIONS_ACCESS_TOKEN");
  const graphVersion=env("META_GRAPH_API_VERSION")||"v26.0";
  const testEventCode=env("META_CRM_TEST_EVENT_CODE");

  if(!datasetId||!accessToken){
   const message="Meta CRM CAPI 환경변수가 아직 설정되지 않았습니다.";
   await markLead(leadId,{meta_event_name:eventName,meta_event_sent_at:null,meta_event_error:message});
   return NextResponse.json({ok:true,sent:false,configured:false,eventName,message});
  }

  const nativeLeadId=String(lead.meta_native_lead_id||"").trim();
  const phone=normalizePhoneForMeta(String(lead.phone_number||""));
  const userData:Record<string,unknown>={};
  if(nativeLeadId)userData.lead_id=nativeLeadId;
  if(phone)userData.ph=[sha256(phone)];
  if(!nativeLeadId&&lead.meta_lead_id)userData.external_id=[sha256(String(lead.meta_lead_id))];
  if(!Object.keys(userData).length){
   const message="Meta 매칭에 사용할 Lead ID 또는 연락처가 없습니다.";
   await markLead(leadId,{meta_event_name:eventName,meta_event_sent_at:null,meta_event_error:message});
   return NextResponse.json({ok:true,sent:false,configured:true,eventName,message});
  }

  const payload:Record<string,unknown>={
   data:[{
    event_name:eventName,
    event_time:Math.floor(Date.now()/1000),
    action_source:"system_generated",
    user_data:userData,
    custom_data:{
     event_source:"crm",
     lead_event_source:"ropower_admin",
     lead_status:leadResult,
    },
   }],
  };
  if(testEventCode)payload.test_event_code=testEventCode;

  const response=await fetch(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(datasetId)}/events`,{
   method:"POST",
   headers:{"Content-Type":"application/json","Authorization":`Bearer ${accessToken}`},
   body:JSON.stringify(payload),
   cache:"no-store",
  });
  const responseText=await response.text();
  let responseBody:any={raw:responseText};
  try{responseBody=JSON.parse(responseText||"{}")}catch{}
  if(!response.ok){
   const message=String(responseBody?.error?.message||responseBody?.message||`Meta CRM CAPI 전송 실패 (${response.status})`);
   await markLead(leadId,{meta_event_name:eventName,meta_event_sent_at:null,meta_event_error:message});
   return NextResponse.json({error:message,detail:responseBody},{status:502});
  }

  const sentAt=new Date().toISOString();
  await markLead(leadId,{meta_event_name:eventName,meta_event_sent_at:sentAt,meta_event_error:null});
  return NextResponse.json({ok:true,sent:true,configured:true,eventName,sentAt,matchedBy:nativeLeadId?"lead_id":"hashed_phone",meta:responseBody});
 }catch(error){
  console.error("Meta CRM CAPI error",error);
  return NextResponse.json({error:error instanceof Error?error.message:"Meta CRM CAPI 처리 중 오류가 발생했습니다."},{status:500});
 }
}
