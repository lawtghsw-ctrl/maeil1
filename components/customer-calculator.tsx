"use client";

import {useEffect,useMemo,useState} from "react";
import {Calculator,ChevronDown,ChevronUp,History,Save,Settings2,X} from "lucide-react";
import {Badge,Button,Card} from "@/components/ui";
import {ContactType,Customer,Repayment,useAdminStore} from "@/components/store";
import {createClient} from "@/lib/supabase/client";
import {won} from "@/lib/utils";
import {useRole} from "@/components/role-provider";

type Tab="guide"|"history"|"settings";
type GuidePeriod="1주"|"2주"|"3주"|"4주"|"2달";
type PeriodAmounts=Record<GuidePeriod,number>;

type Guideline={
 id?:string;
 contactType:ContactType;
 defaultPeriod:GuidePeriod;
 periodAmounts:PeriodAmounts;
 memo:string;
};

type CalculatorItem={
 repaymentId:string;
 selectedPeriod:GuidePeriod|null;
 targetAmount:number|null;
 memo:string;
};

type Snapshot={
 id:string;
 createdAt:string;
 currentRepaymentAmount:number;
 expectedNegotiatedAmount:number;
 reductionBenefit:number;
 snapshotData:any;
};

const supabase=createClient();
const contactTypes:ContactType[]=["번호","텔레그램","카카오톡","라인"];
const guidePeriods:GuidePeriod[]=["1주","2주","3주","4주","2달"];
const inputClass="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100";
const num=(v:unknown)=>Number(v||0);
const moneyInput=(v:number)=>v?Math.round(v).toLocaleString("ko-KR"):"";
function parseMoney(v:string){const n=Number(v.replace(/[^0-9-]/g,""));return Number.isFinite(n)?Math.max(0,n):0}
function emptyPeriodAmounts():PeriodAmounts{return{"1주":0,"2주":0,"3주":0,"4주":0,"2달":0}}
function emptyGuideline(contactType:ContactType):Guideline{return{contactType,defaultPeriod:"1주",periodAmounts:emptyPeriodAmounts(),memo:""}}
function emptyItem(repaymentId:string):CalculatorItem{return{repaymentId,selectedPeriod:null,targetAmount:null,memo:""}}
function isFinished(r:Repayment){return r.status==="상환완료"||r.status==="종결"||String(r.status)==="완료"}
function periodColumn(period:GuidePeriod){return period==="1주"?"guide_1w_amount":period==="2주"?"guide_2w_amount":period==="3주"?"guide_3w_amount":period==="4주"?"guide_4w_amount":"guide_2m_amount"}
function periodAmountsFromRow(x:any):PeriodAmounts{return{"1주":num(x?.guide_1w_amount),"2주":num(x?.guide_2w_amount),"3주":num(x?.guide_3w_amount),"4주":num(x?.guide_4w_amount),"2달":num(x?.guide_2m_amount)}}

