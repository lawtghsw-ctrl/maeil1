import {formatBirthNumber,formatPhone} from "@/lib/utils";

export type CustomerTextPatch={
  createdAt?:string;
  name?:string;
  phone?:string;
  address?:string;
  birthNumber?:string;
  manager?:string;
  coordinationManager?:string;
  memo?:string;
  contractDate?:string;
  contractAmount?:number;
  prepaidAmount?:number;
  installmentMonths?:number;
  lenderUnitPrice?:number;
  lenderCount?:number;
};

export type CustomerTextParseResult={
  patch:CustomerTextPatch;
  recognized:string[];
  inferred:string[];
  unparsed:string[];
};

const labels={
  createdAt:["등록일","접수일","고객등록일"],
  name:["고객명","성명","이름","의뢰인명","의뢰인","신청자"],
  phone:["연락처","전화번호","휴대폰","핸드폰","전화","폰번호"],
  address:["주소지","주소","거주지","현주소"],
  birthNumber:["생년월일/주민번호","생년월일 / 주민번호","주민등록번호","주민번호","생년월일"],
  manager:["영업 담당자","영업담당자","영업 담당","영업담당"],
  coordinationManager:["조율 담당자","조율담당자","조율 담당","조율담당"],
  contractDate:["계약일","수임일","계약 날짜","계약날짜"],
  contractAmount:["계약금액","총 계약금액","수임금액","수임료","계약금"],
  prepaidAmount:["선납금","선납 금액","선입금","선금","선납"],
  installmentMonths:["분납기간(개월)","분납기간","분납 기간","분납개월","분납 개월"],
  lenderUnitPrice:["업체당 단가","업체당단가","업체당 계약금액","업체당 수임료","건당 단가","건당 수임료"],
  lenderCount:["업체수","업체 수","대부업체수","사채업체수","업체 개수"],
  memo:["메모","비고","특이사항","상담메모","상담 메모"],
} as const;

type LabelKey=keyof typeof labels;
const labelEntries=(Object.keys(labels) as LabelKey[]).flatMap(key=>labels[key].map(label=>({key,label}))).sort((a,b)=>b.label.length-a.label.length);

function cleanLine(v:string){return v.replace(/[\u2022•●▪◦]/g," ").replace(/^\s*[-–—]\s*/,"").trim()}
function stripLabel(line:string,label:string){
  const source=line.trim();
  if(!source.toLowerCase().startsWith(label.toLowerCase()))return null;
  const tail=source.slice(label.length);
  if(tail && !/^\s*[:：=\-–—]?\s*/.test(tail))return null;
  return tail.replace(/^\s*[:：=\-–—]?\s*/,"").trim();
}

function numberOnly(v:string){const n=Number((v.match(/-?[\d,.]+/)?.[0]||"").replace(/,/g,""));return Number.isFinite(n)?n:0}

export function parseKoreanAmount(v:string){
  const text=(v||"").replace(/,/g,"").replace(/\s+/g," ").trim();
  if(!text)return 0;
  let total=0;let foundUnit=false;
  const units:[[RegExp,number],[RegExp,number],[RegExp,number]]=[
    [/([\d.]+)\s*억/g,100_000_000],
    [/([\d.]+)\s*만/g,10_000],
    [/([\d.]+)\s*천/g,1_000],
  ];
  for(const [re,mult] of units){
    for(const m of text.matchAll(re)){const n=Number(m[1]);if(Number.isFinite(n)){total+=n*mult;foundUnit=true}}
  }
  if(foundUnit)return Math.round(total);
  return Math.max(0,Math.round(numberOnly(text)));
}

