import {NextResponse} from "next/server";

type ContactType="번호"|"텔레그램"|"카카오톡"|"라인"|"";
type Confidence="높음"|"보통"|"낮음";
type ParsedLender={
 lenderName:string;contactType:ContactType;contactValue:string;totalBorrowed:number;totalRepaid:number;lastBorrowed:number;repaymentAmount:number;dueDate:string;account:string;reborrowCount:number;memo:string;confidence:Confidence;reviewReasons:string[];
};
type ParsedPayment={dueDate:string;amount:number;status:"예정"|"완료";memo:string;confidence:Confidence;reviewReasons:string[]};
type ParseResult={lenders:ParsedLender[];feePayments:ParsedPayment[];warnings:string[];mode:"ai"|"local"};

function kstToday(){return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}
function addDays(date:string,days:number){const [y,m,d]=date.split("-").map(Number);const x=new Date(Date.UTC(y,m-1,d+days));return `${x.getUTCFullYear()}-${String(x.getUTCMonth()+1).padStart(2,"0")}-${String(x.getUTCDate()).padStart(2,"0")}`}
function amountFrom(text:string){
 const t=text.replace(/,/g,"");
 const man=t.match(/(-?\d+(?:\.\d+)?)\s*만\s*원?/);if(man)return Math.round(Number(man[1])*10000);
 const won=t.match(/(-?\d{3,})\s*원/);if(won)return Number(won[1]);
 const bare=t.match(/(?:^|\s)(\d{1,3})(?=\s*(?:갚|상환|빌|입금|납부|줘|$))/);if(bare)return Number(bare[1])*10000;
 return 0;
}
function dateFrom(text:string,today:string){
 if(/내일/.test(text))return addDays(today,1);
 if(/오늘/.test(text))return today;
 const m=text.match(/(?:(20\d{2})[.\-/년]\s*)?(\d{1,2})\s*[월.\-/]\s*(\d{1,2})\s*일?/);
 if(!m)return "";const year=m[1]?Number(m[1]):Number(today.slice(0,4));return `${year}-${String(Number(m[2])).padStart(2,"0")}-${String(Number(m[3])).padStart(2,"0")}`;
}
function contactTypeFrom(text:string):ContactType{if(/텔레(?:그램)?/i.test(text))return "텔레그램";if(/카카오톡|카톡/i.test(text))return "카카오톡";if(/라인/i.test(text))return "라인";if(/전화|번호|010[-\d ]{7,}/.test(text))return "번호";return ""}
function contactValueFrom(text:string,type:ContactType){
 if(type==="텔레그램"){const m=text.match(/@[A-Za-z0-9_]+/);return m?.[0]||""}
 if(type==="번호"){const m=text.match(/01[016789][\s-]?\d{3,4}[\s-]?\d{4}/);return m?.[0]?.replace(/\s+/g,"")||""}
 if(type==="카카오톡"||type==="라인"){
  if(/아이디\s*(?:모름|모르|없)/.test(text))return "";
  const re=type==="카카오톡"?/(?:카카오톡|카톡)\s*(?:아이디|ID|:)?\s*([A-Za-z0-9_.-]{3,})/i:/(?:라인)\s*(?:아이디|ID|:)?\s*([A-Za-z0-9_.-]{3,})/i;
  return text.match(re)?.[1]||"";
 }
 return "";
}
function splitBlocks(text:string){
 const normalized=text.replace(/\r/g,"").trim();
 const matches=[...normalized.matchAll(/(?:^|\n)\s*(?:(?:사채\s*)?\d+)\s*[.)번]?\s*/g)];
 if(matches.length<=1)return normalized.split(/\n\s*\n(?=\S)/).map(x=>x.trim()).filter(Boolean);
 const blocks:string[]=[];for(let i=0;i<matches.length;i++){const start=(matches[i].index||0)+(matches[i][0].startsWith("\n")?1:0);const end=i+1<matches.length?(matches[i+1].index||normalized.length):normalized.length;blocks.push(normalized.slice(start,end).trim())}return blocks;
}
function lenderNameFromBlock(block:string){
 const lines=block.replace(/\r/g,"").split("\n").map(x=>x.trim()).filter(Boolean);
 const labeled=lines.find(x=>/^\[?\s*업체명\s*\]?\s*[:：]/.test(x));
 if(labeled){
  const value=labeled.replace(/^\[?\s*업체명\s*\]?\s*[:：]\s*/,"").trim();
  if(value)return value.replace(/[,:：]$/,"").trim();
 }
 const first=lines[0]||"";
 let head=first.replace(/^\s*(?:(?:사채\s*)?\d+)\s*[.)번]?\s*/,"").trim();
 head=head.replace(/^\[?\s*업체명\s*\]?\s*[:：]?\s*/,"").trim();
 if(!head||/^(?:총합계|총\s*합계|마지막건|마지막권|계좌|상환|연락수단)$/i.test(head))return "";
 const cut=head.split(/\s*(?:\(|@|텔레그램|텔레\s*그램|카카오톡|카톡|라인|전화번호|연락처)\b/i)[0].trim();
 const cleaned=(cut||head).replace(/[,:：]$/,"").trim();
 if(!cleaned||/^\d{6,}$/.test(cleaned)||/(?:은행|계좌|예금주)/.test(cleaned))return "";
 return cleaned;
}
function isLikelyAccountHolderName(name:string,account:string){
 const n=name.trim();if(!n||!account.includes(n))return false;
 if(!/(?:은행|뱅크|계좌|예금주|\d{8,})/.test(account))return false;
 const escaped=n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
 return new RegExp(`(?:은행|뱅크|예금주|\\d{8,})[^\\n/]{0,40}${escaped}(?:\\s|$|/)`).test(account);
}
function accountFromLines(lines:string[]){
 return lines.filter(x=>{
  if(/(?:빌린|갚은)\s*금액|상환\s*예정\s*금액/.test(x))return false;
  return /(?:은행|뱅크|계좌|예금주|상품권|구매\s*후|구매후|전달)/.test(x)||/\b\d{8,16}\b/.test(x.replace(/[-\s]/g,""));
 }).join(" / ");
}
function localParse(text:string):ParseResult{
 const today=kstToday();const lenders:ParsedLender[]=[];
 for(const block of splitBlocks(text)){
  const lines=block.split("\n").map(x=>x.trim()).filter(Boolean);if(!lines.length)continue;
  const name=lenderNameFromBlock(block);
  const type=contactTypeFrom(block);const contact=contactValueFrom(block,type);
  const totalSection=block.match(/총(?:합계)?[\s\S]*?(?=마지막(?:건|권)|$)/)?.[0]||"";
  const lastSection=block.match(/마지막(?:건|권)[\s\S]*/)?.[0]||block;
  const totalBorrowed=amountFrom(totalSection.match(/빌린\s*금액[^\n]*/)?.[0]||totalSection.match(/총[^\n]*(?:빌|차용)[^\n]*/)?.[0]||"");
  const totalRepaid=amountFrom(totalSection.match(/(?:갚은|상환)\s*금액[^\n]*/)?.[0]||"");
  const lastBorrowed=amountFrom(lastSection.match(/(?:빌린\s*금액|\b\d+\s*만원?\s*빌)[^\n]*/)?.[0]||"");
  let repaymentAmount=0;
  const futureLine=lines.find(x=>/(?:갚아야|갚으라|줘야|상환\s*예정|까지\s*\d+|내일까지)/.test(x));
  if(futureLine)repaymentAmount=amountFrom(futureLine.replace(/(?:빌리고|빌렸고)[^,.;\n]*/g,""));
  if(!repaymentAmount&&/마지막(?:건|권)/.test(block)){const m=lastSection.match(/(?:갚은\s*금액|갚은금|상환\s*금액)\s*([\d,.]+\s*만?원?)/);if(m)repaymentAmount=amountFrom(m[1])}
  const dueDate=dateFrom(block,today);
  const account=accountFromLines(lines);
  const reborrow=Number(block.match(/재\s*차용\s*(\d+)\s*번/)?.[1]||block.match(/총\s*(\d+)\s*회/)?.[1]||0);
  const reasons:string[]=[];if(!name)reasons.push("업체명 확인 필요");if(!type)reasons.push("연락수단 확인 필요");if(!contact)reasons.push("번호/아이디 확인 필요");if(!repaymentAmount)reasons.push("현재 상환 예정금액 확인 필요");if(!dueDate)reasons.push("상환 예정일 확인 필요");
  const memoParts:string[]=[];if(totalBorrowed)memoParts.push(`누적 차용 ${totalBorrowed.toLocaleString("ko-KR")}원`);if(totalRepaid)memoParts.push(`누적 상환 ${totalRepaid.toLocaleString("ko-KR")}원`);if(lastBorrowed)memoParts.push(`마지막 차용 ${lastBorrowed.toLocaleString("ko-KR")}원`);if(reborrow)memoParts.push(`재차용/차용 ${reborrow}회`);
  lenders.push({lenderName:name,contactType:type,contactValue:contact,totalBorrowed,totalRepaid,lastBorrowed,repaymentAmount,dueDate,account,reborrowCount:reborrow,memo:memoParts.join(" · "),confidence:reasons.length===0?"높음":reasons.length<=2?"보통":"낮음",reviewReasons:reasons});
 }
 return{lenders,feePayments:[],warnings:["로컬 분석 결과입니다. 연락처·상환일·금액 등 확인되지 않은 항목은 공란으로 둔 채 저장할 수 있습니다."],mode:"local"};
}
function responseText(payload:any){
 if(typeof payload?.output_text==="string")return payload.output_text;
 const chunks:string[]=[];for(const out of payload?.output||[]){for(const c of out?.content||[]){if(typeof c?.text==="string")chunks.push(c.text)}}return chunks.join("\n");
}
function parseJson(text:string){const clean=text.trim().replace(/^```(?:json)?\s*/i,"").replace(/```$/," ").trim();const first=clean.indexOf("{");const last=clean.lastIndexOf("}");if(first<0||last<first)throw new Error("JSON 응답을 찾지 못했습니다.");return JSON.parse(clean.slice(first,last+1))}
function normalizeAi(data:any,sourceText:string):ParseResult{
 const validTypes=new Set(["번호","텔레그램","카카오톡","라인"]);const validConfidence=new Set(["높음","보통","낮음"]);
 const blocks=splitBlocks(sourceText);
 const lenders=(Array.isArray(data?.lenders)?data.lenders:[]).map((x:any,index:number)=>{
  const account=String(x.account||"").trim();
  const sourceName=lenderNameFromBlock(blocks[index]||"");
  let lenderName=String(x.lenderName||"").trim();
  const reviewReasons:string[]=Array.isArray(x.reviewReasons)?x.reviewReasons.map((reason:any)=>String(reason)):[];
  // 원문 업체 헤더가 명확하면 AI가 계좌 예금주 등을 업체명으로 바꾸지 못하도록 원문 헤더를 우선합니다.
  if(sourceName)lenderName=sourceName;
  else if(isLikelyAccountHolderName(lenderName,account)){lenderName="";reviewReasons.unshift("계좌 예금주는 업체명이 아닙니다. 업체명 확인 필요")}
  if(!lenderName&&!reviewReasons.some((reason:string)=>reason.includes("업체명")))reviewReasons.unshift("업체명 확인 필요");
  return{lenderName,contactType:validTypes.has(x.contactType)?x.contactType:"",contactValue:String(x.contactValue||""),totalBorrowed:Number(x.totalBorrowed||0),totalRepaid:Number(x.totalRepaid||0),lastBorrowed:Number(x.lastBorrowed||0),repaymentAmount:Number(x.repaymentAmount||0),dueDate:String(x.dueDate||""),account,reborrowCount:Number(x.reborrowCount||0),memo:String(x.memo||""),confidence:validConfidence.has(x.confidence)?x.confidence:"보통",reviewReasons};
 });
 return{mode:"ai",warnings:Array.isArray(data?.warnings)?data.warnings.map(String):[],lenders,feePayments:(Array.isArray(data?.feePayments)?data.feePayments:[]).map((x:any)=>({dueDate:String(x.dueDate||""),amount:Number(x.amount||0),status:x.status==="완료"?"완료":"예정",memo:String(x.memo||""),confidence:validConfidence.has(x.confidence)?x.confidence:"보통",reviewReasons:Array.isArray(x.reviewReasons)?x.reviewReasons.map(String):[]}))};
}

