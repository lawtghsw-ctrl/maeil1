/** Cash is a fact; a schedule is a replaceable promise. Never infer cash from status. */
export type PromiseState="active"|"rescheduled"|"cancelled";
export type ScheduleLedgerRow={
 id?:string; customerId?:string; dueDate:string; dueAmount?:number; amount?:number;
 paidAmount?:number; paidDate?:string; allocatedAmount?:number; status?:string;
 scheduleType?:string; rescheduledFromId?:string; rootScheduleId?:string;
 obligationAmount?:number; rootObligationAmount?:number; promiseState?:PromiseState; rowVersion?:number; dateChangeCount?:number;
};
export type SchedulePosition={id:string;rootId:string;state:PromiseState;history:boolean;
 remaining:number;rawRemaining:number;planned:number;undated:number;unassigned:number};
export type ScheduleTotals={paid:number;credit:number;owed:number;remaining:number;planned:number;undated:number;unassigned:number;excess:number;overplanned:number};
export type ScheduleLedger={byId:Map<string,SchedulePosition>;totals:ScheduleTotals;issues:string[]};
const money=(value:number|undefined)=>Number.isFinite(value)?Math.max(0,value||0):0;
export const scheduleRowKey=(row:ScheduleLedgerRow,index:number)=>row.id||`draft:${index}`;
const amount=(row:ScheduleLedgerRow)=>money(row.dueAmount??row.amount);
const counts=(row:ScheduleLedgerRow)=>row.status!=="환불"&&row.scheduleType!=="환수";
const compare=(a:{id:string;row:ScheduleLedgerRow},b:{id:string;row:ScheduleLedgerRow})=>
 (a.row.dueDate||"9999-99-99").localeCompare(b.row.dueDate||"9999-99-99")||a.id.localeCompare(b.id);

/** Pass the customer's contract total for payments. Repayments use each root's
 * separate obligation amount. Legacy payment root amounts are NOT debt: several
 * historical schedules disagree with the contract and must remain readable. */
export function buildScheduleLedger(rows:ScheduleLedgerRow[],obligationTotal?:number,extraCredit=0):ScheduleLedger{
 const entries=rows.map((row,index)=>({row,id:scheduleRowKey(row,index)}));
 const lookup=new Map(entries.map(entry=>[entry.id,entry]));
 const parents=new Set(rows.map(row=>row.rescheduledFromId).filter(Boolean));
 const byId=new Map<string,SchedulePosition>(),issues:string[]=[];
 const groups=new Map<string,typeof entries>();
 for(const entry of entries){
  let current=entry;const seen=new Set<string>();
  while(current.row.rescheduledFromId&&lookup.has(current.row.rescheduledFromId)){
   if(seen.has(current.id)){issues.push("일정 연결 이력을 확인해주세요.");break}
   seen.add(current.id);current=lookup.get(current.row.rescheduledFromId)!;
  }
  const rootId=current.row.rescheduledFromId?(current.row.rootScheduleId||current.row.rescheduledFromId):current.id;
  const state:PromiseState=!counts(entry.row)?"cancelled":entry.row.promiseState||(parents.has(entry.id)?"rescheduled":"active");
  byId.set(entry.id,{id:entry.id,rootId,state,history:state!=="active",remaining:0,
   rawRemaining:Math.max(0,amount(entry.row)-money(entry.row.paidAmount)-money(entry.row.allocatedAmount)),planned:0,undated:0,unassigned:0});
  const group=groups.get(rootId)||[];group.push(entry);groups.set(rootId,group);
 }
 const totals:ScheduleTotals={paid:0,credit:0,owed:0,remaining:0,planned:0,undated:0,unassigned:0,excess:0,overplanned:0};
 const pools=obligationTotal!==undefined?new Map([["customer",entries]]):groups;
 for(const [rootId,group] of pools){
  const included=group.filter(entry=>counts(entry.row));
  const paid=included.reduce((sum,e)=>sum+money(e.row.paidAmount),0);
  const credit=included.reduce((sum,e)=>sum+money(e.row.allocatedAmount),0)+(obligationTotal!==undefined?money(extraCredit):0);
  const root=lookup.get(rootId)?.row;
  // A missing legacy repayment ancestor is diagnosable; its surviving promises
  // supply a conservative fallback until the obligation is explicitly recorded.
  const rootBudget=group.find(e=>e.row.rootObligationAmount!==undefined)?.row.rootObligationAmount;
  const owed=obligationTotal!==undefined?money(obligationTotal):root?money(root.obligationAmount??amount(root)):rootBudget!==undefined?money(rootBudget):
   included.filter(e=>byId.get(e.id)!.state==="active").reduce((sum,e)=>sum+amount(e.row),0);
  if(obligationTotal===undefined&&!root)issues.push("원본 상환 이력이 없는 일정의 채무 금액을 확인해주세요.");
  const remaining=Math.max(0,owed-paid-credit);let planned=0,nominal=0;
  for(const entry of [...included].sort(compare)){
   const position=byId.get(entry.id)!;
   if(position.state!=="active")continue;
   nominal+=position.rawRemaining;
   // A manually registered promise must stay visible at its entered amount.
   // Cash and debt are separate facts; editing a plan never silently reallocates them.
   position.remaining=position.rawRemaining;
   position.planned=entry.row.dueDate?position.remaining:0;
   position.undated=entry.row.dueDate?0:position.remaining;
   planned+=position.planned;
  }
  const available=Math.max(0,remaining-nominal);
  totals.paid+=paid;totals.credit+=credit;totals.owed+=owed;totals.remaining+=remaining;
  totals.planned+=planned;totals.undated+=Math.max(0,remaining-planned);totals.unassigned+=available;
  totals.excess+=Math.max(0,paid+credit-owed);totals.overplanned+=Math.max(0,nominal-remaining);
 }
 if(totals.overplanned>0)issues.push(`고객 또는 연결된 원본의 남은 채무 범위를 넘는 약속이 ${totals.overplanned.toLocaleString("ko-KR")}원 있습니다. 기존 금액을 확인해 일정을 정리해주세요.`);
 return {byId,totals,issues:[...new Set(issues)]};
}