function dateParts(year:number,month:number,day:number){
  if(year<100)year+=2000;
  if(year<2000||year>2100||month<1||month>12||day<1||day>31)return "";
  const d=new Date(year,month-1,day);
  if(d.getFullYear()!==year||d.getMonth()!==month-1||d.getDate()!==day)return "";
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

export function parseKoreanDate(v:string){
  const text=(v||"").trim();
  let m=text.match(/\b(20\d{2}|\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})\b/);
  if(m)return dateParts(Number(m[1]),Number(m[2]),Number(m[3]));
  m=text.match(/\b(20\d{2}|\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?/);
  if(m)return dateParts(Number(m[1]),Number(m[2]),Number(m[3]));
  m=text.match(/\b(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if(m)return dateParts(new Date().getFullYear(),Number(m[1]),Number(m[2]));
  m=text.match(/\b(\d{1,2})\s*[.\-/]\s*(\d{1,2})\b/);
  if(m)return dateParts(new Date().getFullYear(),Number(m[1]),Number(m[2]));
  return "";
}

function parseCount(v:string){const m=v.match(/\d+/);return m?Math.max(0,Number(m[0])):0}
function parseMonths(v:string){const m=v.match(/(\d+)\s*(?:개월|달|월)/);return m?Math.max(0,Number(m[1])):parseCount(v)}
function cleanName(v:string){return v.replace(/\([^)]*\)/g,"").replace(/\s{2,}/g," ").trim().slice(0,40)}
function isNameCandidate(v:string){return /^[가-힣]{2,5}$/.test(v)&&!["고객정보","의뢰인","상담내용","신청정보","고객등록"].includes(v)}
function hasPhone(v:string){return v.match(/(?:01[016789])[- .]?\d{3,4}[- .]?\d{4}/)?.[0]||""}
function hasBirth(v:string){return v.match(/\b\d{6}\s*[- ]?\s*\d{7}\b/)?.[0]||""}

function parseLabeledValue(key:LabelKey,value:string):string|number|undefined{
  switch(key){
    case "createdAt":
    case "contractDate": return parseKoreanDate(value)||undefined;
    case "name": return cleanName(value)||undefined;
    case "phone": {const p=hasPhone(value)||value;const formatted=formatPhone(p);return formatted||undefined;}
    case "birthNumber": {const b=hasBirth(value)||value;const formatted=formatBirthNumber(b);return formatted||undefined;}
    case "address": return value.trim()||undefined;
    case "manager":
    case "coordinationManager": return value.replace(/\s+/g," ").trim()||undefined;
    case "contractAmount":
    case "prepaidAmount":
    case "lenderUnitPrice": {const n=parseKoreanAmount(value);return n>0?n:undefined;}
    case "installmentMonths": {const n=parseMonths(value);return n>0?n:undefined;}
    case "lenderCount": {const n=parseCount(value);return n>0?n:undefined;}
    case "memo": return value.trim()||undefined;
  }
}

export function parseCustomerText(raw:string):CustomerTextParseResult{
  const source=(raw||"").replace(/\r/g,"").trim();
  const patch:CustomerTextPatch={};
  const recognized:string[]=[];
  const inferred:string[]=[];
  const unparsed:string[]=[];
  if(!source)return{patch,recognized,inferred,unparsed};

  const lines=source.split("\n").map(cleanLine).filter(Boolean);
  const consumed=new Set<number>();
  let memoParts:string[]=[];

  lines.forEach((line,index)=>{
    for(const entry of labelEntries){
      const value=stripLabel(line,entry.label);
      if(value===null)continue;
      if(entry.key==="memo"){
        if(value)memoParts.push(value);
        consumed.add(index);recognized.push("메모");
        return;
      }
      const parsed=parseLabeledValue(entry.key,value);
      if(parsed!==undefined){(patch as Record<string,unknown>)[entry.key]=parsed;consumed.add(index);recognized.push(entry.label);}
      return;
    }
  });

  if(!patch.phone){
    for(let i=0;i<lines.length;i++){
      const p=hasPhone(lines[i]);if(!p)continue;
      patch.phone=formatPhone(p);consumed.add(i);recognized.push("연락처");break;
    }
  }
  if(!patch.birthNumber){
    for(let i=0;i<lines.length;i++){
      const b=hasBirth(lines[i]);if(!b)continue;
      patch.birthNumber=formatBirthNumber(b);consumed.add(i);recognized.push("주민번호");break;
    }
  }
  if(!patch.name){
    for(let i=0;i<Math.min(lines.length,4);i++){
      if(consumed.has(i))continue;
      const v=lines[i].replace(/^(?:성명|이름|고객명)\s*[:：-]?\s*/,"").trim();
      if(isNameCandidate(v)){patch.name=v;consumed.add(i);recognized.push("고객명(추정)");break;}
    }
  }
  if(!patch.lenderCount){
    for(let i=0;i<lines.length;i++){
      const m=lines[i].match(/(?:업체|대부업체|사채업체)\s*(\d+)\s*(?:개|곳|건)?/);
      if(m){patch.lenderCount=Number(m[1]);consumed.add(i);recognized.push("업체수(추정)");break;}
    }
  }
  if(!patch.installmentMonths){
    for(let i=0;i<lines.length;i++){
      const m=lines[i].match(/(?:분납\s*)?(\d+)\s*(?:개월|달)/);
      if(m){patch.installmentMonths=Number(m[1]);consumed.add(i);recognized.push("분납기간(추정)");break;}
    }
  }
  if(!patch.lenderUnitPrice){
    for(let i=0;i<lines.length;i++){
      const m=lines[i].match(/업체당\s*(?:단가|계약금액|수임료)?\s*[:：-]?\s*([\d,.]+\s*(?:억|만|천)?\s*원?)/);
      if(!m)continue;
      const n=parseKoreanAmount(m[1]);if(n>0){patch.lenderUnitPrice=n;consumed.add(i);recognized.push("업체당 단가(추정)");break;}
    }
  }
  if(!patch.contractAmount && patch.lenderUnitPrice && patch.lenderCount){
    patch.contractAmount=patch.lenderUnitPrice*patch.lenderCount;
    inferred.push("계약금액 = 업체당 단가 × 업체수");
  }else if(!patch.lenderUnitPrice && patch.contractAmount && patch.lenderCount && patch.contractAmount%patch.lenderCount===0){
    patch.lenderUnitPrice=patch.contractAmount/patch.lenderCount;
    inferred.push("업체당 단가 = 계약금액 ÷ 업체수");
  }

  const leftovers=lines.filter((_,i)=>!consumed.has(i));
  // 라벨 없이 적힌 상담내용은 메모에 남겨 정보 유실을 줄인다. 이름 후보나 짧은 제목성 문장은 제외한다.
  unparsed.push(...leftovers.filter(v=>v.length>2&&!isNameCandidate(v)));
  if(unparsed.length)memoParts=memoParts.concat(unparsed);
  if(memoParts.length)patch.memo=[...new Set(memoParts)].join("\n");

  return{patch,recognized:[...new Set(recognized)],inferred,unparsed};
}
