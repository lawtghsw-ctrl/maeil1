import {createPrivateKey, sign as cryptoSign} from "node:crypto";
import {NextResponse} from "next/server";
import {createClient} from "@/lib/supabase/server";

export const runtime="nodejs";

const env=(...names:string[])=>names.map(n=>process.env[n]).find(Boolean)?.trim()||"";

function cleanPhone(value:string){return value.replace(/[^0-9]/g,"")}
function fieldDateParts(date:string){const [,month="",day=""]=date.split("-");return{month:String(Number(month)||""),day:String(Number(day)||"")}}

function createEformsignSignature(executionTime:number,privateKeyHex:string){
 const normalized=privateKeyHex.replace(/\s+/g,"").replace(/^0x/i,"");
 if(!/^[0-9a-f]+$/i.test(normalized)||normalized.length%2!==0)throw new Error("EFORMSIGN_PRIVATE_KEY 값이 올바른 hex 형식이 아닙니다.");
 const key=createPrivateKey({key:Buffer.from(normalized,"hex"),format:"der",type:"pkcs8"});
 return cryptoSign("sha256",Buffer.from(String(executionTime),"utf8"),key).toString("hex");
}

export async function POST(req:Request){
 try{
  const supabase=await createClient();
  const {data:{user}}=await supabase.auth.getUser();
  if(!user)return NextResponse.json({error:"로그인이 필요합니다."},{status:401});

  const apiKey=env("EFORMSIGN_API_KEY","EFORM_SIGN_API_KEY");
  const templateId=env("EFORMSIGN_TEMPLATE_ID","EFORM_SIGN_TEMPLATE_ID");
  const senderMemberId=env("EFORMSIGN_SENDER_MEMBER_ID");
  const fallbackMemberId=env("EFORMSIGN_MEMBER_ID","EFORM_SIGN_MEMBER_ID");
  const memberIds=[...new Set([senderMemberId,fallbackMemberId].filter(Boolean))];
  const privateKey=env("EFORMSIGN_PRIVATE_KEY","EFORM_SIGN_PRIVATE_KEY");
  if(!apiKey||!templateId)return NextResponse.json({error:"서버에 EFORMSIGN_API_KEY와 EFORMSIGN_TEMPLATE_ID를 설정해주세요."},{status:500});
  if(!memberIds.length||!privateKey)return NextResponse.json({error:"이폼사인 Signature 인증용 EFORMSIGN_SENDER_MEMBER_ID(또는 EFORMSIGN_MEMBER_ID)와 EFORMSIGN_PRIVATE_KEY를 환경변수에 추가해주세요."},{status:500});

  const body=await req.json();
  const customerId=String(body.customerId||"").trim();
  if(!customerId)return NextResponse.json({error:"고객 ID가 필요합니다."},{status:400});
  const {data:customer,error:customerError}=await supabase.from("customers").select("id,name,phone,address,birth_number,contract_date,contract_amount,upfront_amount,installment_period,lender_unit_price,lender_count").eq("id",customerId).is("deleted_at",null).maybeSingle();
  if(customerError)return NextResponse.json({error:customerError.message},{status:500});
  if(!customer)return NextResponse.json({error:"고객 정보를 찾지 못했습니다."},{status:404});

  const name=String(customer.name||"").trim();
  const phone=cleanPhone(String(body.phone||customer.phone||""));
  const email=String(body.email||"").trim();
  const address=String(customer.address||"").trim();
  const birthNumber=String(customer.birth_number||"").trim();
  const contractDate=String(customer.contract_date||"");
  const contractAmount=Number(customer.contract_amount||0);
  const lenderUnitPrice=Number(customer.lender_unit_price||0);
  const lenderCount=Number(customer.lender_count||0);
  const message=String(body.message||"계약서 확인 후 서명 부탁드립니다.");
  if(!name||(!phone&&!email))return NextResponse.json({error:"고객명과 전화번호 또는 이메일이 필요합니다."},{status:400});
  if(!contractDate)return NextResponse.json({error:"고객정보에 계약일을 입력해주세요."},{status:400});

  let tokenData:any={};let accessToken="";let apiUrl="";let tokenError="";
  for(const memberId of memberIds){
   const executionTime=Date.now();
   const signature=createEformsignSignature(executionTime,privateKey);
   const tokenResponse=await fetch("https://service.eformsign.com/v2.0/api_auth/access_token",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${Buffer.from(apiKey,"utf8").toString("base64")}`,"eformsign_signature":signature},body:JSON.stringify({execution_time:executionTime,member_id:memberId}),cache:"no-store"});
   tokenData=await tokenResponse.json().catch(()=>({}));
   if(tokenResponse.ok){accessToken=String(tokenData?.oauth_token?.access_token||"");apiUrl=String(tokenData?.api_key?.company?.api_url||"").replace(/\/$/,"");if(accessToken&&apiUrl)break;}
   tokenError=tokenData?.ErrorMessage||tokenData?.message||`Access Token 발급 실패 (${tokenResponse.status})`;
  }
  if(!accessToken||!apiUrl)return NextResponse.json({error:tokenError||"이폼사인 Access Token 발급에 실패했습니다.",detail:tokenData},{status:502});

  const {month,day}=fieldDateParts(contractDate);
  const money=(value:number)=>Math.max(0,Math.round(value)).toLocaleString("ko-KR");
  // 로파워 사건위임약정서 템플릿의 실제 입력항목 ID에 맞춘 매핑.
  // 갑_서명란은 고객이 직접 서명해야 하므로 자동 입력하지 않는다.
  const fields=[
   {id:"갑(위임인)이름",value:name},
   {id:"텍스트 1",value:address},
   {id:"텍스트 2",value:birthNumber},
   {id:"텍스트 3",value:String(customer.phone||phone)},
   {id:"수수료",value:"50"},
   {id:"사채업체",value:String(lenderCount)},
   {id:"보수",value:money(contractAmount)},
   {id:"채권자1건당금액",value:money(lenderUnitPrice)},
   {id:"텍스트 4",value:month},
   {id:"텍스트 5",value:day},
   {id:"갑(위임인)",value:name},
  ];

  const document={
   document_name:`${name} 사건위임약정서`,comment:message,
   recipients:[{step_type:"05",use_mail:Boolean(email),use_sms:Boolean(phone),member:{name,id:email,sms:{country_code:"+82",phone_number:phone}},auth:{valid:{day:7,hour:0}}}],
   fields,select_group_name:"",notification:[]
  };
  const urls=[`${apiUrl}/v2.0/api/documents?template_id=${encodeURIComponent(templateId)}`,`${apiUrl}/v1.0/api/documents?template_id=${encodeURIComponent(templateId)}`];
  let lastStatus=500;let result:any={};
  for(const url of urls){
   const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${accessToken}`},body:JSON.stringify({document}),cache:"no-store"});
   lastStatus=r.status;result=await r.json().catch(()=>({}));
   if(r.ok){
    const documentId=String(result?.document?.id||result?.document_id||result?.id||"");
    if(documentId){
     const tracking=await supabase.from("customers").update({eformsign_document_id:documentId,eformsign_status:"doc_create",eformsign_updated_at:new Date().toISOString()}).eq("id",customerId);
     if(tracking.error)console.error("eformsign tracking update failed",tracking.error.message);
    }
    return NextResponse.json({ok:true,documentId,result});
   }
   if(r.status!==404)break;
  }
  return NextResponse.json({error:result?.ErrorMessage||result?.message||result?.error||`이폼사인 문서 전송 실패 (${lastStatus})`,detail:result},{status:502});
 }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"이폼사인 전송 중 오류가 발생했습니다."},{status:500})}
}