type Carry={dueDate:string;dueAmount?:number;amount?:number;memo?:string};
export function previewScheduleLedger(baselineRows:ScheduleLedgerRow[],draftRows:ScheduleLedgerRow[],carries:Record<string,Carry[]>,deletedIds:string[],obligationTotal?:number,extraCredit=0){
 const deleted=new Set(deletedIds),baseline=new Map(baselineRows.filter(r=>r.id).map(r=>[r.id!,r]));
 const before=buildScheduleLedger(baselineRows,obligationTotal,extraCredit);
 const frozenBudgets=new Map<string,number>();
 for(const original of baselineRows.filter(r=>r.id&&!r.rescheduledFromId)){
  const family=baselineRows.filter(r=>r.id&&before.byId.get(r.id)?.rootId===original.id);
  const paid=family.filter(counts).reduce((sum,r)=>sum+money(r.paidAmount)+money(r.allocatedAmount),0);
  const nominal=family.reduce((sum,r)=>sum+(r.id&&before.byId.get(r.id)?.state==="active"?before.byId.get(r.id)!.rawRemaining:0),0);
  frozenBudgets.set(original.id!,original.obligationAmount??(obligationTotal!==undefined?Math.max(amount(original),paid+nominal):amount(original)));
 }
 const next:ScheduleLedgerRow[]=draftRows.filter(row=>!row.id||!deleted.has(row.id)).map(row=>{
  const old=row.id?baseline.get(row.id):undefined;
  return {...row,obligationAmount:row.obligationAmount??old?.obligationAmount??(row.id?frozenBudgets.get(row.id):undefined)};
 });
 for(const id of deleted){const original=baseline.get(id);if(original)next.push({...original,obligationAmount:original.obligationAmount??frozenBudgets.get(id),promiseState:"cancelled"})}
 for(const [id,parts] of Object.entries(carries)){
  if(!parts.length||deleted.has(id))continue;
  const source=next.find(row=>row.id===id);if(!source)continue;
  source.promiseState="rescheduled";
  parts.forEach((part,index)=>next.push({...part,id:`preview:${id}:${index}`,customerId:source.customerId,paidAmount:0,allocatedAmount:0,
   paidDate:"",status:"예정",scheduleType:source.scheduleType==="환수"?"환수":"재약정",rootScheduleId:source.rootScheduleId||id,rescheduledFromId:id,promiseState:"active"}));
 }
 return {before,after:buildScheduleLedger(next,obligationTotal,extraCredit)};
}
