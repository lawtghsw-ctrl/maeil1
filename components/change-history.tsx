"use client";

import {useEffect,useMemo,useState} from "react";
import {Activity,Building2,Calculator,CalendarClock,FileSignature,Inbox,MessagesSquare,Users,WalletCards} from "lucide-react";
import {Badge,Card,PageHeader} from "@/components/ui";
import {DateRangePicker} from "@/components/date-range-picker";
import {Pagination} from "@/components/pagination";
import {useAdminStore} from "@/components/store";
import {createClient} from "@/lib/supabase/client";
import {won} from "@/lib/utils";

const PAGE_SIZE=5;
const categories=[
 {key:"신규 DB",icon:Inbox},
 {key:"고객 관리",icon:Users},
 {key:"계약 관리",icon:FileSignature},
 {key:"입금/분납 관리",icon:WalletCards},
 {key:"상환 일정 관리",icon:CalendarClock},
 {key:"정산",icon:Calculator},
 {key:"사채업체 관리",icon:Building2},
 {key:"내부 게시판",icon:MessagesSquare},
] as const;
type Category=typeof categories[number]["key"];
type HistoryRow={id:string;occurred_at:string;category:Category;action:"등록"|"수정"|"삭제";table_name:string;record_id:string;actor_name:string|null;source:string;old_data:Record<string,unknown>|null;new_data:Record<string,unknown>|null};
type PageMap=Record<Category,number>;
type RowMap=Record<Category,HistoryRow[]>;
type CountMap=Record<Category,number>;
const supabase=createClient();
function today(){return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}
function initPages():PageMap{return {"신규 DB":1,"고객 관리":1,"계약 관리":1,"입금/분납 관리":1,"상환 일정 관리":1,"정산":1,"사채업체 관리":1,"내부 게시판":1}}
function initRows():RowMap{return {"신규 DB":[],"고객 관리":[],"계약 관리":[],"입금/분납 관리":[],"상환 일정 관리":[],"정산":[],"사채업체 관리":[],"내부 게시판":[]}}
function initCounts():CountMap{return {"신규 DB":0,"고객 관리":0,"계약 관리":0,"입금/분납 관리":0,"상환 일정 관리":0,"정산":0,"사채업체 관리":0,"내부 게시판":0}}
function text(v:unknown){return v===null||v===undefined||v===""?"-":String(v)}
function num(v:unknown){return Number(v||0)}
function dateTime(v:string){const d=new Date(v);if(Number.isNaN(d.getTime()))return v;return new Intl.DateTimeFormat("ko-KR",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(d)}
function actionTone(action:string):"green"|"red"|"blue"{return action==="등록"?"green":action==="삭제"?"red":"blue"}

const fieldLabels:Record<Category,Record<string,string>>={
 "신규 DB":{customer_name:"고객명",phone_number:"연락처",collection_intensity:"추심강도",principal_amount:"대여원금",repayment_total:"상환총액",evidence:"증거보유",third_party_damage:"주변인피해",sales_manager:"영업 담당자",coordination_manager:"조율 담당자",lead_result:"상태",memo:"메모",status:"상태"},
 "고객 관리":{registered_at:"등록일",name:"고객명",phone:"연락처",address:"주소",birth_number:"주민번호",sales_manager:"영업 담당자",coordination_manager:"조율 담당자",is_accident:"사고자",accident_contract_amount:"사고자 계약금액",memo:"메모"},
 "계약 관리":{contract_date:"계약일",contract_amount:"계약금액",upfront_amount:"선납금",installment_period:"분납기간",lender_unit_price:"업체당 단가",lender_count:"업체수",memo:"메모"},
 "입금/분납 관리":{due_date:"납부 예정일",expected_amount:"예정금액",paid_date:"실제 입금일",paid_amount:"실입금액",status:"상태",payment_method:"결제방법",schedule_type:"일정구분",reschedule_sequence:"재약정차수",rescheduled_from_id:"이전 납부일정",recovery_date:"환수일",lender_name:"업체명",recovery_type:"환수 구분",amount:"환수금액",memo:"메모"},
 "상환 일정 관리":{lender_name:"업체명",lender_contact_type:"연락수단",lender_contact_value:"연락정보",repayment_date:"상환일",repayment_amount:"상환금액",account_info:"계좌/전달정보",status:"상태",memo:"메모"},
 "정산":{payment_date:"입금일",client_name:"의뢰인",amount:"결제금액",payment_method:"결제방법",memo:"비고"},
 "사채업체 관리":{created_at:"등록일",name:"업체명",account_info:"계좌번호",memo:"특이사항",deleted_at:"삭제일"},
 "내부 게시판":{title:"제목",body:"본문",author:"작성자",post_date:"등록일",is_notice:"공지여부",notice_order:"공지순서"},
};
const moneyFields=new Set(["contract_amount","upfront_amount","lender_unit_price","expected_amount","paid_amount","repayment_amount","amount","accident_contract_amount"]);
function valueDisplay(field:string,value:unknown){if(moneyFields.has(field))return won(num(value));if(field==="installment_period")return value?`${value}개월`:"-";if(field==="is_notice")return value?"공지":"일반";if(field==="is_accident")return value?"사고자":"정상";return text(value)}
function subject(row:HistoryRow,customerName:(id:string)=>string){const d=row.new_data||row.old_data||{};switch(row.category){case "신규 DB":return text(d.customer_name);case "고객 관리":return text(d.name);case "계약 관리":return d.customer_id?customerName(text(d.customer_id)):text(d.name);case "입금/분납 관리":case "상환 일정 관리":return customerName(text(d.customer_id));case "정산":return text(d.client_name);case "사채업체 관리":return text(d.name);case "내부 게시판":return text(d.title);default:return "-"}}
function detailLines(row:HistoryRow){
 const labels=fieldLabels[row.category];const next=row.new_data||{};const prev=row.old_data||{};
 if(row.action==="수정"){
  const changed=Object.keys(labels).filter(k=>JSON.stringify(prev[k]??null)!==JSON.stringify(next[k]??null));
  if(changed.length)return changed.slice(0,6).map(k=>`${labels[k]}: ${valueDisplay(k,prev[k])} → ${valueDisplay(k,next[k])}`);
  if(row.category==="사채업체 관리")return ["업체 연락정보를 포함한 저장 내용이 수정되었습니다."];
  return ["저장된 정보가 수정되었습니다."];
 }
 const data=row.action==="삭제"?prev:next;
 return Object.keys(labels).filter(k=>data[k]!==null&&data[k]!==undefined&&data[k]!=="").slice(0,6).map(k=>`${labels[k]}: ${valueDisplay(k,data[k])}`);
}

export function ChangeHistory(){
 const store=useAdminStore();const t=today();const [start,setStart]=useState(t);const [end,setEnd]=useState(t);const [pages,setPages]=useState<PageMap>(initPages);const [rows,setRows]=useState<RowMap>(initRows);const [counts,setCounts]=useState<CountMap>(initCounts);const [loading,setLoading]=useState(true);const [error,setError]=useState<string|null>(null);const [realtimeTick,setRealtimeTick]=useState(0);
 const pageKey=categories.map(x=>`${x.key}:${pages[x.key]}`).join("|");
 useEffect(()=>{const handler=(event:Event)=>{const table=(event as CustomEvent<{table?:string}>).detail?.table;if(table==="change_history")setRealtimeTick(x=>x+1)};window.addEventListener("admin:data-changed",handler);const fallback=window.setInterval(()=>setRealtimeTick(x=>x+1),30000);return()=>{window.removeEventListener("admin:data-changed",handler);window.clearInterval(fallback)}},[]);
 useEffect(()=>{let alive=true;void (async()=>{setLoading(true);setError(null);const from=`${start}T00:00:00+09:00`;const to=`${end}T23:59:59.999+09:00`;const results=await Promise.all(categories.map(async c=>{const page=pages[c.key];const result=await supabase.from("change_history").select("id,occurred_at,category,action,table_name,record_id,actor_name,source,old_data,new_data",{count:"exact"}).eq("category",c.key).gte("occurred_at",from).lte("occurred_at",to).order("occurred_at",{ascending:false}).range((page-1)*PAGE_SIZE,page*PAGE_SIZE-1);return{category:c.key,result}}));if(!alive)return;const nextRows=initRows();const nextCounts=initCounts();const firstError=results.find(x=>x.result.error)?.result.error;if(firstError){setError(firstError.message);setRows(nextRows);setCounts(nextCounts);setLoading(false);return}for(const x of results){nextRows[x.category]=(x.result.data||[]) as HistoryRow[];nextCounts[x.category]=x.result.count||0}setRows(nextRows);setCounts(nextCounts);setLoading(false)})().catch(e=>{if(alive){setError(e instanceof Error?e.message:String(e));setLoading(false)}});return()=>{alive=false}},[start,end,pageKey,realtimeTick]);
 function rangeChange(a:string,b:string){setStart(a);setEnd(b);setPages(initPages())}
 const total=useMemo(()=>Object.values(counts).reduce((a,b)=>a+b,0),[counts]);
 const customerName=(id:string)=>store.customers.find(c=>c.id===id)?.name||"고객 정보 없음";
 return <><PageHeader title="기간별 변동내역" description="변동내역 초기화 이후 Admin에서 실제 등록·수정·삭제된 내용을 메뉴별로 확인합니다. 기본 조회기간은 오늘입니다." action={<DateRangePicker start={start} end={end} onChange={rangeChange}/>}/>
  <div className="mb-4 grid gap-3 sm:grid-cols-3"><Card className="p-4"><div className="text-xs font-semibold text-slate-500">조회기간</div><div className="mt-1 font-bold text-slate-900">{start===end?start:`${start} ~ ${end}`}</div></Card><Card className="p-4"><div className="text-xs font-semibold text-slate-500">전체 변동</div><div className="mt-1 text-2xl font-bold text-blue-700">{total.toLocaleString()}건</div></Card><Card className="p-4"><div className="flex items-center gap-2 text-xs font-semibold text-slate-500"><Activity size={14}/>표시 기준</div><div className="mt-1 text-sm font-semibold text-slate-700">각 메뉴별 5건 · 이후 페이지 이동</div></Card></div>
  {error&&<Card className="mb-4 border-red-200 p-5"><div className="font-bold text-red-700">변동내역을 불러오지 못했습니다.</div><div className="mt-2 text-sm text-slate-600">먼저 Supabase에서 <b>supabase/change-history.sql</b>을 실행해주세요.</div><div className="mt-2 break-all text-xs text-red-500">{error}</div></Card>}
  <div className="grid gap-4 xl:grid-cols-2">{categories.map(({key,icon:Icon})=><Card key={key} className="overflow-hidden"><div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div className="flex items-center gap-2"><div className="grid size-9 place-items-center rounded-lg bg-slate-50 text-slate-600"><Icon size={17}/></div><div><div className="font-bold">{key}</div><div className="text-xs text-slate-400">총 {counts[key].toLocaleString()}건</div></div></div></div>
   <div className="divide-y divide-slate-100">{loading&&rows[key].length===0?<div className="px-5 py-10 text-center text-sm text-slate-400">불러오는 중...</div>:rows[key].length===0?<div className="px-5 py-10 text-center text-sm text-slate-400">선택한 기간의 변동내역이 없습니다.</div>:rows[key].map(row=><div key={row.id} className="px-5 py-4"><div className="flex flex-wrap items-start justify-between gap-2"><div className="flex min-w-0 items-center gap-2"><Badge tone={actionTone(row.action)}>{row.action}</Badge><div className="truncate text-sm font-bold text-slate-900">{subject(row,customerName)}</div></div><div className="text-xs text-slate-400">{dateTime(row.occurred_at)}</div></div><div className="mt-2 space-y-1">{detailLines(row).map((line,i)=><div key={i} className="break-words text-xs leading-5 text-slate-600">{line}</div>)}</div><div className="mt-2 text-[11px] text-slate-400">처리자: {row.actor_name||"시스템"}</div></div>)}</div>
   <Pagination page={pages[key]} total={counts[key]} pageSize={PAGE_SIZE} onChange={p=>setPages(v=>({...v,[key]:p}))}/></Card>)}</div>
  </>
}