export function CustomerCalculator({open,customer,onClose}:{open:boolean;customer:Customer;onClose:()=>void}){
 const s=useAdminStore();
 const {isAdmin}=useRole();
 const [tab,setTab]=useState<Tab>("guide");
 const [guidelines,setGuidelines]=useState<Guideline[]>(contactTypes.map(emptyGuideline));
 const [items,setItems]=useState<Record<string,CalculatorItem>>({});
 const [snapshots,setSnapshots]=useState<Snapshot[]>([]);
 const [loading,setLoading]=useState(false);
 const [saving,setSaving]=useState(false);
 const [loadError,setLoadError]=useState("");
 const [expandedSnapshot,setExpandedSnapshot]=useState<string|null>(null);
 const repayments=useMemo(()=>s.repayments.filter(r=>r.customerId===customer.id),[s.repayments,customer.id]);
 const activeRepayments=useMemo(()=>repayments.filter(r=>!isFinished(r)),[repayments]);

 useEffect(()=>{if(open){setTab("guide");void loadData()}},[open,customer.id]);
 // 입력 중 자동 새로고침으로 작업값이 초기화되지 않도록, 열려 있는 동안에는 최초 로드와 명시적 저장 후 로드만 사용합니다.

 async function loadData(){
  setLoading(true);setLoadError("");
  const [g,i,h]=await Promise.all([
   supabase.from("negotiation_guidelines").select("*").order("contact_type"),
   supabase.from("customer_calculator_items").select("*").eq("customer_id",customer.id),
   supabase.from("customer_calculation_snapshots").select("*").eq("customer_id",customer.id).order("created_at",{ascending:false}).limit(30),
  ]);
  const firstError=g.error||i.error||h.error;
  if(firstError){setLoadError(firstError.message);setLoading(false);return}
  const byType=new Map<string,any>((g.data||[]).map((x:any)=>[x.contact_type,x]));
  setGuidelines(contactTypes.map(t=>{const x=byType.get(t);return x?{id:x.id,contactType:t,defaultPeriod:(guidePeriods.includes(x.default_period as GuidePeriod)?x.default_period:"1주") as GuidePeriod,periodAmounts:periodAmountsFromRow(x),memo:x.memo||""}:emptyGuideline(t)}));
  const next:Record<string,CalculatorItem>={};
  for(const x of i.data||[]){next[x.repayment_schedule_id]={repaymentId:x.repayment_schedule_id,selectedPeriod:guidePeriods.includes(x.selected_period as GuidePeriod)?x.selected_period as GuidePeriod:null,targetAmount:x.target_amount===null||x.target_amount===undefined?null:num(x.target_amount),memo:x.memo||""}}
  setItems(next);
  setSnapshots((h.data||[]).map((x:any)=>({id:x.id,createdAt:x.created_at||"",currentRepaymentAmount:num(x.current_repayment_amount),expectedNegotiatedAmount:num(x.expected_negotiated_amount),reductionBenefit:num(x.reduction_benefit),snapshotData:x.snapshot_data||{}})));
  setLoading(false);
 }

 function guidelineFor(r:Repayment){return guidelines.find(g=>g.contactType===r.contactType)||emptyGuideline(r.contactType)}
 function itemFor(r:Repayment):CalculatorItem{return items[r.id]||emptyItem(r.id)}
 function updateItem(id:string,patch:Partial<CalculatorItem>){setItems(prev=>({...prev,[id]:{...(prev[id]||emptyItem(id)),...patch}}))}
 function updateGuideline(type:ContactType,patch:Partial<Guideline>){setGuidelines(prev=>prev.map(g=>g.contactType===type?{...g,...patch}:g))}
 function updatePeriodAmount(type:ContactType,period:GuidePeriod,value:number){setGuidelines(prev=>prev.map(g=>g.contactType===type?{...g,periodAmounts:{...g.periodAmounts,[period]:value}}:g))}

 const calculations=useMemo(()=>activeRepayments.map(r=>{
  const g=guidelineFor(r);
  const item=itemFor(r);
  const selectedPeriod=item.selectedPeriod||g.defaultPeriod;
  const guideDeduction=Math.max(0,g.periodAmounts[selectedPeriod]||0);
  const currentAmount=Math.max(0,r.amount||0);
  const quickGuideAmount=Math.max(0,currentAmount-guideDeduction);
  const effectiveAmount=item.targetAmount!==null?item.targetAmount:quickGuideAmount;
  const reduction=Math.max(0,currentAmount-effectiveAmount);
  return{r,g,item,selectedPeriod,guideDeduction,currentAmount,quickGuideAmount,effectiveAmount,reduction};
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }),[activeRepayments,guidelines,items]);

 const totals=useMemo(()=>({
  current:calculations.reduce((a,x)=>a+x.currentAmount,0),
  guide:calculations.reduce((a,x)=>a+x.effectiveAmount,0),
  reduction:calculations.reduce((a,x)=>a+x.reduction,0),
 }),[calculations]);

 async function saveWorkingValues(){
  setSaving(true);
  const rows=activeRepayments.map(r=>{const x=itemFor(r);return{customer_id:customer.id,repayment_schedule_id:r.id,selected_period:x.selectedPeriod,target_amount:x.targetAmount,memo:x.memo}});
  if(rows.length){const {error}=await supabase.from("customer_calculator_items").upsert(rows,{onConflict:"customer_id,repayment_schedule_id"});if(error){alert(error.message);setSaving(false);return}}
  setSaving(false);alert("조율 계산기 입력값을 저장했습니다.")
 }

 async function saveGuidelines(){
  if(!isAdmin)return alert("전사 가이드 설정은 최종관리자만 변경할 수 있습니다.");
  setSaving(true);
  const rows=guidelines.map(g=>({contact_type:g.contactType,default_period:g.defaultPeriod,guide_1w_amount:g.periodAmounts["1주"],guide_2w_amount:g.periodAmounts["2주"],guide_3w_amount:g.periodAmounts["3주"],guide_4w_amount:g.periodAmounts["4주"],guide_2m_amount:g.periodAmounts["2달"],memo:g.memo}));
  const {error}=await supabase.from("negotiation_guidelines").upsert(rows,{onConflict:"contact_type"});
  setSaving(false);if(error)return alert(error.message);alert("전사 공통 조율 가이드라인을 저장했습니다. 모든 고객의 조율 계산기에 동일하게 적용됩니다.");void loadData();
 }

 async function saveSnapshot(){
  setSaving(true);
  const snapshotData={customer:{id:customer.id,name:customer.name,phone:customer.phone,coordinationManager:customer.coordinationManager},guideVersion:"quick-period-deduction-v3",items:calculations.map(x=>({repaymentId:x.r.id,lenderName:x.r.lenderName,contactType:x.r.contactType,status:x.r.status,currentAmount:x.currentAmount,selectedPeriod:x.selectedPeriod,guideDeduction:x.guideDeduction,quickGuideAmount:x.quickGuideAmount,targetAmount:x.item.targetAmount,effectiveAmount:x.effectiveAmount,reductionBenefit:x.reduction,memo:x.item.memo}))};
  const {error}=await supabase.from("customer_calculation_snapshots").insert({customer_id:customer.id,scenario:"standard",total_contract_fee:0,current_repayment_amount:totals.current,expected_negotiated_amount:totals.guide,reduction_benefit:totals.reduction,extension_savings:0,total_economic_benefit:totals.reduction,net_economic_benefit:0,benefit_multiple:0,snapshot_data:snapshotData});
  setSaving(false);if(error)return alert(error.message);alert("현재 조율 가이드를 이력으로 저장했습니다.");void loadData();
 }

 async function deleteSnapshot(id:string){if(!isAdmin)return alert("계산 이력 삭제는 최종관리자만 가능합니다.");if(!window.confirm("이 조율 계산 이력을 삭제할까요?"))return;const {error}=await supabase.from("customer_calculation_snapshots").delete().eq("id",id);if(error)return alert(error.message);setSnapshots(x=>x.filter(s=>s.id!==id))}

 if(!open)return null;

 return <div data-admin-edit-lock="true" className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/45 p-3 sm:p-5">
  <div className="flex max-h-[94vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
   <div className="flex shrink-0 items-center justify-between border-b border-slate-100 bg-white px-5 py-4">
    <div className="min-w-0"><div className="flex items-center gap-2"><Calculator size={19} className="text-blue-600"/><h2 className="truncate text-lg font-bold">{customer.name} · 조율 계산기</h2></div><div className="mt-1 text-xs text-slate-500">{customer.phone} · 조율 담당자 {customer.coordinationManager}</div></div>
    <Button variant="secondary" onClick={onClose}><X size={15}/>닫기</Button>
   </div>
   <div className="shrink-0 border-b border-slate-100 bg-slate-50/70 px-5 py-3">
    <div className="flex flex-wrap gap-2">{([["guide","조율 가이드"],["history","계산 이력"],...(isAdmin?[["settings","가이드 설정"]]:[])] as [string,string][]).map(([key,label])=><button key={key} type="button" onClick={()=>setTab(key as Tab)} className={`rounded-lg px-3 py-2 text-sm font-bold transition ${tab===key?"bg-blue-600 text-white":"border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>{label}</button>)}</div>
   </div>
   <div className="overflow-y-auto p-5">
    {loading?<div className="py-16 text-center text-sm font-semibold text-slate-400">조율 계산기 데이터를 불러오는 중입니다...</div>:loadError?<Card className="border-red-200 p-5"><div className="font-bold text-red-700">조율 계산기 DB 업데이트가 필요합니다.</div><div className="mt-2 text-sm text-slate-500">Supabase에서 <b>customer-negotiation-calculator-v3.sql</b>을 실행해주세요.</div><div className="mt-2 break-all text-xs text-red-500">{loadError}</div></Card>:<>
     {tab==="guide"&&<div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><SummaryCard label="조율 대상 업체" value={`${activeRepayments.length}곳`} sub="상환완료·종결 제외"/><SummaryCard label="현재 상환금액 합계" value={won(totals.current)} sub="등록된 상환일정 금액"/><SummaryCard label="가이드 적용 합계" value={won(totals.guide)} sub="빠른 가이드 또는 실무 목표" accent="blue"/><SummaryCard label="예상 감액 합계" value={won(totals.reduction)} sub="현재 상환금액 - 적용금액" accent="green"/></div>
      <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4"><div className="font-bold text-blue-950">빠른 조율 가이드</div><div className="mt-1 text-xs leading-5 text-blue-700">누적 원금·기상환금액을 따로 입력하지 않습니다. 상환일정에 이미 등록된 <b>현재 상환금액</b>에서 `연락수단 × 선택기간`별 전사 공통 <b>원화 감액 가이드액</b>을 차감해 빠른 조율 목표금액을 계산합니다. 필요하면 실무 목표 조율금액만 직접 덮어쓸 수 있습니다.</div></div>
      {activeRepayments.length===0?<Card className="p-10 text-center text-sm text-slate-400">현재 조율 대상인 상환일정이 없습니다. 상환완료·종결 건은 기본 계산 대상에서 제외합니다.</Card>:calculations.map((x,index)=><Card key={x.r.id} className="overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3"><div className="flex items-center gap-2"><b>{index+1}. {x.r.lenderName||"업체명 없음"}</b><Badge tone="blue">{x.r.contactType}</Badge><Badge tone={x.r.status==="연체"?"red":x.r.status==="보류"?"amber":"gray"}>{x.r.status}</Badge></div><div className="text-sm font-bold">현재 상환 {won(x.currentAmount)}</div></div><div className="grid gap-4 p-4 lg:grid-cols-4">
       <ReadOnly label="현재 상환예정일" value={x.r.dueDate||"-"}/><PeriodField label="예상 조율기간" value={x.selectedPeriod} onChange={v=>updateItem(x.r.id,{selectedPeriod:v})}/><ReadOnly label="기간별 공통 감액 가이드" value={won(x.guideDeduction)}/><ReadOnly label="빠른 가이드 조율금액" value={won(x.quickGuideAmount)} accent/>
       <ReadOnly label="연락수단" value={x.r.contactType}/><ReadOnly label="현재 상환금액" value={won(x.currentAmount)}/><NumberField label="실무 목표 조율금액" value={x.item.targetAmount} onChange={v=>updateItem(x.r.id,{targetAmount:v})} placeholder={`가이드 ${won(x.quickGuideAmount)}`}/><ReadOnly label="최종 적용 조율금액" value={won(x.effectiveAmount)} accent/>
       <ReadOnly label="예상 감액액" value={won(x.reduction)} accent/><ReadOnly label="가이드 근거" value={`${x.r.contactType} · ${x.selectedPeriod} · ${won(x.guideDeduction)} 차감`}/><label className="lg:col-span-2 text-xs font-semibold text-slate-500">조율 메모<input className={`${inputClass} mt-1.5`} value={x.item.memo} onChange={e=>updateItem(x.r.id,{memo:e.target.value})} placeholder="업체 성향, 조율 포인트, 특이사항 등"/></label>
      </div></Card>)}
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">예: 현재 상환금액 800,000원 / 텔레그램 2주 공통 감액 가이드 200,000원 → 빠른 가이드 조율금액 600,000원. 실제 업체 상황이 다르면 `실무 목표 조율금액`을 직접 입력하면 그 값이 최종 적용됩니다.</div>
      <div className="flex flex-wrap justify-end gap-2">{isAdmin&&<Button variant="secondary" onClick={()=>setTab("settings")}><Settings2 size={15}/>가이드 설정</Button>}<Button variant="secondary" disabled={saving} onClick={()=>void saveWorkingValues()}><Save size={15}/>업체별 입력값 저장</Button><Button disabled={saving} onClick={()=>void saveSnapshot()}><History size={15}/>현재 가이드 이력 저장</Button></div>
     </div>}

     {tab==="history"&&<div className="space-y-3"><div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">조율 가이드를 저장하면 당시 업체별 현재 상환금액·선택 기간·공통 감액 가이드·실무 목표금액을 Snapshot으로 보존합니다.</div>{snapshots.length===0?<Card className="p-10 text-center text-sm text-slate-400">저장된 조율 계산 이력이 없습니다.</Card>:snapshots.map(x=><Card key={x.id} className="overflow-hidden"><div className="p-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div><div className="flex items-center gap-2"><b>{new Date(x.createdAt).toLocaleString("ko-KR")}</b><Badge tone="blue">{x.snapshotData?.guideVersion==="quick-period-deduction-v3"?"빠른 조율 가이드":"기존 계산 이력"}</Badge></div><div className="mt-2 grid gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-3"><span>현재 상환합계 <b>{won(x.currentRepaymentAmount)}</b></span><span>적용 조율합계 <b>{won(x.expectedNegotiatedAmount)}</b></span><span>예상 감액합계 <b>{won(x.reductionBenefit)}</b></span></div></div><div className="flex gap-2"><Button variant="secondary" onClick={()=>setExpandedSnapshot(v=>v===x.id?null:x.id)}>{expandedSnapshot===x.id?<ChevronUp size={15}/>:<ChevronDown size={15}/>}상세보기</Button>{isAdmin&&<Button variant="danger" onClick={()=>void deleteSnapshot(x.id)}>삭제</Button>}</div></div></div>{expandedSnapshot===x.id&&<SnapshotDetail snapshot={x}/>}</Card>)}</div>}

     {tab==="settings"&&isAdmin&&<div className="space-y-4"><div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-800"><b>이 가이드라인은 전사 공통입니다.</b> 어느 고객의 조율 계산기에서 수정하든 동일한 값이 저장되어 모든 고객에게 적용됩니다. 감액률 대신 <b>기간별 원화 감액 가이드액</b>을 직접 입력합니다.</div>{guidelines.map(g=><Card key={g.contactType} className="p-4"><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div><div className="font-bold">{g.contactType}</div><div className="mt-1 text-xs text-slate-500">현재 상환금액 - 선택 기간의 공통 감액 가이드액 = 빠른 조율 가이드금액</div></div><Badge tone="green">전사 공통</Badge></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><PeriodField label="기본 선택기간" value={g.defaultPeriod} onChange={v=>updateGuideline(g.contactType,{defaultPeriod:v})}/>{guidePeriods.map(p=><NumberField key={p} label={`${p} 감액 가이드액`} value={g.periodAmounts[p]} onChange={v=>updatePeriodAmount(g.contactType,p,v??0)}/>)}</div><label className="mt-3 block text-xs font-semibold text-slate-500">내부 기준 메모<input className={`${inputClass} mt-1.5`} value={g.memo} onChange={e=>updateGuideline(g.contactType,{memo:e.target.value})} placeholder="연락수단별 조율 특성 또는 가이드 산정 근거"/></label></Card>)}<div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-6 text-slate-600">처음에는 모든 기간별 감액 가이드액을 0원으로 두었습니다. 실제 회사 조율기준에 맞는 원화 금액을 직접 입력해 사용하세요. 임의의 감액률이나 가짜 기본값은 적용하지 않습니다.</div><div className="flex justify-end"><Button disabled={saving} onClick={()=>void saveGuidelines()}><Save size={15}/>전사 가이드라인 저장</Button></div></div>}
    </>}
   </div>
  </div>
 </div>
}

function SummaryCard({label,value,sub,accent="normal"}:{label:string;value:string;sub:string;accent?:"normal"|"blue"|"green"}){const cls=accent==="blue"?"border-blue-100 bg-blue-50/60 text-blue-900":accent==="green"?"border-emerald-100 bg-emerald-50/60 text-emerald-900":"border-slate-200 bg-white text-slate-900";return <div className={`rounded-xl border p-4 ${cls}`}><div className="text-xs font-semibold opacity-70">{label}</div><div className="mt-2 text-xl font-bold">{value}</div><div className="mt-1 text-[11px] opacity-65">{sub}</div></div>}
function ReadOnly({label,value,accent=false}:{label:string;value:string;accent?:boolean}){return <div><div className="text-xs font-semibold text-slate-500">{label}</div><div className={`mt-1.5 flex min-h-9 items-center rounded-lg border px-2.5 py-2 text-sm font-bold ${accent?"border-blue-100 bg-blue-50 text-blue-800":"border-slate-200 bg-slate-50 text-slate-700"}`}>{value}</div></div>}
function NumberField({label,value,onChange,placeholder="0"}:{label:string;value:number|null;onChange:(v:number|null)=>void;placeholder?:string}){return <label className="text-xs font-semibold text-slate-500">{label}<input inputMode="numeric" className={`${inputClass} mt-1.5`} value={value===null?"":moneyInput(value)} placeholder={placeholder} onChange={e=>{const raw=e.target.value.trim();onChange(raw===""?null:parseMoney(raw))}}/></label>}
function PeriodField({label,value,onChange}:{label:string;value:GuidePeriod;onChange:(v:GuidePeriod)=>void}){return <label className="text-xs font-semibold text-slate-500">{label}<select className={`${inputClass} mt-1.5`} value={value} onChange={e=>onChange(e.target.value as GuidePeriod)}>{guidePeriods.map(p=><option key={p} value={p}>{p}</option>)}</select></label>}

function SnapshotDetail({snapshot}:{snapshot:Snapshot}){
 const rows=Array.isArray(snapshot.snapshotData?.items)?snapshot.snapshotData.items:[];
 const quick=snapshot.snapshotData?.guideVersion==="quick-period-deduction-v3";
 if(rows.length===0)return <div className="border-t border-slate-100 bg-slate-50/60 p-4 text-sm text-slate-400">저장된 업체 상세정보가 없습니다.</div>;
 return <div className="border-t border-slate-100 bg-slate-50/60 p-4"><div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="admin-responsive-table w-full min-w-[900px] text-sm"><thead className="bg-slate-50 text-left text-xs text-slate-500"><tr>{(quick?["업체명","연락수단","당시 상환금액","기간","공통 감액 가이드","빠른 가이드","실무 목표","최종 적용","예상 감액"]:["업체명","연락수단","당시 상환금액","저장된 가이드금액","실무 목표","적용금액","예상 감액"]).map(h=><th key={h} className="px-3 py-2.5">{h}</th>)}</tr></thead><tbody>{rows.map((r:any,i:number)=><tr key={`${r.repaymentId||i}`} className="border-t border-slate-100"><td className="px-3 py-2.5 font-semibold">{r.lenderName||"-"}</td><td className="px-3 py-2.5">{r.contactType||"-"}</td><td className="px-3 py-2.5">{won(num(r.currentAmount))}</td>{quick?<><td className="px-3 py-2.5">{r.selectedPeriod||"-"}</td><td className="px-3 py-2.5">{won(num(r.guideDeduction))}</td><td className="px-3 py-2.5">{won(num(r.quickGuideAmount))}</td><td className="px-3 py-2.5">{r.targetAmount===null||r.targetAmount===undefined?"-":won(num(r.targetAmount))}</td><td className="px-3 py-2.5 font-semibold text-blue-700">{won(num(r.effectiveAmount))}</td><td className="px-3 py-2.5">{won(num(r.reductionBenefit))}</td></>:<><td className="px-3 py-2.5">{won(num(r.guideAmount))}</td><td className="px-3 py-2.5">{r.targetAmount===null||r.targetAmount===undefined?"-":won(num(r.targetAmount))}</td><td className="px-3 py-2.5 font-semibold text-blue-700">{won(num(r.effectiveAmount))}</td><td className="px-3 py-2.5">{won(num(r.reductionBenefit))}</td></>}</tr>)}</tbody></table></div></div>
}
