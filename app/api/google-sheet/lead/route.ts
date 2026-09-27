import {NextResponse} from "next/server";
import {createAdminClient} from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SheetLeadPayload={
  created_time?:unknown;
  full_name?:unknown;
  phone_number?:unknown;
  leadgen_id?:unknown;
  spreadsheet_id?:unknown;
  sheet_id?:unknown;
  row_number?:unknown;
};

const env=(name:string)=>String(process.env[name]||"").trim();
const str=(value:unknown)=>String(value??"").trim();

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

function toIso(value:string){
  if(!value)return new Date().toISOString();
  const parsed=new Date(value);
  return Number.isNaN(parsed.getTime())?new Date().toISOString():parsed.toISOString();
}

function escapeHtml(value:string){
  return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

async function sendTelegram(createdTime:string,name:string,phone:string){
  const botToken=env("TELEGRAM_BOT_TOKEN");
  const chatId=env("TELEGRAM_CHAT_ID");
  if(!botToken||!chatId)return;

  const text=[
    "<b>🔔 신규 DB 접수</b>",
    "",
    `<b>접수시간</b>  ${escapeHtml(createdTime||"-")}`,
    `<b>이름</b>  ${escapeHtml(name||"-")}`,
    `<b>연락처</b>  ${escapeHtml(phone||"-")}`,
  ].join("\n");

  const response=await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML",disable_web_page_preview:true}),
    cache:"no-store",
  });
  if(!response.ok){
    const detail=await response.text().catch(()=>"");
    throw new Error(`Telegram 알림 실패 (${response.status}) ${detail}`.trim());
  }
}

export async function POST(request:Request){
  try{
    const expected=env("GOOGLE_SHEET_INGEST_SECRET");
    const received=str(request.headers.get("x-ingest-secret"));
    if(!expected||received!==expected){
      return NextResponse.json({error:"Unauthorized"},{status:401});
    }

    const body=(await request.json().catch(()=>({}))) as SheetLeadPayload;
    const createdTime=str(body.created_time);
    const customerName=str(body.full_name);
    const phoneNumber=formatPhone(str(body.phone_number));
    const nativeLeadId=str(body.leadgen_id);
    const spreadsheetId=str(body.spreadsheet_id);
    const sheetId=str(body.sheet_id);
    const rowNumber=str(body.row_number);

    if(!createdTime||(!customerName&&!phoneNumber)){
      return NextResponse.json({error:"created_time 및 이름/연락처 데이터가 필요합니다."},{status:400});
    }

    const sourceKey=["gsheet",spreadsheetId||"unknown",sheetId||"unknown",rowNumber||`${createdTime}:${customerName}:${phoneNumber}`].join(":");
    const supabase=createAdminClient();
    const {error}=await supabase.from("meta_leads").insert({
      meta_lead_id:sourceKey,
      created_at:toIso(createdTime),
      customer_name:customerName,
      phone_number:phoneNumber,
      meta_native_lead_id:nativeLeadId||null,
    });

    if(error){
      if(error.code==="23505"){
        if(nativeLeadId){
          const {error:updateError}=await supabase.from("meta_leads").update({meta_native_lead_id:nativeLeadId}).eq("meta_lead_id",sourceKey).is("meta_native_lead_id",null);
          if(updateError)console.error("Google Sheet native lead id backfill failed",updateError);
        }
        return NextResponse.json({ok:true,duplicate:true});
      }
      throw new Error(error.message);
    }

    await sendTelegram(createdTime,customerName,phoneNumber);
    return NextResponse.json({ok:true,saved:true});
  }catch(error){
    console.error("Google Sheet lead ingest error",error);
    return NextResponse.json({error:error instanceof Error?error.message:"신규 DB 처리 중 오류가 발생했습니다."},{status:500});
  }
}
