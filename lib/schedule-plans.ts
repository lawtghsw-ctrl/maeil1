export type SchedulePlan={date:string;amount:number};
export type ScheduleSource={id:string;balance:number};

export function isScheduleAmount(value:number){return Number.isSafeInteger(value)&&value>=0}
export function isScheduleDate(value:string,allowBlank=false){
 if(!value)return allowBlank;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const date=new Date(`${value}T00:00:00.000Z`);
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}

/** Preview only. The database increments the counter after a successful save. */
export function scheduleDateChangeCount(row:{id?:string;dueDate:string;dateChangeCount?:number},original?:{dueDate:string;dateChangeCount?:number}){
 const saved=original?.dateChangeCount??row.dateChangeCount??0;
 const count=Number.isSafeInteger(saved)&&saved>=0?saved:0;
 return count+(row.id&&original?.dueDate&&row.dueDate&&row.dueDate!==original.dueDate?1:0);
}

// Individual and combined replans move the same available money. A promise can
// never create debt; the unplanned remainder stays visible in the ledger.
export function allocateSchedulePlans(sources:ScheduleSource[],plans:SchedulePlan[]){
 if(!sources.length)throw new Error("재조율할 원본 일정을 선택해주세요.");
 if(sources.some(source=>!source.id||!isScheduleAmount(source.balance)))throw new Error("원본 일정의 금액을 확인해주세요.");
 if(plans.some(plan=>!isScheduleDate(plan.date,true)||!isScheduleAmount(plan.amount)))throw new Error("새 일정의 날짜와 금액을 확인해주세요.");
 if(plans.some(plan=>plan.amount===0))throw new Error("재약정 금액을 입력하거나 빈 일정을 제거해주세요.");
 if(new Set(sources.map(source=>source.id)).size!==sources.length)throw new Error("같은 원본 일정을 중복 선택할 수 없습니다.");
 const available=sources.reduce((sum,source)=>sum+source.balance,0),requested=plans.reduce((sum,plan)=>sum+plan.amount,0);
 if(requested>available)throw new Error(`재약정 금액이 남은 잔액보다 ${(requested-available).toLocaleString("ko-KR")}원 많습니다. 금액을 확인해주세요.`);
 const result:Record<string,SchedulePlan[]>={};
 let index=0,rest=sources[0].balance;
 for(const plan of plans){
  let amount=plan.amount;
  do{
   while(index<sources.length-1&&rest===0){index++;rest=sources[index].balance}
   const part=Math.min(amount,rest);
   (result[sources[index].id]??=[]).push({...plan,amount:part});
   amount-=part;rest=Math.max(0,rest-part);
  }while(amount>0);
 }
 return result;
}
