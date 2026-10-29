"use client";

import {useEffect,useMemo,useState} from "react";
import {useLeadMemos} from "@/components/use-lead-memos";
import {CheckCircle2,PhoneCall,PhoneMissed,Search,Trash2,Plus} from "lucide-react";
import {Badge,Button,Card,Input,Modal} from "@/components/ui";
import {ConfirmDelete} from "@/components/confirm-delete";
import {Pagination,pageRows} from "@/components/pagination";
import {Customer,Manager} from "@/components/store";
import {CustomerFormFields} from "@/components/customer-form-fields";
import {createClient} from "@/lib/supabase/client";
import {formatPhone} from "@/lib/utils";
import {buildSalaryInstallmentPlan} from "@/lib/installment-plan";
import {CALL_WARNING_STAGES,LeadCallLog,LeadStage,callWarning,kstDateKey,leadStages,longNoAnswerQualifiedDays,normalizeLeadStage,stageTone} from "@/lib/lead-workflow";

const field="h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-base outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 sm:h-10 sm:text-sm";
const textarea="min-h-28 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-base outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 sm:text-sm";
const activeManagers:Manager[]=["신홍규","이중호"];
const staffManager=(v:Manager)=>String(v||"").trim()||"신홍규";
const managerOptions=(current?:Manager)=>{const value=staffManager(current||"");return activeManagers.includes(value)?activeManagers:[value,...activeManagers]};
type LeadStageFilter="전체"|LeadStage;
const leadStageFilters:LeadStageFilter[]=["전체","신규","부재","설득필요","상담중","계약완료","장기부재","불가","허수"];

type MetaLeadResult="신규DB"|"문자발송"|"미분류"|"신규"|"부재"|"설득필요"|"상담중"|"계약완료"|"전환완료"|"장기부재"|"불가"|"허수"|"전환"|"부재중"|"재연락"|"유효리드";
const metaLeadResults:MetaLeadResult[]=["신규DB","문자발송","미분류","신규","부재","설득필요","상담중","계약완료","전환완료","장기부재","불가","허수","전환","부재중","재연락","유효리드"];
const legacyResults=new Set<MetaLeadResult>(["신규DB","문자발송","부재중","재연락","유효리드","전환"]);
const META_SEND_RESULTS=new Set<MetaLeadResult>(["상담중","계약완료","전환완료","유효리드","전환"]);
function shouldSendMetaResult(result:MetaLeadResult){return META_SEND_RESULTS.has(result)}
function stageSendsToMeta(stage:LeadStage){return stage==="상담중"||stage==="계약완료"}
function storedStage(stageValue:string|undefined|null,resultValue:MetaLeadResult):LeadStage{
 const raw=String(stageValue||"").trim();
 // DB에는 기존 호환값 `전환`이 남아 있어도 화면/영업상태는 항상 `계약완료`로 표시합니다.
 if(resultValue==="전환"||resultValue==="전환완료"||resultValue==="계약완료")return "계약완료";
 if((!raw||raw==="신규")&&resultValue!=="미분류"&&resultValue!=="신규")return normalizeLeadStage(resultValue);
 return normalizeLeadStage(raw||resultValue);
}

type MetaLead={
 source:Exclude<LeadOrigin,"전체">;sourceRowNumber:number;collectionIntensity:string;principalAmount:string;repaymentTotal:string;evidence:string;thirdPartyDamage:string;metaLeadId:string;
 id:string;createdAt:string;name:string;phone:string;manager:Manager;coordinationManager:Manager;lenderCount:number;memo:string;
 leadResult:MetaLeadResult;stage:LeadStage;status:"신규"|"고객등록완료";customerId:string|null;
 metaNativeLeadId:string;metaEventName:string;metaEventSentAt:string;metaEventError:string;
};

type LeadOrigin="전체"|"랜딩 광고"|"인스턴트 양식"|"수기등록";
function detectLeadSource(x:any):Exclude<LeadOrigin,"전체">{
 const key=String(x.meta_lead_id||"");
 if(key.startsWith("manual:"))return "수기등록";
 if(key.startsWith("gsheet-instant:")||(key.startsWith("gsheet:")&&x.meta_native_lead_id))return "인스턴트 양식";
 return "랜딩 광고";
}
function hasMetaSource(lead:MetaLead){return !lead.metaLeadId.startsWith("manual:")&&Boolean(lead.metaNativeLeadId||lead.metaLeadId.startsWith("gsheet:")||lead.metaLeadId.startsWith("gsheet-instant:"))}
function leadSendsToMeta(lead:MetaLead){return hasMetaSource(lead)&&stageSendsToMeta(lead.stage)}
function leadSourceBadge(r:MetaLead){return <Badge tone={r.source==="인스턴트 양식"?"blue":"gray"}>{r.source}</Badge>}
type ManualLeadForm={createdAt:string;name:string;phone:string;manager:Manager;coordinationManager:Manager;lenderCount:number;memo:string;collectionIntensity:string;principalAmount:string;repaymentTotal:string;evidence:string;thirdPartyDamage:string};
function manualLeadNow(){const d=new Date();const local=new Date(d.getTime()-d.getTimezoneOffset()*60000);return local.toISOString().slice(0,16)}
function emptyManualLead():ManualLeadForm{return{createdAt:manualLeadNow(),name:"",phone:"",manager:"신홍규",coordinationManager:"신홍규",lenderCount:0,memo:"",collectionIntensity:"",principalAmount:"",repaymentTotal:"",evidence:"",thirdPartyDamage:""}}

