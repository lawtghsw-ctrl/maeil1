export type InstallmentPlanRow={dueDate:string;amount:number};
export type InstallmentPlan={totalAmount:number;remaining:number;monthlyAmount:number;months:number;rows:InstallmentPlanRow[]};
export type CustomerInstallmentInput={
 contractAmount:number;prepaidAmount:number;installmentMonths:number;createdAt:string;contractDate?:string;
 autoCreateInstallments?:boolean;installmentTotal?:number;installmentFirstDate?:string;
 installmentRows?:InstallmentPlanRow[];installmentPlanSignature?:string;
};

const emptyPlan=():InstallmentPlan=>({totalAmount:0,remaining:0,monthlyAmount:0,months:0,rows:[]});
function dateParts(value:string){
 const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
 if(!match)return null;
 const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
 if(year<1||month<1||month>12||day<1||day>daysInMonth(year,month))return null;
 return {year,month,day};
}
function daysInMonth(year:number,month:number){
 if(month===2)return year%4===0&&(year%100!==0||year%400===0)?29:28;
 return [4,6,9,11].includes(month)?30:31;
}
function monthlyDate(first:{year:number;month:number;day:number},offset:number){
 const position=first.month-1+offset,year=first.year+Math.floor(position/12),month=position%12+1;
 if(year>9999)throw new Error("분납 마지막 날짜가 유효한 기간을 벗어납니다.");
 const day=Math.min(first.day,daysInMonth(year,month));
 return `${String(year).padStart(4,"0")}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

/** The operator chooses the amount, count and first date. Every row is unpaid. */
export function buildInstallmentPlan(input:{totalAmount:number;months:number;firstPaymentDate:string}):InstallmentPlan{
 if(!Number.isSafeInteger(input.totalAmount)||input.totalAmount<0)throw new Error("총 분납금은 0원 이상의 정수로 입력해주세요.");
 if(input.totalAmount===0)return emptyPlan();
 if(!Number.isInteger(input.months)||input.months<1||input.months>600)throw new Error("분납 개월 수를 1~600개월로 입력해주세요.");
 if(input.totalAmount<input.months)throw new Error("각 회차가 1원 이상이 되도록 분납금과 개월 수를 확인해주세요.");
 const first=dateParts(input.firstPaymentDate);
 if(!first)throw new Error("첫 납부일을 정확히 입력해주세요.");
 const monthlyAmount=Math.floor(input.totalAmount/input.months);
 const rows=Array.from({length:input.months},(_,index)=>({
  dueDate:monthlyDate(first,index),
  amount:index===input.months-1?input.totalAmount-monthlyAmount*(input.months-1):monthlyAmount,
 }));
 return {totalAmount:input.totalAmount,remaining:input.totalAmount,monthlyAmount,months:input.months,rows};
}

export function getCustomerInstallmentTotal(input:CustomerInstallmentInput){
 return input.installmentTotal??Math.max(0,input.contractAmount-input.prepaidAmount);
}
export function customerInstallmentSignature(input:CustomerInstallmentInput){
 return JSON.stringify([input.contractAmount,input.prepaidAmount,getCustomerInstallmentTotal(input),input.installmentMonths,input.installmentFirstDate||input.contractDate||input.createdAt]);
}

/** Both registration routes save the same validated, explicitly generated preview. */
export function getCustomerInstallmentPlan(input:CustomerInstallmentInput):InstallmentPlan{
 if(input.autoCreateInstallments===false)return emptyPlan();
 const plan=buildInstallmentPlan({totalAmount:getCustomerInstallmentTotal(input),months:input.installmentMonths,firstPaymentDate:input.installmentFirstDate||input.contractDate||input.createdAt});
 if(!plan.rows.length)return plan;
 if(input.installmentPlanSignature!==customerInstallmentSignature(input)||!input.installmentRows)throw new Error("총 분납금·개월 수·첫 납부일을 확인하고 [일정 만들기]를 눌러주세요. 입력값을 바꿨다면 다시 만들어주세요.");
 const rows=input.installmentRows;
 if(rows.length!==plan.months||rows.some(row=>!dateParts(row.dueDate)||!Number.isSafeInteger(row.amount)||row.amount<=0))throw new Error("분납표의 회차 수·날짜·금액을 확인해주세요. 각 금액은 1원 이상의 정수여야 합니다.");
 let total=0;
 for(const row of rows){total+=row.amount;if(!Number.isSafeInteger(total))throw new Error("분납표 합계가 허용되는 금액을 벗어납니다.");}
 if(total!==plan.totalAmount)throw new Error("분납표 금액의 합계가 총 분납금과 일치해야 합니다.");
 return {...plan,rows:rows.map(row=>({...row}))};
}
