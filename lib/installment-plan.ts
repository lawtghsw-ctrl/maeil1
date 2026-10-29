export type SalaryInstallmentPlanRow={dueDate:string;amount:number};
export type SalaryInstallmentPlan={
 remaining:number;
 monthlyTarget:number;
 months:number;
 rows:SalaryInstallmentPlanRow[];
 mode:"none"|"salary15"|"three_month_equal";
};

function validDateParts(value:string){
 const m=String(value||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);
 if(!m)return null;
 return {year:Number(m[1]),month:Number(m[2]),day:Number(m[3])};
}
function daysInMonth(year:number,month:number){return new Date(year,month,0).getDate()}
function ymd(year:number,month:number,day:number){return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`}
function dueDateFor(baseDate:string,salaryDay:number,index:number){
 const base=validDateParts(baseDate);
 if(!base)return "";
 const monthOffset=(base.day<=salaryDay?0:1)+index;
 let year=base.year;
 let month=base.month+monthOffset;
 while(month>12){year+=1;month-=12}
 const day=Math.min(Math.max(1,Math.min(31,salaryDay)),daysInMonth(year,month));
 return ymd(year,month,day);
}
function splitEqual(total:number,count:number){
 if(total<=0||count<=0)return [];
 const base=Math.floor(total/count);
 let remainder=total-base*count;
 return Array.from({length:count},()=>{const extra=remainder>0?1:0;if(remainder>0)remainder-=1;return base+extra});
}

/**
 * 급여 기반 분납 규칙
 * - 선납금을 뺀 잔액을 기준으로 계산
 * - 월 기본 납부액은 세후 급여의 15%
 * - 15% 기준으로 3개월 미만이면 잔액을 3개월 균등 분할
 * - 3개월 이상이면 매달 15%씩 받고 마지막 회차에서 잔액 정리
 */
export function buildSalaryInstallmentPlan(input:{contractAmount:number;prepaidAmount:number;monthlyNetSalary:number;salaryDay:number;baseDate:string}):SalaryInstallmentPlan{
 const contract=Math.max(0,Math.round(Number(input.contractAmount)||0));
 const prepaid=Math.max(0,Math.round(Number(input.prepaidAmount)||0));
 const remaining=Math.max(0,contract-prepaid);
 const salary=Math.max(0,Math.round(Number(input.monthlyNetSalary)||0));
 const salaryDay=Math.max(0,Math.round(Number(input.salaryDay)||0));
 const monthlyTarget=Math.max(0,Math.round(salary*0.15));
 if(!remaining||!monthlyTarget||salaryDay<1||salaryDay>31||!validDateParts(input.baseDate))return{remaining,monthlyTarget,months:0,rows:[],mode:"none"};
 const rawMonths=Math.ceil(remaining/monthlyTarget);
 // 비정상적으로 작은 급여 입력으로 수천 개 일정을 만드는 것을 방지합니다.
 if(rawMonths>600)return {remaining,monthlyTarget,months:0,rows:[],mode:"none"};
 const months=Math.max(3,rawMonths);
 let amounts:number[];
 let mode:SalaryInstallmentPlan["mode"];
 if(rawMonths<3){amounts=splitEqual(remaining,3);mode="three_month_equal"}
 else{
  amounts=[];let rest=remaining;
  for(let i=0;i<months;i++){const amount=i===months-1?rest:Math.min(monthlyTarget,rest);amounts.push(amount);rest=Math.max(0,rest-amount)}
  mode="salary15";
 }
 const rows=amounts.filter(x=>x>0).map((amount,index)=>({dueDate:dueDateFor(input.baseDate,salaryDay,index),amount}));
 return{remaining,monthlyTarget,months:rows.length,rows,mode};
}