const supabase=createClient();
function today(){return kstDateKey()}
function leadDateOnly(v:string){if(!v)return today();const d=new Date(v);if(Number.isNaN(d.getTime()))return v.slice(0,10)||today();return kstDateKey(d)}
function formatDate(v:string){if(!v)return "-";const d=new Date(v);if(Number.isNaN(d.getTime()))return v;return new Intl.DateTimeFormat("ko-KR",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(d)}
function phoneDigits(v:string){return String(v||"").replace(/\D/g,"").replace(/^82/,"0").slice(0,11)}
function NumberInput({value,onChange,min=0}:{value:number;onChange:(v:number)=>void;min?:number}){const display=value?value.toLocaleString("ko-KR"):"";return <input inputMode="numeric" className={field} value={display} placeholder="0" onChange={e=>{const raw=e.target.value.replace(/[^0-9-]/g,"");const n=raw===""?0:Number(raw);onChange(Number.isFinite(n)?Math.max(min,n):min)}}/>}
function Label({text,children}:{text:string;children:React.ReactNode}){return <label className="text-sm font-semibold">{text}<div className="mt-1.5">{children}</div></label>}
const emptyCustomer=():Omit<Customer,"id">=>({createdAt:today(),name:"",phone:"",address:"",birthNumber:"",manager:"신홍규",coordinationManager:"이중호",memo:"",contractDate:"",contractAmount:0,prepaidAmount:0,installmentMonths:0,lenderUnitPrice:0,lenderCount:0,monthlyNetSalary:0,salaryDay:0,autoCreateInstallments:true,isAccident:false,isAccidentRisk:false});

function CustomerModal({open,form,setForm,onClose,onSave}:{open:boolean;form:Omit<Customer,"id">;setForm:(v:Omit<Customer,"id">)=>void;onClose:()=>void;onSave:()=>void}){return <Modal open={open} title="고객 등록" onClose={onClose} size="full"><CustomerFormFields open={open} form={form} setForm={setForm} onClose={onClose} onSave={onSave} saveLabel="고객정보등록"/></Modal>}

export function MetaLeadsV28(){
 const [rows,setRows]=useState<MetaLead[]>([]);const [logs,setLogs]=useState<LeadCallLog[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState<string|null>(null);
 const [q,setQ]=useState("");const [page,setPage]=useState(1);const [stage,setStage]=useState<LeadStageFilter>("신규");const [customerOpen,setCustomerOpen]=useState(false);const [selectedLead,setSelectedLead]=useState<MetaLead|null>(null);const [customerForm,setCustomerForm]=useState(emptyCustomer());const [del,setDel]=useState<MetaLead|null>(null);const [historyLead,setHistoryLead]=useState<MetaLead|null>(null);const [toast,setToast]=useState<string|null>(null);
 const [sourceFilter,setSourceFilter]=useState<LeadOrigin>("전체");
 const [manualOpen,setManualOpen]=useState(false);const [manualSaving,setManualSaving]=useState(false);const [manualForm,setManualForm]=useState<ManualLeadForm>(emptyManualLead());
 const todayIso=today();
 function showToast(message:string){setToast(message);window.setTimeout(()=>setToast(current=>current===message?null:current),2000)}

 const {memoDrafts,editMemo,saveMemo}=useLeadMemos("meta_leads",supabase,setRows);
 async function load(silent=false){
  const read=memoDrafts.beginRead();
  if(!silent)setLoading(true);setError(null);
  const [leadRes,logRes]=await Promise.all([
   supabase.from("meta_leads").select("*").order("created_at",{ascending:false}).order("id",{ascending:false}),
   supabase.from("lead_call_logs").select("*").eq("lead_source","meta").order("created_at",{ascending:false}),
  ]);
  if(!memoDrafts.isCurrentRead(read))return;
  if(leadRes.error){setError(leadRes.error.message);setLoading(false);return}
  const mappedLogs:LeadCallLog[]=logRes.error?[]:(logRes.data||[]).map((x:any)=>({id:x.id,leadSource:"meta",leadId:x.lead_id,result:x.call_result,note:x.note||"",createdAt:x.created_at||""}));
  if(logRes.error)setError(`콜 관리 테이블 확인 필요: ${logRes.error.message}`);
  setLogs(mappedLogs);
  const mappedRows:MetaLead[]=(leadRes.data||[]).map((x:any)=>({
   source:detectLeadSource(x),sourceRowNumber:Number(x.source_row_number||0),collectionIntensity:x.collection_intensity||"",principalAmount:String(x.principal_amount??""),repaymentTotal:String(x.repayment_total??""),evidence:x.evidence||"",thirdPartyDamage:x.third_party_damage||"",metaLeadId:x.meta_lead_id||"",
   id:x.id,createdAt:x.created_at||"",name:x.customer_name||"",phone:formatPhone(x.phone_number||""),manager:staffManager((x.sales_manager||x.manager||"신홍규") as Manager),coordinationManager:staffManager((x.coordination_manager||"신홍규") as Manager),lenderCount:Number(x.lender_count||0),memo:x.memo||"",
   leadResult:(metaLeadResults.includes(x.lead_result as MetaLeadResult)?x.lead_result:"미분류") as MetaLeadResult,stage:x.status==="고객등록완료"?"계약완료":storedStage(x.lead_stage,(metaLeadResults.includes(x.lead_result as MetaLeadResult)?x.lead_result:"미분류") as MetaLeadResult),status:x.status==="고객등록완료"?"고객등록완료":"신규",customerId:x.customer_id||null,metaNativeLeadId:x.meta_native_lead_id||"",metaEventName:x.meta_event_name||"",metaEventSentAt:x.meta_event_sent_at||"",metaEventError:x.meta_event_error||"",
  }));
  // Loading never changes lead stages. Candidates remain advisory until a user saves a stage.
  const mergedRows=memoDrafts.mergeRows(mappedRows,read);
  if(!mergedRows)return;
  setRows(mergedRows);setLoading(false);
 }
 useEffect(()=>{void load();const onVisible=()=>{if(document.visibilityState==="visible")void load(true)};const timer=window.setInterval(onVisible,30000);document.addEventListener("visibilitychange",onVisible);return()=>{window.clearInterval(timer);document.removeEventListener("visibilitychange",onVisible)}},[]);

 function leadLogs(id:string){return logs.filter(x=>x.leadId===id)}
 async function addCallLog(lead:MetaLead,result:"부재"|"연결"){
  const {error}=await supabase.from("lead_call_logs").insert({lead_source:"meta",lead_id:lead.id,call_result:result});
  if(error)return alert(`콜 기록 저장 실패: ${error.message}\nV29 SQL을 먼저 실행해주세요.`);
  showToast(result==="부재"?"부재등록이 완료되었습니다":"통화연결 등록이 완료되었습니다");
  await load(true);
 }
 async function deleteCallLog(logId:string){
  if(!window.confirm("이 콜 기록을 삭제할까요? 삭제하면 오늘 콜 횟수와 장기부재 계산에도 즉시 반영됩니다."))return;
  const {error}=await supabase.from("lead_call_logs").delete().eq("id",logId).eq("lead_source","meta");
  if(error)return alert(`콜 기록 삭제 실패: ${error.message}`);
  await load(true);
 }
 function openManualLead(){
  setManualForm(emptyManualLead());
  setManualOpen(true);
 }

 async function saveManualLead(){
  if(manualSaving)return;
  const name=manualForm.name.trim();
  const phone=formatPhone(manualForm.phone);
  if(!name)return alert("고객명을 입력해주세요.");
  if(phoneDigits(phone).length<10)return alert("연락처를 정확히 입력해주세요.");
  const parsedDate=manualForm.createdAt?new Date(manualForm.createdAt):new Date();
  const createdAt=Number.isNaN(parsedDate.getTime())?new Date().toISOString():parsedDate.toISOString();
  setManualSaving(true);
  try{
   const manualId=`manual:${typeof crypto!=="undefined"&&"randomUUID" in crypto?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
   const nextSourceRow=Math.max(0,...rows.map(x=>x.sourceRowNumber||0))+1;
   const {error}=await supabase.from("meta_leads").insert({
    meta_lead_id:manualId,
    source_row_number:nextSourceRow,
    meta_native_lead_id:null,
    created_at:createdAt,
    customer_name:name,
    phone_number:phone,
    manager:manualForm.manager,
    sales_manager:manualForm.manager,
    coordination_manager:manualForm.coordinationManager,
    lender_count:manualForm.lenderCount,
    memo:manualForm.memo.trim(),
    collection_intensity:manualForm.collectionIntensity.trim(),
    principal_amount:manualForm.principalAmount.trim(),
    repayment_total:manualForm.repaymentTotal.trim(),
    evidence:manualForm.evidence.trim(),
    third_party_damage:manualForm.thirdPartyDamage.trim(),
    lead_stage:"신규",
    lead_result:"신규DB",
    new_db_alert_enabled:false,
    status:"신규",
   });
   if(error)throw new Error(error.message);
   setManualOpen(false);
   setPage(1);
   await load(true);
   alert("DB 수기등록이 완료되었습니다.");
  }catch(e){alert(e instanceof Error?e.message:"DB 수기등록에 실패했습니다.")}finally{setManualSaving(false)}
 }

 async function sendMetaResult(id:string,leadResult:MetaLeadResult){
  const lead=rows.find(row=>row.id===id);
  if(leadResult==="미분류"||!shouldSendMetaResult(leadResult)||!lead||!hasMetaSource(lead))return;
  const response=await fetch("/api/meta/crm-event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({leadId:id,leadResult})});
  const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result?.error||"Meta CRM 데이터 전송에 실패했습니다.");
 }
 async function updateLead(id:string,patch:Partial<Pick<MetaLead,"manager"|"coordinationManager">>){
  setRows(prev=>prev.map(x=>x.id===id?{...x,...patch}:x));const db:any={};
  if(patch.manager!==undefined){db.manager=patch.manager;db.sales_manager=patch.manager}if(patch.coordinationManager!==undefined)db.coordination_manager=patch.coordinationManager;
  const {error}=await supabase.from("meta_leads").update(db).eq("id",id);if(error){alert(error.message);await load(true);return}
 }
 async function updateStageAndMeta(id:string,nextStage:LeadStage){
  const storedResult:MetaLeadResult=nextStage==="계약완료"?"전환":nextStage;
  setRows(prev=>prev.map(x=>x.id===id?{...x,stage:nextStage,leadResult:storedResult}:x));
  // `계약완료`는 기존 운영 DB의 `lead_result=전환`을 활용해 저장합니다.
  // 그래서 별도 DB 스키마 변경 없이 드롭다운/탭/Meta 전환 신호를 모두 사용할 수 있습니다.
  const dbPatch=nextStage==="계약완료"
   ?{lead_result:"전환",converted_at:new Date().toISOString(),new_db_alert_enabled:false}
   :{lead_stage:nextStage,lead_result:storedResult,new_db_alert_enabled:false};
  const {error}=await supabase.from("meta_leads").update(dbPatch).eq("id",id);
  if(error){alert(`DB 상태 저장 실패: ${error.message}`);await load(true);return}
  if(shouldSendMetaResult(nextStage)){try{await sendMetaResult(id,nextStage)}catch(e){alert(`DB 상태는 저장됐지만 Meta 전송에 실패했습니다.\n${e instanceof Error?e.message:"Meta CRM 데이터 전송 오류"}`)}}
  await load(true);
 }
 async function removeLead(id:string){const {error}=await supabase.from("meta_leads").delete().eq("id",id);if(error){alert(error.message);return}setRows(prev=>prev.filter(x=>x.id!==id));setDel(null)}
 function beginCustomer(lead:MetaLead){setSelectedLead(lead);setCustomerForm({...emptyCustomer(),createdAt:leadDateOnly(lead.createdAt),name:lead.name,phone:formatPhone(lead.phone),manager:lead.manager,coordinationManager:lead.coordinationManager,lenderCount:lead.lenderCount,memo:lead.memo});setCustomerOpen(true)}
 async function saveCustomer(){
  if(!selectedLead)return;if(!customerForm.name.trim()||!customerForm.phone.trim())return alert("고객명과 연락처를 입력해주세요.");
  const {data:customerCandidates,error:lookupError}=await supabase.from("customers").select("id,name,phone").eq("name",customerForm.name.trim()).limit(100);if(lookupError)return alert(lookupError.message);
  if((customerCandidates||[]).some((x:any)=>phoneDigits(x.phone)===phoneDigits(customerForm.phone)))return alert("같은 이름과 전화번호의 고객이 이미 등록되어 있습니다. 기존 고객정보를 확인해주세요.");
  const plan=customerForm.autoCreateInstallments!==false?buildSalaryInstallmentPlan({contractAmount:customerForm.contractAmount,prepaidAmount:customerForm.prepaidAmount,monthlyNetSalary:customerForm.monthlyNetSalary||0,salaryDay:customerForm.salaryDay||0,baseDate:customerForm.contractDate||customerForm.createdAt}):{remaining:0,monthlyTarget:0,months:0,rows:[],mode:"none" as const};
  const {data,error}=await supabase.from("customers").insert({registered_at:customerForm.createdAt,name:customerForm.name,phone:customerForm.phone,address:customerForm.address||null,birth_number:customerForm.birthNumber||null,manager:customerForm.manager,sales_manager:customerForm.manager,coordination_manager:customerForm.coordinationManager,memo:customerForm.memo,contract_date:customerForm.contractDate||null,contract_amount:customerForm.contractAmount,upfront_amount:customerForm.prepaidAmount,installment_period:plan.rows.length?plan.months:customerForm.installmentMonths,lender_unit_price:customerForm.lenderUnitPrice,lender_count:customerForm.lenderCount,monthly_net_salary:customerForm.monthlyNetSalary||null,salary_day:customerForm.salaryDay||null,is_accident:false,is_accident_risk:!!customerForm.isAccidentRisk,accident_risk_marked_at:customerForm.isAccidentRisk?new Date().toISOString():null,accident_contract_amount:null,accident_marked_at:null}).select("id").single();if(error)return alert(error.message);
  if(customerForm.prepaidAmount>0){const paidDate=customerForm.contractDate||customerForm.createdAt;const p=await supabase.from("payment_schedules").insert({customer_id:data.id,due_date:paidDate,expected_amount:customerForm.prepaidAmount,paid_date:paidDate,paid_amount:customerForm.prepaidAmount,status:"완료",payment_method:"계좌이체",memo:"고객 등록 시 선납금 자동 반영"});if(p.error)return alert(p.error.message)}
  if(plan.rows.length){const p=await supabase.from("payment_schedules").insert(plan.rows.map((row,index)=>({customer_id:data.id,due_date:row.dueDate,expected_amount:row.amount,paid_date:null,paid_amount:0,status:"예정",payment_method:"계좌이체",schedule_type:"일반",memo:`급여일 기반 자동 분납 ${index+1}/${plan.rows.length} · 세후급여 15%`})));if(p.error)return alert(p.error.message)}
  const u=await supabase.from("meta_leads").update({manager:customerForm.manager,sales_manager:customerForm.manager,coordination_manager:customerForm.coordinationManager,lender_count:customerForm.lenderCount,memo:customerForm.memo,lead_result:"전환",new_db_alert_enabled:false,status:"고객등록완료",customer_id:data.id,converted_at:new Date().toISOString()}).eq("id",selectedLead.id);if(u.error)return alert(`고객은 등록됐지만 신규 DB 상태 변경에 실패했습니다.\n${u.error.message}`);
  try{await sendMetaResult(selectedLead.id,"계약완료")}catch(e){alert(`고객 등록은 완료됐지만 Meta 계약완료 데이터 전송에 실패했습니다.\n${e instanceof Error?e.message:"전송 오류"}`)}
  setCustomerOpen(false);setSelectedLead(null);await load(true);alert("고객정보 등록이 완료되었습니다.");
 }

 const managedRows=useMemo(()=>rows.filter(r=>sourceFilter==="전체"||r.source===sourceFilter),[rows,sourceFilter]);
 const stageCounts=useMemo(()=>Object.fromEntries(leadStages.map(s=>[s,managedRows.filter(r=>r.stage===s).length])) as Record<LeadStage,number>,[managedRows]);
 const completedCount=useMemo(()=>managedRows.filter(r=>r.stage==="계약완료").length,[managedRows]);
 const warningCounts=useMemo(()=>Object.fromEntries(leadStages.map(s=>[s,managedRows.filter(r=>r.status!=="고객등록완료"&&r.stage===s&&callWarning(leadLogs(r.id),r.stage,todayIso).active).length])) as Record<LeadStage,number>,[managedRows,logs,todayIso]);
 const totalWarningCount=useMemo(()=>managedRows.filter(r=>r.status!=="고객등록완료"&&callWarning(leadLogs(r.id),r.stage,todayIso).active).length,[managedRows,logs,todayIso]);
 const filtered=useMemo(()=>{const query=q.trim().toLowerCase();return managedRows.filter(r=>{const stageMatch=stage==="전체"?true:r.stage===stage;return stageMatch&&`${r.name} ${r.phone} ${r.manager} ${r.coordinationManager} ${r.leadResult} ${r.memo} ${r.collectionIntensity} ${r.principalAmount} ${r.repaymentTotal} ${r.evidence} ${r.thirdPartyDamage}`.toLowerCase().includes(query)})},[managedRows,q,stage]);
 useEffect(()=>setPage(1),[stage,sourceFilter]);

 function renderCallCell({lead}:{lead:MetaLead}){
  const ll=leadLogs(lead.id);const warning=callWarning(ll,lead.stage,todayIso);const longDays=longNoAnswerQualifiedDays(ll);const isManaged=CALL_WARNING_STAGES.has(lead.stage)&&lead.status!=="고객등록완료";
  if(lead.stage==="계약완료")return <div className="min-w-[190px] space-y-1.5"><Badge tone="green">계약완료</Badge></div>;
  return <div className="min-w-[190px] space-y-1.5">
   <div className="flex flex-wrap items-center gap-1.5">{isManaged&&warning.active?<Badge tone="red">⚠ 콜 필요 · 부재 {warning.noAnswerCount}/2</Badge>:isManaged?<Badge tone="green">오늘 콜 완료</Badge>:<Badge tone="gray">경고 없음</Badge>}{longDays>=5&&lead.stage!=="장기부재"&&<Badge tone="amber">장기부재 후보 · {longDays}일</Badge>}</div>
   <div className="flex gap-1"><Button variant="secondary" className="h-8 px-2 text-xs" onClick={()=>addCallLog(lead,"부재")}><PhoneMissed size={13}/>부재 +1</Button><Button variant="secondary" className="h-8 px-2 text-xs" onClick={()=>addCallLog(lead,"연결")}><CheckCircle2 size={13}/>연결</Button><Button variant="ghost" className="h-8 px-2 text-xs" onClick={()=>setHistoryLead(lead)}>기록</Button></div>
  </div>
 }

 return <>{toast&&<div className="fixed left-1/2 top-5 z-[120] -translate-x-1/2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-bold text-white shadow-2xl">{toast}</div>}
  <div className="mb-3 flex items-center justify-between gap-3"><div><div className="text-sm font-bold text-slate-800">로파워DB</div></div><div className="flex items-center gap-2"><Badge tone="gray">전체 {managedRows.length}건</Badge><Button onClick={openManualLead}><Plus size={15}/>DB 수기등록</Button></div></div>
  <div className="mb-3 flex flex-wrap gap-2">{(["전체","랜딩 광고","인스턴트 양식","수기등록"] as LeadOrigin[]).map(source=><button key={source} type="button" onClick={()=>setSourceFilter(source)} className={`rounded-lg border px-3 py-2 text-sm font-semibold ${sourceFilter===source?"border-blue-600 bg-blue-600 text-white":"border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>{source} ({source==="전체"?rows.length:rows.filter(row=>row.source===source).length})</button>)}</div>
  <Card className="mb-4 overflow-x-auto p-1.5"><div className="flex min-w-max gap-1">{leadStageFilters.map(s=>{const count=s==="전체"?managedRows.length:s==="계약완료"?completedCount:stageCounts[s];const warnings=s==="전체"?totalWarningCount:s==="계약완료"?0:warningCounts[s];return <button key={s} type="button" onClick={()=>setStage(s)} className={`relative h-10 rounded-lg px-4 text-sm font-bold transition ${stage===s?"bg-blue-600 text-white shadow-sm":"text-slate-600 hover:bg-slate-50"}`}>{s}<span className={`ml-1.5 text-xs ${stage===s?"text-blue-100":"text-slate-400"}`}>({count})</span>{warnings>0&&<span className="ml-1.5 inline-flex min-w-5 justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-black text-white">! {warnings}</span>}</button>})}</div></Card>
  <Card className="mb-4 p-3"><div className="flex items-center gap-2"><div className="relative min-w-0 flex-1"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/><Input value={q} onChange={e=>{setQ(e.target.value);setPage(1)}} placeholder={`${stage} DB에서 고객명, 연락처, 담당자, 메모 검색`} className="pl-9"/></div><Button variant="secondary" onClick={()=>{setQ("");setPage(1)}}>초기화</Button></div></Card>
  {error&&<Card className="mb-4 border-red-200 bg-red-50 p-4"><div className="text-sm font-semibold text-red-700">{error}</div><div className="mt-1 text-xs text-red-500">신청정보를 불러오지 못했습니다. 잠시 후 새로고침해주세요.</div></Card>}
  <Card className="overflow-hidden">
   <div className="divide-y divide-slate-100 md:hidden">{loading?<div className="px-4 py-10 text-center text-sm text-slate-400">DB를 불러오는 중입니다...</div>:pageRows(filtered,page,10).map(r=><div key={r.id} className={`space-y-3 p-4 ${r.status!=="고객등록완료"&&callWarning(leadLogs(r.id),r.stage,todayIso).active?"bg-red-50/45":""}`}>
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-base font-bold text-slate-900">{r.name||"이름 없음"}</span><Badge tone={stageTone(r.stage)}>{r.stage}</Badge>{leadSourceBadge(r)}{r.status==="고객등록완료"&&<Badge tone="green">등록완료</Badge>}</div><div className="mt-1 text-sm font-semibold text-slate-700">{r.phone||"연락처 없음"}</div><div className="mt-1 text-[11px] text-slate-400">{formatDate(r.createdAt)}{r.sourceRowNumber?` · #${r.sourceRowNumber}`:""}</div></div><Button variant="danger" className="px-2.5" onClick={()=>setDel(r)}><Trash2 size={14}/>삭제</Button></div>
    <Label text="DB 상태 · Meta 연동"><select className={field} value={r.stage} disabled={r.status==="고객등록완료"} onChange={e=>void updateStageAndMeta(r.id,e.target.value as LeadStage)}>{leadStages.map(x=><option key={x}>{x}</option>)}</select>{legacyResults.has(r.leadResult)&&<div className="mt-1"><Badge tone="gray">기존 결과: {r.leadResult}</Badge></div>}<div className={`mt-1 break-words text-[10px] ${leadSendsToMeta(r)?(r.metaEventError?"text-red-500":r.metaEventSentAt?"text-emerald-600":"text-slate-400"):"text-slate-400"}`}>{leadSendsToMeta(r)?<>현재 Meta값: {r.stage} · {r.metaEventError?`전송오류 · ${r.metaEventError}`:r.metaEventSentAt?`전송완료 · ${r.metaEventName}`:"전송 대기"}</>:<>현재 상태: {r.stage} · Meta 미전송(내부 관리)</>}</div></Label>
    {renderCallCell({lead:r})}
    <div className="grid grid-cols-2 gap-2"><Label text="영업 담당자"><select className={field} value={r.manager} onChange={e=>void updateLead(r.id,{manager:e.target.value as Manager})}>{managerOptions(r.manager).map(m=><option key={m}>{m}</option>)}</select></Label><Label text="조율 담당자"><select className={field} value={r.coordinationManager} onChange={e=>void updateLead(r.id,{coordinationManager:e.target.value as Manager})}>{managerOptions(r.coordinationManager).map(m=><option key={m}>{m}</option>)}</select></Label></div>
    <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 text-xs">{[["추심강도",r.collectionIntensity],["대여원금",r.principalAmount],["상환총액",r.repaymentTotal],["증거보유",r.evidence],["주변인피해",r.thirdPartyDamage]].map(([label,value])=><div key={label}><span className="text-slate-400">{label} </span><span className="whitespace-pre-wrap font-semibold">{value||"-"}</span></div>)}</div>
    <Label text="메모"><input className={field} value={r.memo} onChange={e=>editMemo(r.id,e.target.value)} onBlur={()=>void saveMemo(r.id)} placeholder="메모 입력"/></Label>
    <Button className="w-full" disabled={r.status==="고객등록완료"} onClick={()=>beginCustomer(r)}>{r.status==="고객등록완료"?"등록완료":"고객정보등록"}</Button>
   </div>)}</div>
   <div className="hidden overflow-x-auto md:block"><table className="admin-responsive-table w-full min-w-[1450px] text-sm"><thead className="bg-slate-50 text-left text-xs text-slate-500"><tr>{["DB 접수일시","고객명","연락처","신청정보","DB 상태 · Meta 연동","콜 관리","영업 담당자","조율 담당자","메모","","삭제"].map(h=><th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead><tbody>{loading?<tr><td colSpan={11} className="px-4 py-10 text-center text-slate-400">DB를 불러오는 중입니다...</td></tr>:pageRows(filtered,page,10).map(r=><tr key={r.id} className={`border-t border-slate-100 align-top ${r.status!=="고객등록완료"&&callWarning(leadLogs(r.id),r.stage,todayIso).active?"bg-red-50/50":""}`}><td className="whitespace-nowrap px-4 py-3">{formatDate(r.createdAt)}{r.sourceRowNumber>0&&<div className="mt-1 text-xs text-slate-400">#{r.sourceRowNumber}</div>}</td><td className="px-4 py-3 font-semibold"><div className="flex items-center gap-2">{r.name}{leadSourceBadge(r)}{r.status==="고객등록완료"&&<Badge tone="green">등록완료</Badge>}</div></td><td className="whitespace-nowrap px-4 py-3">{r.phone}</td><td className="min-w-[230px] px-4 py-3"><div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 text-xs">{[["추심강도",r.collectionIntensity],["대여원금",r.principalAmount],["상환총액",r.repaymentTotal],["증거보유",r.evidence],["주변인피해",r.thirdPartyDamage]].map(([label,value])=><div key={label}><span className="text-slate-400">{label} </span><span className="whitespace-pre-wrap font-semibold">{value||"-"}</span></div>)}</div></td><td className="px-4 py-3"><select className={`${field} min-w-[135px] font-semibold`} value={r.stage} disabled={r.status==="고객등록완료"} onChange={e=>void updateStageAndMeta(r.id,e.target.value as LeadStage)}>{leadStages.map(x=><option key={x}>{x}</option>)}</select>{legacyResults.has(r.leadResult)&&<div className="mt-1"><Badge tone="gray">기존 결과: {r.leadResult}</Badge></div>}<div className={`mt-1 max-w-[230px] truncate text-[10px] ${leadSendsToMeta(r)?(r.metaEventError?"text-red-500":r.metaEventSentAt?"text-emerald-600":"text-slate-400"):"text-slate-400"}`} title={r.metaEventError||r.metaEventName}>{leadSendsToMeta(r)?<>Meta: {r.stage}{r.metaEventError?" · 전송오류":r.metaEventSentAt?" · 전송완료":" · 전송대기"}</>:<>Meta 미전송 · {r.stage}</>}</div></td><td className="px-4 py-3">{renderCallCell({lead:r})}</td><td className="px-4 py-3"><select className={`${field} min-w-[105px]`} value={r.manager} onChange={e=>void updateLead(r.id,{manager:e.target.value as Manager})}>{managerOptions(r.manager).map(m=><option key={m}>{m}</option>)}</select></td><td className="px-4 py-3"><select className={`${field} min-w-[105px]`} value={r.coordinationManager} onChange={e=>void updateLead(r.id,{coordinationManager:e.target.value as Manager})}>{managerOptions(r.coordinationManager).map(m=><option key={m}>{m}</option>)}</select></td><td className="px-4 py-3"><input className={`${field} min-w-[210px]`} value={r.memo} onChange={e=>editMemo(r.id,e.target.value)} onBlur={()=>void saveMemo(r.id)} placeholder="메모 입력"/></td><td className="px-4 py-3"><Button disabled={r.status==="고객등록완료"} onClick={()=>beginCustomer(r)}>{r.status==="고객등록완료"?"등록완료":"고객정보등록"}</Button></td><td className="px-4 py-3"><Button variant="danger" onClick={()=>setDel(r)}><Trash2 size={14}/>삭제</Button></td></tr>)}</tbody></table></div>
   <Pagination page={page} total={filtered.length} onChange={setPage} pageSize={10}/>
  </Card>
  <Modal open={manualOpen} title="DB 수기등록" onClose={()=>{if(!manualSaving)setManualOpen(false)}}>
   <div className="space-y-4">
    <div className="rounded-xl bg-blue-50 p-3 text-sm text-blue-800">Meta/Google Sheet를 거치지 않고 로파워 신규 DB에 직접 등록합니다. 수기 DB는 Meta CRM 전송 대상에서 제외됩니다.</div>
    <div className="grid gap-4 sm:grid-cols-2">
     <Label text="DB 접수일시"><input type="datetime-local" className={field} value={manualForm.createdAt} onChange={e=>setManualForm({...manualForm,createdAt:e.target.value})}/></Label>
     <Label text="고객명"><input className={field} value={manualForm.name} onChange={e=>setManualForm({...manualForm,name:e.target.value})} placeholder="고객명"/></Label>
     <Label text="연락처"><input className={field} value={manualForm.phone} onChange={e=>setManualForm({...manualForm,phone:formatPhone(e.target.value)})} inputMode="numeric" placeholder="010-1234-5678"/></Label>
     <Label text="업체수"><NumberInput value={manualForm.lenderCount} onChange={v=>setManualForm({...manualForm,lenderCount:v})}/></Label>
     <Label text="영업 담당자"><select className={field} value={manualForm.manager} onChange={e=>setManualForm({...manualForm,manager:e.target.value as Manager})}>{managerOptions(manualForm.manager).map(m=><option key={m}>{m}</option>)}</select></Label>
     <Label text="조율 담당자"><select className={field} value={manualForm.coordinationManager} onChange={e=>setManualForm({...manualForm,coordinationManager:e.target.value as Manager})}>{managerOptions(manualForm.coordinationManager).map(m=><option key={m}>{m}</option>)}</select></Label>
     <Label text="추심강도"><input className={field} value={manualForm.collectionIntensity} onChange={e=>setManualForm({...manualForm,collectionIntensity:e.target.value})} placeholder="예: 상 / 중 / 하"/></Label>
     <Label text="대여원금"><input className={field} value={manualForm.principalAmount} onChange={e=>setManualForm({...manualForm,principalAmount:e.target.value})} placeholder="예: 300만원"/></Label>
     <Label text="상환총액"><input className={field} value={manualForm.repaymentTotal} onChange={e=>setManualForm({...manualForm,repaymentTotal:e.target.value})} placeholder="예: 450만원"/></Label>
     <Label text="증거보유"><input className={field} value={manualForm.evidence} onChange={e=>setManualForm({...manualForm,evidence:e.target.value})} placeholder="예: 카톡, 이체내역"/></Label>
     <label className="text-sm font-semibold sm:col-span-2">주변인피해<textarea className={`${textarea} mt-1.5 min-h-20`} value={manualForm.thirdPartyDamage} onChange={e=>setManualForm({...manualForm,thirdPartyDamage:e.target.value})} placeholder="주변인 연락/협박 등"/></label>
     <label className="text-sm font-semibold sm:col-span-2">메모<textarea className={`${textarea} mt-1.5 min-h-24`} value={manualForm.memo} onChange={e=>setManualForm({...manualForm,memo:e.target.value})} placeholder="상담 메모"/></label>
    </div>
    <div className="flex justify-end gap-2"><Button variant="secondary" disabled={manualSaving} onClick={()=>setManualOpen(false)}>취소</Button><Button disabled={manualSaving} onClick={()=>void saveManualLead()}>{manualSaving?"등록 중...":"DB 등록"}</Button></div>
   </div>
  </Modal>
  <CustomerModal open={customerOpen} form={customerForm} setForm={setCustomerForm} onClose={()=>setCustomerOpen(false)} onSave={()=>void saveCustomer()}/>
  <ConfirmDelete open={!!del} name={del?.name||"신규 DB"} label="DB 행 (이미 등록된 고객정보는 삭제되지 않음)" onClose={()=>setDel(null)} onConfirm={()=>{if(del)void removeLead(del.id)}}/>
  <Modal open={!!historyLead} title={`${historyLead?.name||"고객"} 콜 기록`} onClose={()=>setHistoryLead(null)}><div className="space-y-3">{historyLead&&<><div className="flex gap-2"><Button variant="secondary" onClick={()=>addCallLog(historyLead,"부재")}><PhoneMissed size={15}/>부재 기록</Button><Button variant="secondary" onClick={()=>addCallLog(historyLead,"연결")}><PhoneCall size={15}/>연결 기록</Button></div><div className="max-h-[420px] overflow-auto rounded-xl border border-slate-200">{leadLogs(historyLead.id).length===0?<div className="p-8 text-center text-sm text-slate-400">아직 콜 기록이 없습니다.</div>:leadLogs(historyLead.id).map(log=><div key={log.id} className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-0"><div className="flex items-center gap-2"><Badge tone={log.result==="연결"?"green":"amber"}>{log.result}</Badge><span className="text-sm font-semibold">{log.result==="연결"?"통화 연결":"연결 안 됨"}</span></div><div className="flex items-center gap-2"><span className="text-xs text-slate-400">{formatDate(log.createdAt)}</span><Button variant="danger" className="h-7 px-2 text-xs" onClick={()=>void deleteCallLog(log.id)}><Trash2 size={12}/>삭제</Button></div></div>)}</div></>}</div></Modal>
 </>;
}
