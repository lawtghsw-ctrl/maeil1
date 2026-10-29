export const leadStages = ["신규","부재","설득필요","상담중","계약완료","장기부재","불가","허수"] as const;
export type LeadStage = typeof leadStages[number];
export type LeadSource = "meta" | "external";
export type LeadCallResult = "부재" | "연결";

export type LeadCallLog = {
  id:string;
  leadSource:LeadSource;
  leadId:string;
  result:LeadCallResult;
  note:string;
  createdAt:string;
};

export const CALL_WARNING_STAGES = new Set<LeadStage>(["부재","설득필요"]);
export const DAILY_NO_ANSWER_THRESHOLD = 2;
export const LONG_NO_ANSWER_DAYS = 5;

export function kstDateKey(value:Date|string=new Date()):string{
  const d=value instanceof Date?value:new Date(value);
  if(Number.isNaN(d.getTime()))return "";
  return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
}

export function callWarning(logs:LeadCallLog[],stage:LeadStage,today=kstDateKey()){
  const todays=logs.filter(log=>kstDateKey(log.createdAt)===today);
  const noAnswerCount=todays.filter(log=>log.result==="부재").length;
  const reached=todays.some(log=>log.result==="연결");
  const active=CALL_WARNING_STAGES.has(stage)&&!reached&&noAnswerCount<DAILY_NO_ANSWER_THRESHOLD;
  return {active,noAnswerCount,reached,remaining:Math.max(0,DAILY_NO_ANSWER_THRESHOLD-noAnswerCount)};
}

function dateMs(dateKey:string){
  const [y,m,d]=dateKey.split("-").map(Number);
  return Date.UTC(y||1970,(m||1)-1,d||1);
}

export function longNoAnswerQualifiedDays(logs:LeadCallLog[]):number{
  const sorted=[...logs].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  const lastReached=sorted.filter(x=>x.result==="연결").at(-1)?.createdAt;
  const afterReached=lastReached?sorted.filter(x=>new Date(x.createdAt).getTime()>new Date(lastReached).getTime()):sorted;
  const grouped=new Map<string,{noAnswer:number;reached:boolean}>();
  for(const log of afterReached){
    const day=kstDateKey(log.createdAt);if(!day)continue;
    const cur=grouped.get(day)||{noAnswer:0,reached:false};
    if(log.result==="부재")cur.noAnswer+=1;else cur.reached=true;
    grouped.set(day,cur);
  }
  return [...grouped.values()].filter(x=>!x.reached&&x.noAnswer>=DAILY_NO_ANSWER_THRESHOLD).length;
}

export function consecutiveQualifiedNoAnswerDays(logs:LeadCallLog[],today=kstDateKey()):number{
  const sorted=[...logs].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  const lastReached=sorted.filter(x=>x.result==="연결").at(-1)?.createdAt;
  const afterReached=lastReached?sorted.filter(x=>new Date(x.createdAt).getTime()>new Date(lastReached).getTime()):sorted;
  const grouped=new Map<string,{noAnswer:number;reached:boolean}>();
  for(const log of afterReached){
    const day=kstDateKey(log.createdAt);if(!day)continue;
    const cur=grouped.get(day)||{noAnswer:0,reached:false};
    if(log.result==="부재")cur.noAnswer+=1;else cur.reached=true;
    grouped.set(day,cur);
  }
  const qualified=[...grouped.entries()].filter(([,x])=>!x.reached&&x.noAnswer>=DAILY_NO_ANSWER_THRESHOLD).map(([day])=>day).sort();
  if(!qualified.length)return 0;
  let count=1;
  for(let i=qualified.length-1;i>0;i--){
    const diff=(dateMs(qualified[i])-dateMs(qualified[i-1]))/(24*60*60*1000);
    if(diff===1)count+=1;else break;
  }
  const last=qualified.at(-1)!;
  const gap=(dateMs(today)-dateMs(last))/(24*60*60*1000);
  return gap<=1?count:0;
}

export function normalizeLeadStage(value:string|undefined|null):LeadStage{
  const v=String(value||"").trim();
  if((leadStages as readonly string[]).includes(v))return v as LeadStage;
  const legacy:Record<string,LeadStage>={
    "미분류":"신규","부재중":"부재","재연락":"설득필요","유효리드":"상담중","전환":"계약완료","전환완료":"계약완료"
  };
  return legacy[v]||"신규";
}

export function stageTone(stage:LeadStage){
  if(stage==="신규")return "blue" as const;
  if(stage==="부재"||stage==="설득필요")return "amber" as const;
  if(stage==="상담중"||stage==="계약완료")return "green" as const;
  if(stage==="장기부재")return "gray" as const;
  return "red" as const;
}
