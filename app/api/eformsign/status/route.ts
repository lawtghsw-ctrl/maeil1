import {createPrivateKey, sign as cryptoSign} from "node:crypto";
import {NextResponse} from "next/server";
import {createClient} from "@/lib/supabase/server";

export const runtime="nodejs";

const env=(...names:string[])=>names.map(n=>process.env[n]).find(Boolean)?.trim()||"";

function createEformsignSignature(executionTime:number,privateKeyHex:string){
 const normalized=privateKeyHex.replace(/\s+/g,"").replace(/^0x/i,"");
 if(!/^[0-9a-f]+$/i.test(normalized)||normalized.length%2!==0)throw new Error("EFORMSIGN_PRIVATE_KEY 값이 올바른 hex 형식이 아닙니다.");
 const key=createPrivateKey({key:Buffer.from(normalized,"hex"),format:"der",type:"pkcs8"});
 return cryptoSign("sha256",Buffer.from(String(executionTime),"utf8"),key).toString("hex");
}

async function getAccess(){
 const apiKey=env("EFORMSIGN_API_KEY","EFORM_SIGN_API_KEY");
 const senderMemberId=env("EFORMSIGN_SENDER_MEMBER_ID");
 const fallbackMemberId=env("EFORMSIGN_MEMBER_ID","EFORM_SIGN_MEMBER_ID");
 const memberIds=[...new Set([senderMemberId,fallbackMemberId].filter(Boolean))];
 const privateKey=env("EFORMSIGN_PRIVATE_KEY","EFORM_SIGN_PRIVATE_KEY");
 if(!apiKey||!memberIds.length||!privateKey)throw new Error("이폼사인 API 환경변수를 확인해주세요.");
 let lastError="";
 for(const memberId of memberIds){
  const executionTime=Date.now();
  const signature=createEformsignSignature(executionTime,privateKey);
  const r=await fetch("https://service.eformsign.com/v2.0/api_auth/access_token",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${Buffer.from(apiKey,"utf8").toString("base64")}`,"eformsign_signature":signature},body:JSON.stringify({execution_time:executionTime,member_id:memberId}),cache:"no-store"});
  const j=await r.json().catch(()=>({}));
  if(r.ok){const accessToken=String(j?.oauth_token?.access_token||"");const apiUrl=String(j?.api_key?.company?.api_url||"").replace(/\/$/,"");if(accessToken&&apiUrl)return{accessToken,apiUrl};}
  lastError=j?.ErrorMessage||j?.message||`Access Token 발급 실패 (${r.status})`;
 }
 throw new Error(lastError||"이폼사인 Access Token 발급에 실패했습니다.");
}

function pickStatus(data:any){
 const direct=data?.document?.current_status?.status_type||data?.current_status?.status_type||data?.document?.status?.status_type||data?.status?.status_type||data?.document?.status_type||data?.status_type;
 if(direct)return String(direct);
 const list:Array<any>=Array.isArray(data?.status_list)?data.status_list:Array.isArray(data?.document?.status_list)?data.document.status_list:[];
 if(list.length){const last=list[list.length-1];return String(last?.current_status?.status_type||last?.status_type||last?.action_type||last?.status||"");}
 return "";
}

async function lookupStatus(apiUrl:string,accessToken:string,documentId:string){
 const headers={"Authorization":`Bearer ${accessToken}`};
 const urls=[`${apiUrl}/v2.0/api/documents/${encodeURIComponent(documentId)}`,`${apiUrl}/v2.0/api/documents/${encodeURIComponent(documentId)}/status`,`${apiUrl}/v1.0/api/documents/${encodeURIComponent(documentId)}`,`${apiUrl}/v1.0/api/documents/${encodeURIComponent(documentId)}/status`];
 let last:any={};let statusCode=500;
 for(const url of urls){
  const r=await fetch(url,{headers,cache:"no-store"});statusCode=r.status;last=await r.json().catch(()=>({}));
  if(r.ok){const status=pickStatus(last);if(status)return{status,raw:last};}
  if(r.status!==404&&r.ok===false)break;
 }
 throw new Error(last?.ErrorMessage||last?.message||`문서 상태 조회 실패 (${statusCode})`);
}

export async function POST(req:Request){
 try{
  const supabase=await createClient();
  const {data:{user}}=await supabase.auth.getUser();
  if(!user)return NextResponse.json({error:"로그인이 필요합니다."},{status:401});
  const body=await req.json().catch(()=>({}));
  const customerId=String(body?.customerId||"").trim();
  let query=supabase.from("customers").select("id,name,eformsign_document_id").not("eformsign_document_id","is",null).is("deleted_at",null);
  if(customerId)query=query.eq("id",customerId);
  const {data:customers,error}=await query;
  if(error)return NextResponse.json({error:error.message},{status:500});
  const targets=(customers||[]).filter(c=>String(c.eformsign_document_id||"").trim());
  if(!targets.length)return NextResponse.json({ok:true,updated:0,results:[]});
  const {accessToken,apiUrl}=await getAccess();
  const results:any[]=[];
  for(const c of targets){
   try{
    const x=await lookupStatus(apiUrl,accessToken,String(c.eformsign_document_id));
    const updatedAt=new Date().toISOString();
    const u=await supabase.from("customers").update({eformsign_status:x.status,eformsign_updated_at:updatedAt}).eq("id",c.id);
    if(u.error)throw new Error(u.error.message);
    results.push({customerId:c.id,name:c.name,status:x.status,ok:true});
   }catch(e){results.push({customerId:c.id,name:c.name,ok:false,error:e instanceof Error?e.message:"상태 조회 실패"});}
  }
  return NextResponse.json({ok:true,updated:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length,results});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"이폼사인 상태 조회 중 오류가 발생했습니다."},{status:500})}
}