export async function POST(request:Request){
 try{
  const body=await request.json();const text=String(body?.text||"").trim();if(!text)return NextResponse.json({error:"분석할 내용을 입력해주세요."},{status:400});if(text.length>30000)return NextResponse.json({error:"한 번에 분석할 내용이 너무 깁니다. 여러 번 나눠서 입력해주세요."},{status:400});
  const apiKey=process.env.OPENAI_API_KEY;
  if(!apiKey)return NextResponse.json(localParse(text));
  const today=kstToday();
  const prompt=`당신은 한국의 내부 CRM에서 고객이 자유롭게 작성한 사채업체 정보를 구조화하는 데이터 입력 보조 도구다. 오늘 날짜(KST)는 ${today}이다.

아래 원칙을 반드시 지켜라.
1. 업체별로 분리한다. 고객이 업체를 1., 2., 사채1., 사채2. 등 제각각 표현할 수 있다.
2. 없는 정보를 추측하지 않는다. 모름/없음/불명은 빈 문자열 또는 0으로 두고 reviewReasons에 넣는다. 연락수단, 연락처, 상환일, 금액, 계좌가 없어도 억지로 값을 만들지 않는다.
3. lenderName은 '김실장', '박부장', '정이사'처럼 고객이 사채업체/담당자 이름으로 명시한 값만 넣는다. 번호가 붙은 업체 블록의 첫 제목이나 [업체명] 항목을 최우선으로 사용한다.
4. 매우 중요: 계좌번호 뒤에 적힌 은행명과 예금주 이름은 lenderName이 아니다. 예: '3333166964460 카카오뱅크 황진협'에서 업체명은 황진협이 아니며, 이 전체 문구는 account에 넣는다. 예금주를 업체명으로 절대 추출하지 않는다. 업체명이 없으면 lenderName은 빈 문자열로 둔다.
5. 금액 단위: 10만원=100000, 40=문맥상 금액이면 400000원.
6. repaymentAmount는 현재/마지막으로 실제 앞으로 갚아야 한다고 명시된 상환 예정금액이다. 과거에 이미 갚은 누적금액을 넣지 않는다. '갚은금액'이라는 표현이 현재 계약금액인지 과거 지급액인지 애매하면 보수적으로 판단하고 reviewReasons에 '상환금액 확인 필요'를 추가한다.
7. dueDate는 현재 상환 예정일만 YYYY-MM-DD로 변환한다. '내일'은 ${addDays(today,1)}이다. 날짜가 없으면 빈 문자열.
8. account에는 계좌번호 + 은행명 + 예금주를 한 덩어리로 보존한다. 상품권 구매 후 전달 같은 지급방식도 account에 넣는다.
9. contactType은 번호/텔레그램/카카오톡/라인 중 하나 또는 빈 문자열. contactValue는 실제 번호/아이디만 넣는다.
10. feePayments는 오직 '수임료','선납','분납','법무법인/로파워에 납부'처럼 우리 회사 수임료 납부임이 명확한 내용만 추출한다. 사채업체에 갚는 돈은 절대 feePayments로 넣지 않는다.
11. memo에는 조율에 도움이 되는 재차용 횟수, 누적/마지막 차용 구조, 배우자 명의 등 핵심 참고사항을 간결히 적는다.
12. 결과는 설명 없이 JSON 하나만 출력한다.

JSON 형식:
{
 "lenders":[{
  "lenderName":"", "contactType":"", "contactValue":"",
  "totalBorrowed":0,"totalRepaid":0,"lastBorrowed":0,
  "repaymentAmount":0,"dueDate":"","account":"","reborrowCount":0,
  "memo":"","confidence":"높음|보통|낮음","reviewReasons":[]
 }],
 "feePayments":[{"dueDate":"","amount":0,"status":"예정|완료","memo":"","confidence":"높음|보통|낮음","reviewReasons":[]}],
 "warnings":[]
}

고객 원문:
${text}`;
  const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${apiKey}`},body:JSON.stringify({model:process.env.OPENAI_INTAKE_MODEL||"gpt-5.6-luna",input:prompt,max_output_tokens:6000})});
  if(!r.ok){const err=await r.text();console.error("OpenAI parse error",r.status,err);const fallback=localParse(text);fallback.warnings.unshift("AI 정밀분석 호출에 실패해 로컬 분석으로 전환했습니다.");return NextResponse.json(fallback)}
  const payload=await r.json();const parsed=normalizeAi(parseJson(responseText(payload)),text);return NextResponse.json(parsed);
 }catch(error){console.error(error);return NextResponse.json({error:error instanceof Error?error.message:"내용 분석 중 오류가 발생했습니다."},{status:500})}
}
