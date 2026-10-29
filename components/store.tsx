"use client";
import React,{createContext,useCallback,useContext,useEffect,useMemo,useRef,useState} from "react";
import {createRetryableSave} from "@/lib/supabase/retryable-save";
import {createClient} from "@/lib/supabase/client";
import {createRefreshQueue,createTableLoader,reuseUnchangedRows,groupBy} from "@/lib/supabase/refresh-queue";
import {fetchAllRows} from "@/lib/supabase/fetch-all";
import type {PromiseState} from "@/lib/schedule-ledger";
import {paymentCarryAmount} from "@/lib/payment-metrics";
import {buildSalaryInstallmentPlan} from "@/lib/installment-plan";
import type {SettlementCancellationExpected} from "@/lib/settlement-cancellation";

export type Manager=string;
export type PaymentStatus="예정"|"완료"|"연체"|"미납"|"환불";
export type RepaymentStatus="예정"|"상환완료"|"연체"|"보류"|"추심"|"종결";
export type ContactType=""|"번호"|"텔레그램"|"카카오톡"|"라인";
export type Customer={id:string;createdAt:string;createdTime?:string;name:string;phone:string;address:string;birthNumber:string;manager:Manager;coordinationManager:Manager;memo:string;contractDate:string;contractAmount:number;baseContractAmount?:number;prepaidAmount:number;basePrepaidAmount?:number;installmentMonths:number;lenderUnitPrice:number;lenderCount:number;baseLenderCount?:number;monthlyNetSalary?:number;salaryDay?:number;autoCreateInstallments?:boolean;isAccident:boolean;legacyImported?:boolean;isAccidentRisk?:boolean;accidentRiskMarkedAt?:string;accidentContractAmount?:number;accidentMarkedAt?:string;eformsignDocumentId?:string;eformsignStatus?:string;eformsignUpdatedAt?:string;recoveryCredit?:number;hideMissingRepayment?:boolean};
export type Payment={dateChangeCount?:number;promiseState?:PromiseState;rowVersion?:number;obligationAmount?:number;allocatedAmount?:number;id:string;customerId:string;createdTime?:string;dueDate:string;dueAmount:number;paidDate:string;paidAmount:number;status:PaymentStatus;memo:string;paymentMethod?:string;settlementMemo?:string;scheduleType?:"일반"|"재약정"|"추가계약"|"환수";rootScheduleId?:string;rescheduledFromId?:string;rescheduleSequence?:number;sourceAdditionalContractId?:string;sourceRecoveryId?:string};
export type Repayment={dateChangeCount?:number;promiseState?:PromiseState;rowVersion?:number;obligationAmount?:number;rootObligationAmount?:number;id:string;customerId:string;createdTime?:string;lenderName:string;contactType:ContactType;contactValue:string;dueDate:string;amount:number;account:string;status:RepaymentStatus;memo:string;paidAmount?:number;paidDate?:string;rescheduledFromId?:string;rootScheduleId?:string;rescheduleSequence?:number};
export type LenderContact={id:string;type:ContactType;value:string};
export type Lender={id:string;createdAt:string;createdTime?:string;name:string;contacts:LenderContact[];account:string;memo:string;customerIds:string[]};
export type Attachment={id:string;name:string;size:number;type:string;storagePath:string};
export type BoardPost={id:string;createdTime?:string;title:string;body:string;writer:string;date:string;isNotice:boolean;noticeOrder:number;attachments:Attachment[]};
export type Settlement={id:string;createdTime?:string;paidDate:string;clientName:string;amount:number;paymentMethod:string;memo:string;customerId?:string;sourcePaymentScheduleId?:string;sourceRecoveryId?:string;recoveryComponent?:string;entrySource?:"manual"|"payment"|"refund"|"recovery";entryType?:"계약"|"환수"|"기타"|"반환"|"환수 성공보수"|"환수 분납금"|"의뢰인 환수 반환금"};
export type MetaLeadRecord={newDbAlertEnabled?:boolean;id:string;createdAt:string;name:string;phone:string;manager:Manager;coordinationManager:Manager;lenderCount:number;memo:string;leadResult:string;leadStage:string;status:"신규"|"고객등록완료";customerId:string|null};
export type AdditionalContract={id:string;customerId:string;createdTime?:string;contractDate:string;contractAmount:number;prepaidAmount:number;installmentMonths:number;lenderUnitPrice:number;lenderCount:number;isRenegotiation:boolean;memo:string};
export type Recovery={successFeeAmount?:number;installmentAmount?:number;clientReturnAmount?:number;accountingVersion?:number;rowVersion?:number;depositorName?:string;id:string;customerId:string;createdTime?:string;recoveryDate:string;lenderName:string;recoveryType:string;amount:number;paymentMethod:string;memo:string};
export type CustomerAdditionalContractRow=Omit<AdditionalContract,"id"|"customerId">&{id?:string};
export type RecoveryAllocation={id:string;recoveryId:string;customerId:string;paymentId:string;amount:number};
export type RecoverySplit={recoveryId:string;customerId:string;successFee:number;appliedFee:number;refundDue:number};
export type RecoveryRefund={settlementHidden?:boolean;id:string;recoveryId:string;customerId:string;refundDate:string;amount:number;recipientName:string;paymentMethod:string;memo:string};
export type CustomerRecoveryRow=Omit<Recovery,"id"|"customerId">&{id?:string};
export type CustomerPaymentRow=Omit<Payment,"id"|"customerId">&{id?:string};
export type CustomerRepaymentRow=Omit<Repayment,"id"|"customerId">&{id?:string};

type Store={
 loading:boolean;error:string|null;
 customers:Customer[];payments:Payment[];repayments:Repayment[];lenders:Lender[];posts:BoardPost[];settlements:Settlement[];metaLeads:MetaLeadRecord[];additionalContracts:AdditionalContract[];recoveries:Recovery[];recoveryAllocations:RecoveryAllocation[];recoverySplits:RecoverySplit[];recoveryRefunds:RecoveryRefund[];recordRecoveryRefund:(recoveryId:string,refundDate:string,amount:number,recipientName:string,paymentMethod:string,memo:string,requestKey:string)=>Promise<void>;applyRecoverySplit:(recoveryId:string,successFee:number,allocations:Array<{paymentId:string;amount:number}>)=>Promise<void>;
 refresh:()=>Promise<void>;
 hideMissingRepayment:(customerId:string)=>Promise<void>;
 addCustomer:(v:Omit<Customer,"id">)=>void;updateCustomer:(id:string,p:Partial<Customer>)=>void;deleteCustomer:(id:string)=>void;
 addPayment:(v:Omit<Payment,"id">)=>Promise<void>;addPayments:(rows:Omit<Payment,"id">[])=>Promise<void>;updatePayment:(id:string,p:Partial<Payment>)=>Promise<void>;deletePayment:(id:string)=>Promise<void>;cancelCompletedPayment:(id:string,expectedVersion:number)=>Promise<void>;setCustomerPayments:(customerId:string,rows:CustomerPaymentRow[])=>Promise<void>;createRescheduledPayment:(fromId:string,v:{dueDate:string;dueAmount:number;memo:string})=>Promise<void>;savePaymentWithCarry:(id:string,p:Partial<Payment>,carry:{dueDate:string;dueAmount?:number;memo:string})=>Promise<void>;saveCustomerPaymentsAtomic:(customerId:string,rows:CustomerPaymentRow[],carries:Record<string,Array<{dueDate:string;dueAmount:number;memo:string}>>,deletedIds:string[],versions?:Record<string,number>)=>Promise<void>;
 addRepayment:(v:Omit<Repayment,"id">)=>Promise<void>;updateRepayment:(id:string,p:Partial<Repayment>)=>Promise<void>;deleteRepayment:(id:string)=>Promise<void>;cancelCompletedRepayment:(id:string,expectedVersion:number)=>Promise<void>;setCustomerRepayments:(customerId:string,rows:CustomerRepaymentRow[])=>Promise<void>;createRescheduledRepayment:(fromId:string,v:{dueDate:string;amount:number;memo:string})=>Promise<void>;saveCustomerRepaymentsAtomic:(customerId:string,rows:CustomerRepaymentRow[],carries:Record<string,{dueDate:string;amount:number;memo:string}[]>,deletedIds:string[],versions?:Record<string,number>)=>Promise<void>;
 setCustomerAdditionalContracts:(customerId:string,rows:CustomerAdditionalContractRow[])=>Promise<void>;setCustomerRecoveries:(customerId:string,rows:CustomerRecoveryRow[],versions?:Record<string,number>)=>Promise<void>;
 addLender:(v:Omit<Lender,"id">)=>void;updateLender:(id:string,p:Partial<Lender>)=>void;deleteLender:(id:string)=>void;
 addPost:(v:Omit<BoardPost,"id">)=>void;updatePost:(id:string,p:Partial<BoardPost>)=>void;deletePost:(id:string)=>void;
 addSettlement:(v:Omit<Settlement,"id">,requestId?:string)=>Promise<void>;updateSettlement:(id:string,p:Partial<Settlement>)=>Promise<void>;deleteSettlement:(id:string,expected:SettlementCancellationExpected,requestKey:string)=>Promise<void>;resetSample:()=>void;
};

const supabase=createClient();
const Ctx=createContext<Store|null>(null);
const n=(v:unknown)=>Number(v||0);
const date=(v:unknown)=>String(v||"").slice(0,10);
const fail=(message:string)=>{console.error(message);if(typeof window!=="undefined")alert(message)};

export function AdminStoreProvider({children}:{children:React.ReactNode}){
 const persistBatch=useMemo(()=>createRetryableSave((name,args)=>supabase.rpc(name,args)),[]);
 const [customers,setCustomers]=useState<Customer[]>([]);const [payments,setPayments]=useState<Payment[]>([]);const [repayments,setRepayments]=useState<Repayment[]>([]);const [lenders,setLenders]=useState<Lender[]>([]);const [posts,setPosts]=useState<BoardPost[]>([]);const [settlements,setSettlements]=useState<Settlement[]>([]);const [metaLeads,setMetaLeads]=useState<MetaLeadRecord[]>([]);const [additionalContracts,setAdditionalContracts]=useState<AdditionalContract[]>([]);const [recoveries,setRecoveries]=useState<Recovery[]>([]);const [recoveryAllocations,setRecoveryAllocations]=useState<RecoveryAllocation[]>([]);const [recoverySplits,setRecoverySplits]=useState<RecoverySplit[]>([]);const [recoveryRefunds,setRecoveryRefunds]=useState<RecoveryRefund[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState<string|null>(null);const initializedRef=useRef(false);const [initialized,setInitialized]=useState(false);

 const saveBatch=useCallback((kind:string,args:Record<string,unknown>)=>{
  if(kind!=="payment"&&kind!=="repayment")return persistBatch(kind,args);
  const source=kind==="payment"?payments:repayments;
  const versions:Record<string,number>=Object.fromEntries(source.filter(row=>row.customerId===args.p_customer_id).map(row=>[row.id,row.rowVersion||1]));
  // Draft versions win over realtime snapshots, protecting concurrent receipts.
  for(const row of (args.p_rows||[]) as Array<{id?:string;rowVersion?:number}>){if(row.id&&row.rowVersion!==undefined)versions[row.id]=row.rowVersion}
  return persistBatch(kind,args,{...args,p_versions:args.p_versions??versions});
 },[persistBatch,payments,repayments]);
 const loadTable=useMemo(()=>createTableLoader(),[]);
 const loadSnapshot=useCallback(async(tables:ReadonlySet<string>|null)=>{
  if(!initializedRef.current)setLoading(true);setError(null);
  const [cu,pa,re,le,lc,lcu,po,at,se,me,ac,rv,al,sp,refundResult]=await Promise.all([
   loadTable("customers",!tables||tables.has("customers"),()=>fetchAllRows((firstPage)=>supabase.from("customers").select("id,registered_at,admin_created_at,name,phone,address,birth_number,sales_manager,manager,coordination_manager,memo,contract_date,contract_amount,upfront_amount,installment_period,lender_unit_price,lender_count,monthly_net_salary,salary_day,is_accident,is_accident_risk,accident_risk_marked_at,accident_contract_amount,accident_marked_at,eformsign_document_id,eformsign_status,eformsign_updated_at,legacy_imported,hide_missing_repayment",firstPage?{count:"exact"}:{}).is("deleted_at",null).order("admin_created_at",{ascending:false}).order("id",{ascending:false}))),
   loadTable("payment_schedules",!tables||tables.has("payment_schedules"),()=>fetchAllRows((firstPage)=>supabase.from("payment_schedules").select("id,customer_id,admin_created_at,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,schedule_type,root_schedule_id,rescheduled_from_id,reschedule_sequence,source_additional_contract_id,source_recovery_id,promise_state,row_version,obligation_amount,date_change_count",firstPage?{count:"exact"}:{}).is("deleted_at",null).order("due_date",{ascending:false}).order("admin_created_at",{ascending:false}).order("id",{ascending:false}))),
   loadTable("repayment_schedules",!tables||tables.has("repayment_schedules"),()=>fetchAllRows((firstPage)=>supabase.from("dowon_repayment_promises").select("id,customer_id,admin_created_at,lender_name,lender_contact_type,lender_contact_value,repayment_date,repayment_amount,account_info,status,memo,paid_amount,paid_date,rescheduled_from_id,root_schedule_id,reschedule_sequence,promise_state,row_version,obligation_amount,root_obligation_amount,date_change_count",firstPage?{count:"exact"}:{}).is("deleted_at",null).order("repayment_date",{ascending:false}).order("admin_created_at",{ascending:false}).order("id",{ascending:false}))),
   loadTable("lenders",!tables||tables.has("lenders"),()=>fetchAllRows((firstPage)=>supabase.from("lenders").select("id,created_at,admin_created_at,name,account_info,memo",firstPage?{count:"exact"}:{}).is("deleted_at",null).order("admin_created_at",{ascending:false}).order("id",{ascending:false}))),
   loadTable("lender_contacts",!tables||tables.has("lender_contacts"),()=>fetchAllRows((firstPage)=>supabase.from("lender_contacts").select("id,lender_id,contact_type,contact_value,sort_order",firstPage?{count:"exact"}:{}).order("sort_order",{ascending:true}).order("id"))),
   loadTable("lender_customers",!tables||tables.has("lender_customers"),()=>fetchAllRows((firstPage)=>supabase.from("lender_customers").select("lender_id,customer_id",firstPage?{count:"exact"}:{}).order("lender_id").order("customer_id"))),
   loadTable("board_posts",!tables||tables.has("board_posts"),()=>fetchAllRows((firstPage)=>supabase.from("board_posts").select("id,admin_created_at,post_date,title,body,author,is_notice,notice_order",firstPage?{count:"exact"}:{}).is("deleted_at",null).order("admin_created_at",{ascending:false}).order("id",{ascending:false}))),
   loadTable("board_attachments",!tables||tables.has("board_attachments"),()=>fetchAllRows((firstPage)=>supabase.from("board_attachments").select("id,post_id,file_name,file_size,mime_type,storage_path,created_at",firstPage?{count:"exact"}:{}).order("created_at",{ascending:true}).order("id"))),
   loadTable("settlement_entries",!tables||tables.has("settlement_entries"),()=>fetchAllRows((firstPage)=>supabase.from("settlement_entries").select("id,admin_created_at,payment_date,client_name,amount,payment_method,memo,customer_id,source_payment_schedule_id,source_recovery_id,recovery_component,entry_source,entry_type",firstPage?{count:"exact"}:{}).is("deleted_at",null).order("payment_date",{ascending:false}).order("admin_created_at",{ascending:false}).order("id",{ascending:false}))),
   loadTable("meta_leads",!tables||tables.has("meta_leads"),()=>fetchAllRows((firstPage)=>supabase.from("meta_leads").select("id,created_at,customer_name,phone_number,sales_manager,manager,coordination_manager,lender_count,memo,lead_result,lead_stage,status,customer_id,new_db_alert_enabled",firstPage?{count:"exact"}:{}).order("created_at",{ascending:false}).order("id",{ascending:false}))),
   loadTable("additional_contracts",!tables||tables.has("additional_contracts"),()=>fetchAllRows((firstPage)=>supabase.from("additional_contracts").select("id,customer_id,admin_created_at,contract_date,contract_amount,upfront_amount,installment_period,lender_unit_price,lender_count,is_renegotiation,memo",firstPage?{count:"exact"}:{}).is("deleted_at",null).order("admin_created_at",{ascending:false}).order("id",{ascending:false}))),
   loadTable("recoveries",!tables||tables.has("recoveries"),()=>fetchAllRows((firstPage)=>supabase.from("recoveries").select("id,customer_id,admin_created_at,recovery_date,lender_name,recovery_type,amount,payment_method,memo,depositor_name,success_fee_amount,installment_amount,client_return_amount,accounting_version,row_version",firstPage?{count:"exact"}:{}).is("deleted_at",null).order("recovery_date",{ascending:false}).order("admin_created_at",{ascending:false}).order("id",{ascending:false}))),
   // The active allocation view also changes when its recovery is converted or deleted.
   loadTable("recovery_fee_allocations",!tables||tables.has("recovery_fee_allocations")||tables.has("recoveries"),()=>fetchAllRows((firstPage)=>supabase.from("dowon_active_recovery_allocations").select("id,recovery_id,customer_id,payment_schedule_id,amount",firstPage?{count:"exact"}:{}).order("id"))),
   loadTable("recovery_fee_splits",!tables||tables.has("recovery_fee_splits"),()=>fetchAllRows((firstPage)=>supabase.from("recovery_fee_splits").select("recovery_id,customer_id,success_fee,applied_fee,refund_due",firstPage?{count:"exact"}:{}).order("recovery_id"))),
   loadTable("recovery_refunds",!tables||tables.has("recovery_refunds"),()=>fetchAllRows((firstPage)=>supabase.from("recovery_refunds").select("id,recovery_id,customer_id,refund_date,amount,recipient_name,payment_method,memo,settlement_hidden",firstPage?{count:"exact"}:{}).is("cancelled_at",null).order("id"))),
  ]);
  const firstError=[cu,pa,re,le,lc,lcu,po,at,se,me,ac,rv,al,sp,refundResult].find(x=>x.error)?.error;
  if(firstError){setError(firstError.message);setLoading(false);return}
  const additionalRows:AdditionalContract[]=(ac.data||[]).map((x:any)=>({id:x.id,customerId:x.customer_id,createdTime:x.admin_created_at||"",contractDate:date(x.contract_date),contractAmount:n(x.contract_amount),prepaidAmount:n(x.upfront_amount),installmentMonths:n(x.installment_period),lenderUnitPrice:n(x.lender_unit_price),lenderCount:n(x.lender_count),isRenegotiation:!!x.is_renegotiation,memo:x.memo||""}));
  const recoveryRows:Recovery[]=(rv.data||[]).map((x:any)=>({id:x.id,customerId:x.customer_id,createdTime:x.admin_created_at||"",recoveryDate:date(x.recovery_date),lenderName:x.lender_name||"",recoveryType:x.recovery_type||"",amount:n(x.amount),paymentMethod:x.payment_method||"계좌이체",memo:x.memo||"",depositorName:x.depositor_name||"",accountingVersion:n(x.accounting_version)||1,rowVersion:n(x.row_version)||1,successFeeAmount:x.success_fee_amount==null?undefined:n(x.success_fee_amount),installmentAmount:x.installment_amount==null?undefined:n(x.installment_amount),clientReturnAmount:x.client_return_amount==null?undefined:n(x.client_return_amount)}));
  const extrasByCustomer=groupBy(additionalRows,a=>a.customerId);
  const recoveryCreditsByCustomer=new Map<string,number>();
  for(const row of recoveryRows)if(row.accountingVersion===2)recoveryCreditsByCustomer.set(row.customerId,(recoveryCreditsByCustomer.get(row.customerId)||0)+(row.installmentAmount||0));
  setAdditionalContracts(previous=>reuseUnchangedRows(previous,additionalRows));setRecoveries(previous=>reuseUnchangedRows(previous,recoveryRows));
  setRecoveryAllocations(previous=>reuseUnchangedRows(previous,(al.data||[]).map((x:any)=>({id:x.id,recoveryId:x.recovery_id,customerId:x.customer_id,paymentId:x.payment_schedule_id,amount:n(x.amount)}))));
  setRecoverySplits(previous=>reuseUnchangedRows(previous,(sp.data||[]).map((x:any)=>({recoveryId:x.recovery_id,customerId:x.customer_id,successFee:n(x.success_fee),appliedFee:n(x.applied_fee),refundDue:n(x.refund_due)}))));
  setRecoveryRefunds(previous=>reuseUnchangedRows(previous,(refundResult.data||[]).map((x:any)=>({id:x.id,recoveryId:x.recovery_id,customerId:x.customer_id,refundDate:date(x.refund_date),settlementHidden:!!x.settlement_hidden,amount:n(x.amount),recipientName:x.recipient_name||"",paymentMethod:x.payment_method||"계좌이체",memo:x.memo||""}))));
  setCustomers(previous=>reuseUnchangedRows(previous,(cu.data||[]).map((x:any)=>{const extras=extrasByCustomer.get(x.id)||[];const extraContract=extras.reduce((sum,a)=>sum+a.contractAmount,0);const extraPrepaid=extras.reduce((sum,a)=>sum+a.prepaidAmount,0);const extraLenders=extras.filter(a=>!a.isRenegotiation).reduce((sum,a)=>sum+a.lenderCount,0);const baseContract=n(x.contract_amount),basePrepaid=n(x.upfront_amount),baseLenders=n(x.lender_count);const isAccident=!!x.is_accident;const accidentContractAmount=x.accident_contract_amount===null||x.accident_contract_amount===undefined?undefined:n(x.accident_contract_amount);return{id:x.id,createdAt:date(x.registered_at),createdTime:x.admin_created_at||x.registered_at||"",name:x.name||"",phone:x.phone||"",address:x.address||"",birthNumber:x.birth_number||"",manager:(x.sales_manager||x.manager||"신홍규") as Manager,coordinationManager:(x.coordination_manager||"신홍규") as Manager,memo:x.memo||"",contractDate:date(x.contract_date),contractAmount:isAccident?(accidentContractAmount??0):baseContract+extraContract,baseContractAmount:baseContract,recoveryCredit:recoveryCreditsByCustomer.get(x.id)||0,prepaidAmount:basePrepaid+extraPrepaid,basePrepaidAmount:basePrepaid,installmentMonths:n(x.installment_period),lenderUnitPrice:n(x.lender_unit_price),lenderCount:baseLenders+extraLenders,baseLenderCount:baseLenders,monthlyNetSalary:n(x.monthly_net_salary),salaryDay:n(x.salary_day),autoCreateInstallments:false,isAccident,isAccidentRisk:!!x.is_accident_risk,accidentRiskMarkedAt:x.accident_risk_marked_at||"",accidentContractAmount,accidentMarkedAt:x.accident_marked_at||"",eformsignDocumentId:x.eformsign_document_id||"",eformsignStatus:x.eformsign_status||"",eformsignUpdatedAt:x.eformsign_updated_at||"",legacyImported:!!x.legacy_imported,hideMissingRepayment:!!x.hide_missing_repayment}})));
  const allocatedByPayment=new Map<string,number>();
  for(const a of al.data||[])allocatedByPayment.set(a.payment_schedule_id,(allocatedByPayment.get(a.payment_schedule_id)||0)+n(a.amount));
  setPayments(previous=>reuseUnchangedRows(previous,(pa.data||[]).map((x:any)=>({id:x.id,customerId:x.customer_id,createdTime:x.admin_created_at||"",promiseState:x.promise_state||undefined,dateChangeCount:n(x.date_change_count),rowVersion:n(x.row_version)||1,obligationAmount:x.obligation_amount==null?undefined:n(x.obligation_amount),dueDate:date(x.due_date),dueAmount:n(x.expected_amount),allocatedAmount:allocatedByPayment.get(x.id)||0,paidDate:date(x.paid_date),paidAmount:n(x.paid_amount),status:(x.status||"예정") as PaymentStatus,memo:x.memo||"",paymentMethod:x.payment_method||"계좌이체",settlementMemo:"",scheduleType:(x.schedule_type||"일반") as "일반"|"재약정"|"추가계약"|"환수",rootScheduleId:x.root_schedule_id||x.id,rescheduledFromId:x.rescheduled_from_id||"",rescheduleSequence:n(x.reschedule_sequence),sourceAdditionalContractId:x.source_additional_contract_id||"",sourceRecoveryId:x.source_recovery_id||""}))));
  setRepayments(previous=>reuseUnchangedRows(previous,(re.data||[]).map((x:any)=>({id:x.id,customerId:x.customer_id,createdTime:x.admin_created_at||"",promiseState:x.promise_state||undefined,dateChangeCount:n(x.date_change_count),rowVersion:n(x.row_version)||1,obligationAmount:x.obligation_amount==null?undefined:n(x.obligation_amount),rootObligationAmount:x.root_obligation_amount==null?undefined:n(x.root_obligation_amount),lenderName:x.lender_name||"",contactType:(x.lender_contact_type||"") as ContactType,contactValue:x.lender_contact_value||"",dueDate:date(x.repayment_date),amount:n(x.repayment_amount),account:x.account_info||"",status:(x.status==="완료"?"상환완료":(x.status||"예정")) as RepaymentStatus,memo:x.memo||"",paidAmount:n(x.paid_amount),paidDate:date(x.paid_date),rescheduledFromId:x.rescheduled_from_id||"",rootScheduleId:x.root_schedule_id||x.id,rescheduleSequence:n(x.reschedule_sequence)}))));
  const contactRows=(lc.data||[]) as any[];
  const lenderCustomerRows=(lcu.data||[]) as any[];
  const contactsByLender=groupBy(contactRows,c=>c.lender_id);
  const customersByLender=groupBy(lenderCustomerRows,r=>r.lender_id);
  setLenders(previous=>reuseUnchangedRows(previous,(le.data||[]).map((x:any)=>({id:x.id,createdAt:date(x.created_at),createdTime:x.admin_created_at||x.created_at||"",name:x.name||"",account:x.account_info||"",memo:x.memo||"",contacts:(contactsByLender.get(x.id)||[]).map(c=>({id:c.id,type:c.contact_type as ContactType,value:c.contact_value||""})),customerIds:(customersByLender.get(x.id)||[]).map(r=>r.customer_id)}))));
  const attachmentRows=(at.data||[]) as any[];
  const attachmentsByPost=groupBy(attachmentRows,a=>a.post_id);
  setPosts(previous=>reuseUnchangedRows(previous,(po.data||[]).map((x:any)=>({id:x.id,createdTime:x.admin_created_at||x.post_date||"",title:x.title||"",body:x.body||"",writer:x.author||"",date:date(x.post_date),isNotice:!!x.is_notice,noticeOrder:n(x.notice_order),attachments:(attachmentsByPost.get(x.id)||[]).map(a=>({id:a.id,name:a.file_name,size:n(a.file_size),type:a.mime_type||"",storagePath:a.storage_path||""}))}))));
  setSettlements(previous=>reuseUnchangedRows(previous,(se.data||[]).map((x:any)=>({id:x.id,createdTime:x.admin_created_at||"",paidDate:date(x.payment_date),clientName:x.client_name||"",amount:n(x.amount),paymentMethod:x.payment_method||"계좌이체",memo:x.memo||"",customerId:x.customer_id||"",sourcePaymentScheduleId:x.source_payment_schedule_id||"",sourceRecoveryId:x.source_recovery_id||"",recoveryComponent:x.recovery_component||"",entrySource:(x.entry_source||"manual") as Settlement["entrySource"],entryType:(x.entry_type||"계약") as Settlement["entryType"]}))));
  setMetaLeads(previous=>reuseUnchangedRows(previous,(me.data||[]).map((x:any)=>({id:x.id,createdAt:x.created_at||"",name:x.customer_name||"",phone:x.phone_number||"",manager:(x.sales_manager||x.manager||"신홍규") as Manager,coordinationManager:(x.coordination_manager||"신홍규") as Manager,lenderCount:n(x.lender_count),memo:x.memo||"",newDbAlertEnabled:x.new_db_alert_enabled===true,leadResult:x.lead_result==="미분류"?"신규DB":x.lead_result||"신규DB",leadStage:x.lead_stage||"신규",status:x.status==="고객등록완료"?"고객등록완료":"신규",customerId:x.customer_id||null}))));
  initializedRef.current=true;setInitialized(true);
  setLoading(false);
 },[loadTable]);
 const refreshQueue=useRef<ReturnType<typeof createRefreshQueue>|null>(null);
 const refresh=useCallback((tables?:readonly string[])=>{
  refreshQueue.current??=createRefreshQueue(loadSnapshot);
  return refreshQueue.current(tables);
 },[loadSnapshot]);
 useEffect(()=>{void refresh()},[refresh]);
 useEffect(()=>{
  const realtimeTables=["customers","payment_schedules","repayment_schedules","lenders","lender_contacts","lender_customers","board_posts","board_attachments","settlement_entries","meta_leads","lead_call_logs","additional_contracts","recoveries","recovery_fee_allocations","recovery_fee_splits","recovery_refunds","change_history"];
  const storeTables=new Set(["customers","payment_schedules","repayment_schedules","lenders","lender_contacts","lender_customers","board_posts","board_attachments","settlement_entries","meta_leads","additional_contracts","recoveries","recovery_fee_allocations","recovery_fee_splits","recovery_refunds"]);
  let timer:ReturnType<typeof setTimeout>|null=null;
  let pendingAutoRefresh=false;
  let pendingFullRefresh=false;
  const dirtyTables=new Set<string>();
  const isEditing=()=>{
   if(typeof document==="undefined")return false;
   if(document.querySelector('[data-admin-edit-lock="true"]'))return true;
   const active=document.activeElement as HTMLElement|null;
   return !!active&&(active.tagName==="INPUT"||active.tagName==="TEXTAREA"||active.tagName==="SELECT"||active.isContentEditable);
  };
  const runAutoRefresh=(full=false)=>{
   pendingFullRefresh ||= full;
   if(document.visibilityState==="hidden"||isEditing()){pendingAutoRefresh=true;return}
   pendingAutoRefresh=false;
   const tables=pendingFullRefresh?undefined:[...dirtyTables];
   pendingFullRefresh=false;dirtyTables.clear();
   if(tables===undefined||tables.length)void refresh(tables);
  };
  const flushPending=()=>{if(pendingAutoRefresh){if(timer)clearTimeout(timer);timer=setTimeout(()=>runAutoRefresh(),0)}};
  const onVisible=()=>{if(document.visibilityState==="visible")runAutoRefresh(true)};
  const handleChange=(payload:any)=>{
   const table=String(payload?.table||"");
   window.dispatchEvent(new CustomEvent("admin:data-changed",{detail:{table,eventType:String(payload?.eventType||"")}}));
   if(storeTables.has(table)){dirtyTables.add(table);if(timer)clearTimeout(timer);timer=setTimeout(()=>runAutoRefresh(),250)}
  };
  let channel=supabase.channel("admin-live-v23");
  for(const table of realtimeTables)channel=channel.on("postgres_changes",{event:"*",schema:"public",table},handleChange);
  channel.subscribe();
  const fallback=window.setInterval(()=>runAutoRefresh(true),30000);
  window.addEventListener("admin:edit-lock-changed",flushPending);
  document.addEventListener("focusout",flushPending,true);
  document.addEventListener("visibilitychange",onVisible);
  return()=>{if(timer)clearTimeout(timer);window.clearInterval(fallback);document.removeEventListener("visibilitychange",onVisible);window.removeEventListener("admin:edit-lock-changed",flushPending);document.removeEventListener("focusout",flushPending,true);void supabase.removeChannel(channel)};
 },[refresh]);

 async function syncLendersFromRepayments(rows:Array<{customerId:string;lenderName:string;contactType:ContactType;contactValue:string;account:string}>) {
  // 상환일정에서 업체 연락처를 나중에 보완해도 기존 업체에 연락정보만 추가되도록 동기화합니다.
  // 1순위: 업체명+연락수단+연락정보 정확히 일치, 2순위: 같은 의뢰인에 이미 연결된 같은 업체명.
  const normName=(value:string)=>String(value||"").trim().replace(/\s+/g," ").toLowerCase();
  const normContact=(value:string)=>String(value||"").replace(/\s+/g,"").toLowerCase();
  const keyOf=(name:string,type:ContactType,value:string)=>`${normName(name)}\u0000${type}\u0000${normContact(value)}`;
  const exactContact=new Map<string,string>();
  for(const lender of lenders){
   for(const contact of lender.contacts){
    if(normContact(contact.value))exactContact.set(keyOf(lender.name,contact.type,contact.value),lender.id);
   }
  }
  for(const row of rows){
   const name=String(row.lenderName||"").trim();
   const value=String(row.contactValue||"").trim();
   const type=row.contactType;
   const account=String(row.account||"").trim();
   if(!name&&!value&&!account)continue;

   let lender=lenders.find(l=>value&&exactContact.get(keyOf(name,type,value))===l.id);
   if(!lender&&row.customerId){
    const candidates=lenders.filter(l=>normName(l.name)===normName(name)&&(l.customerIds||[]).includes(row.customerId));
    lender=candidates.find(l=>account&&String(l.account||"").trim()===account)||candidates.find(l=>l.contacts.every(c=>!normContact(c.value)))||candidates[0];
   }

   if(lender){
    if(account&&String(lender.account||"").trim()!==account){
     const up=await supabase.from("lenders").update({account_info:account}).eq("id",lender.id);
     if(up.error)fail(up.error.message);
    }
    if(type&&value&&!lender.contacts.some(c=>c.type===type&&normContact(c.value)===normContact(value))){
     const nextOrder=lender.contacts.length?Math.max(...lender.contacts.map((_,i)=>i))+1:0;
     const ins=await supabase.from("lender_contacts").insert({lender_id:lender.id,contact_type:type,contact_value:value,sort_order:nextOrder});
     if(ins.error)fail(ins.error.message);else exactContact.set(keyOf(name,type,value),lender.id);
    }
    if(row.customerId){
     const link=await supabase.from("lender_customers").upsert({lender_id:lender.id,customer_id:row.customerId},{onConflict:"lender_id,customer_id",ignoreDuplicates:true});
     if(link.error)fail(link.error.message);
    }
    continue;
   }

   const created=await supabase.from("lenders").insert({name,account_info:account||null,memo:"상환 일정에서 자동 등록",created_at:todayIso()}).select("id").single();
   if(created.error){fail(created.error.message);continue}
   if(type&&value){
    const ins=await supabase.from("lender_contacts").insert({lender_id:created.data.id,contact_type:type,contact_value:value,sort_order:0});
    if(ins.error){fail(ins.error.message);continue}
    exactContact.set(keyOf(name,type,value),created.data.id);
   }
   if(row.customerId){
    const link=await supabase.from("lender_customers").upsert({lender_id:created.data.id,customer_id:row.customerId},{onConflict:"lender_id,customer_id",ignoreDuplicates:true});
    if(link.error)fail(link.error.message);
   }
  }
 }
 const todayIso=()=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());

 const value=useMemo<Store>(()=>({loading,error,customers,payments,repayments,lenders,posts,settlements,metaLeads,additionalContracts,recoveries,recoveryAllocations,recoverySplits,recoveryRefunds,
  async hideMissingRepayment(customerId){
   const {data,error}=await supabase.from("customers").update({hide_missing_repayment:true}).eq("id",customerId).is("deleted_at",null).select("id,hide_missing_repayment").single();
   if(error)throw new Error(error.message);
   if(!data||data.id!==customerId||data.hide_missing_repayment!==true)throw new Error("미표기 처리 결과를 확인하지 못했습니다. 고객 목록을 새로고침한 뒤 다시 시도해주세요.");
   await refresh(["customers"]);
   setCustomers(previous=>previous.map(customer=>customer.id===customerId?{...customer,hideMissingRepayment:true}:customer));
  },
  async recordRecoveryRefund(recoveryId,refundDate,amount,recipientName,paymentMethod,memo,requestKey){const {error}=await supabase.rpc("dowon_record_recovery_refund",{p_recovery_id:recoveryId,p_date:refundDate,p_amount:amount,p_recipient:recipientName,p_method:paymentMethod,p_memo:memo,p_request_key:requestKey});if(error)throw new Error(error.message);await refresh()},
  async applyRecoverySplit(recoveryId,successFee,allocations){const {error}=await supabase.rpc("dowon_apply_recovery_split",{p_recovery_id:recoveryId,p_success_fee:successFee,p_allocations:allocations});if(error)throw new Error(error.message);await refresh()},refresh,
  addCustomer(v){void (async()=>{const plan=v.autoCreateInstallments?buildSalaryInstallmentPlan({contractAmount:v.contractAmount,prepaidAmount:v.prepaidAmount,monthlyNetSalary:v.monthlyNetSalary||0,salaryDay:v.salaryDay||0,baseDate:v.contractDate||v.createdAt}):{remaining:0,monthlyTarget:0,months:0,rows:[],mode:"none" as const};const installmentMonths=plan.rows.length?plan.months:(v.installmentMonths||0);const {data,error}=await supabase.from("customers").insert({registered_at:v.createdAt,name:v.name,phone:v.phone,address:v.address||null,birth_number:v.birthNumber||null,manager:v.manager,sales_manager:v.manager,coordination_manager:v.coordinationManager,memo:v.memo,contract_date:v.contractDate||null,contract_amount:v.contractAmount,upfront_amount:v.prepaidAmount,installment_period:installmentMonths,lender_unit_price:v.lenderUnitPrice,lender_count:v.lenderCount,monthly_net_salary:v.monthlyNetSalary||null,salary_day:v.salaryDay||null,is_accident:false,is_accident_risk:!!v.isAccidentRisk,accident_risk_marked_at:v.isAccidentRisk?new Date().toISOString():null,accident_contract_amount:null,accident_marked_at:null}).select("id").single();if(error)return fail(error.message);if(v.prepaidAmount>0){const paidDate=v.contractDate||v.createdAt;const p=await supabase.from("payment_schedules").insert({customer_id:data.id,due_date:paidDate,expected_amount:v.prepaidAmount,paid_date:paidDate,paid_amount:v.prepaidAmount,status:"완료",payment_method:"계좌이체",memo:"고객 등록 시 선납금 자동 반영"});if(p.error)return fail(p.error.message)}if(plan.rows.length){const p=await supabase.from("payment_schedules").insert(plan.rows.map((row,index)=>({customer_id:data.id,due_date:row.dueDate,expected_amount:row.amount,paid_date:null,paid_amount:0,status:"예정",payment_method:"계좌이체",schedule_type:"일반",memo:`급여일 기반 자동 분납 ${index+1}/${plan.rows.length} · 세후급여 15%`})));if(p.error)return fail(p.error.message)}await refresh()})()},
  updateCustomer(id,p){void (async()=>{const cur=customers.find(x=>x.id===id);if(!cur)return;const v={...cur,...p};const baseContractAmount=p.contractAmount!==undefined?p.contractAmount:(cur.baseContractAmount??cur.contractAmount);const basePrepaidAmount=p.prepaidAmount!==undefined?p.prepaidAmount:(cur.basePrepaidAmount??cur.prepaidAmount);const baseLenderCount=p.lenderCount!==undefined?p.lenderCount:(cur.baseLenderCount??cur.lenderCount);const nextIsAccident=!!v.isAccident;const newlyAccident=!cur.isAccident&&nextIsAccident;const accidentPaid=payments.filter(row=>row.customerId===id&&row.status!=="환불"&&row.scheduleType!=="환수").reduce((sum,row)=>sum+(row.paidAmount||0),0);const accidentContractAmount=nextIsAccident?(newlyAccident?accidentPaid:(cur.accidentContractAmount??accidentPaid)):null;const accidentMarkedAt=nextIsAccident?(newlyAccident?new Date().toISOString():(cur.accidentMarkedAt||new Date().toISOString())):null;const nextRisk=nextIsAccident?false:!!v.isAccidentRisk;const riskMarkedAt=nextRisk?(cur.isAccidentRisk?(cur.accidentRiskMarkedAt||new Date().toISOString()):new Date().toISOString()):null;const {error}=await supabase.from("customers").update({registered_at:v.createdAt,name:v.name,phone:v.phone,address:v.address||null,birth_number:v.birthNumber||null,manager:v.manager,sales_manager:v.manager,coordination_manager:v.coordinationManager,memo:v.memo,contract_date:v.contractDate||null,contract_amount:baseContractAmount,upfront_amount:basePrepaidAmount,installment_period:v.installmentMonths,lender_unit_price:v.lenderUnitPrice,lender_count:baseLenderCount,monthly_net_salary:v.monthlyNetSalary||null,salary_day:v.salaryDay||null,is_accident:nextIsAccident,legacy_imported:!!v.legacyImported,is_accident_risk:nextRisk,accident_risk_marked_at:riskMarkedAt,accident_contract_amount:accidentContractAmount,accident_marked_at:accidentMarkedAt}).eq("id",id);if(error)return fail(error.message);await refresh()})()},
  deleteCustomer(id){void (async()=>{const {error}=await supabase.from("customers").update({deleted_at:new Date().toISOString()}).eq("id",id);if(error)return fail(error.message);await refresh()})()},
  async addPayment(v){
    const {error}=await saveBatch("payment",{p_customer_id:v.customerId,p_rows:[v],p_carries:{},p_delete_ids:[]});
    if(error)throw new Error(error.message);
    await refresh();
  },
  async addPayments(rows){
    if(!rows.length)return;
    const customerId=rows[0].customerId;
    if(rows.some(row=>row.customerId!==customerId))throw new Error("한 고객의 일정만 함께 저장할 수 있습니다.");
    const {error}=await saveBatch("payment",{p_customer_id:customerId,p_rows:rows,p_carries:{},p_delete_ids:[]});
    if(error)throw new Error(error.message);
    await refresh();
  },
  async updatePayment(id,p){
    const cur=payments.find(x=>x.id===id);
    if(!cur)throw new Error("원본 납부일정을 찾지 못했습니다.");
    if(cur.scheduleType==="환수"||cur.scheduleType==="추가계약"||cur.sourceRecoveryId||cur.sourceAdditionalContractId)throw new Error("시스템 관리 납부일정은 전용 화면에서 수정해주세요.");
    const v={...cur,...p};
    if(v.customerId!==cur.customerId)throw new Error("기존 납부일정의 고객은 변경할 수 없습니다.");
    const {error}=await saveBatch("payment",{p_customer_id:cur.customerId,p_rows:[v],p_carries:{},p_delete_ids:[]});
    if(error)throw new Error(error.message);
    await refresh();
  },
  async deletePayment(id){
    const target=payments.find(p=>p.id===id);
    if(!target)throw new Error("삭제할 납부 일정을 찾지 못했습니다.");
    if(target.scheduleType==="환수"||target.scheduleType==="추가계약"||target.sourceRecoveryId||target.sourceAdditionalContractId)throw new Error(target.scheduleType==="환수"?"환수 건은 고객정보의 환수 등록에서 삭제해주세요.":"추가 계약 선납금은 고객정보의 추가 계약에서 삭제해주세요.");
    const {error}=await saveBatch("payment",{p_customer_id:target.customerId,p_rows:[],p_carries:{},p_delete_ids:[id]});
    if(error)throw new Error(error.message);
    await refresh();
  },
  async cancelCompletedPayment(id,expectedVersion){
    const target=payments.find(p=>p.id===id);
    if(!target)throw new Error("삭제할 입금 기록을 찾지 못했습니다.");
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new Error("입금 기록을 새로 불러온 뒤 삭제해주세요.");
    if(target.scheduleType==="환수"||target.scheduleType==="추가계약"||target.sourceRecoveryId||target.sourceAdditionalContractId)throw new Error(target.scheduleType==="환수"||target.sourceRecoveryId?"환수 건은 고객정보의 환수 등록에서 삭제해주세요.":"추가 계약 선납금은 고객정보의 추가 계약에서 삭제해주세요.");
    // A newer zero-cash snapshot can be the result of a committed request whose
    // response was lost. Let its old version reach the idempotent RPC retry.
    if((target.allocatedAmount||0)>0&&!(target.paidAmount>0)&&expectedVersion===(target.rowVersion||1))throw new Error("실입금 없이 환수금으로 충당된 기록입니다. 환수 등록에서 충당 내역을 수정해주세요.");
    // Cancel the cash fact and the promise together. Keep the root and lineage
    // so deleting a completed ancestor cannot erase debt or change later plans.
    const row={...target,rowVersion:expectedVersion,paidAmount:0,paidDate:"",status:"예정",promiseState:"cancelled"};
    const {error}=await saveBatch("payment",{p_customer_id:target.customerId,p_rows:[row],p_carries:{},p_delete_ids:[]});
    if(error)throw new Error(error.message);
    await refresh();
  },
  async setCustomerPayments(customerId,rows){
    const existing=payments.filter(p=>p.customerId===customerId&&p.scheduleType!=="환수"&&p.scheduleType!=="추가계약"&&!p.sourceRecoveryId&&!p.sourceAdditionalContractId);
    const keepIds=new Set(rows.flatMap(r=>r.id?[r.id]:[]));
    const {error}=await saveBatch("payment",{p_customer_id:customerId,p_rows:rows,p_carries:{},p_delete_ids:existing.filter(p=>!keepIds.has(p.id)).map(p=>p.id)});
    if(error)throw new Error(error.message);
    await refresh();
  },
  async saveCustomerPaymentsAtomic(customerId,rows,carries,deletedIds,versions){
    const {error}=await saveBatch("payment",{p_customer_id:customerId,p_rows:rows,p_carries:carries,p_delete_ids:deletedIds,p_versions:versions});
    if(error)throw new Error(`분납 원자적 저장 실패: ${error.message}`);
    await refresh();
  },
  async saveCustomerRepaymentsAtomic(customerId,rows,carries,deletedIds,versions){
    const lenderSyncRows:Array<CustomerRepaymentRow&{customerId:string}>=rows.filter(row=>{
      if(!row.id)return true;
      const old=repayments.find(r=>r.id===row.id&&r.customerId===customerId);
      return !!old&&(old.lenderName!==row.lenderName||old.contactType!==row.contactType||old.contactValue!==row.contactValue||old.account!==row.account);
    }).map(row=>({...row,customerId}));
    const {error}=await saveBatch("repayment",{p_customer_id:customerId,p_rows:rows,p_carries:carries,p_delete_ids:deletedIds,p_versions:versions});
    if(error)throw new Error(`상환 원자적 저장 실패: ${error.message}`);
    // 업체 마스터 자동동기화는 별도 부수효과. 실패 시 저장 자체를 재시도하면 중복될 수 있으므로 재확인 안내.
    try{if(lenderSyncRows.length)await syncLendersFromRepayments(lenderSyncRows)}
    catch(e){console.error("상환 저장 후 업체정보 동기화 실패",e);fail("상환 일정은 저장됐지만 업체정보 동기화에 실패했습니다. 업체 관리 화면을 확인해주세요.")}
    await refresh();
  },
  async savePaymentWithCarry(id,p,carry){
    const cur=payments.find(x=>x.id===id);
    if(!cur)throw new Error("원본 납부일정을 찾지 못했습니다.");
    if(cur.scheduleType==="환수"||cur.scheduleType==="추가계약")throw new Error("시스템 관리 납부일정은 이월할 수 없습니다.");
    const updated={...cur,...p};
    const amount=paymentCarryAmount(updated,carry.dueAmount);
    const {error}=await saveBatch("payment",{p_customer_id:cur.customerId,p_rows:[updated],p_carries:{[id]:[{dueDate:carry.dueDate,dueAmount:amount,memo:carry.memo}]},p_delete_ids:[]});
    if(error)throw new Error(`부분납부 원자적 저장 실패: ${error.message}`);
    await refresh();
  },
  async createRescheduledPayment(fromId,v){
    const source=payments.find(p=>p.id===fromId);
    if(!source)throw new Error("원 납부일정을 찾지 못했습니다.");
    const {error}=await saveBatch("payment",{p_customer_id:source.customerId,p_rows:[source],p_carries:{[fromId]:[v]},p_delete_ids:[]});
    if(error)throw new Error(error.message);
    await refresh();
  },
  async addRepayment(v){
    const {error}=await saveBatch("repayment",{p_customer_id:v.customerId,p_rows:[v],p_carries:{},p_delete_ids:[]});
    if(error)throw new Error(error.message);
    try{await syncLendersFromRepayments([v])}catch(e){console.error("상환 저장 후 업체정보 동기화 실패",e);fail("상환 일정은 저장됐지만 업체정보 동기화에 실패했습니다.")}
    await refresh();
  },
  async updateRepayment(id,p){
    const cur=repayments.find(x=>x.id===id);
    if(!cur)throw new Error("원본 상환일정을 찾지 못했습니다.");
    const v={...cur,...p};
    if(v.customerId!==cur.customerId)throw new Error("기존 상환일정의 고객은 변경할 수 없습니다.");
    const {error}=await saveBatch("repayment",{p_customer_id:cur.customerId,p_rows:[v],p_carries:{},p_delete_ids:[]});
    if(error)throw new Error(error.message);
    if(cur.lenderName!==v.lenderName||cur.contactType!==v.contactType||cur.contactValue!==v.contactValue||cur.account!==v.account){
      try{await syncLendersFromRepayments([v])}catch(e){console.error("상환 저장 후 업체정보 동기화 실패",e);fail("상환 일정은 저장됐지만 업체정보 동기화에 실패했습니다.")}
    }
    await refresh();
  },
  async deleteRepayment(id){
    const target=repayments.find(row=>row.id===id);
    if(!target)throw new Error("삭제할 상환 일정을 찾지 못했습니다.");
    const {error}=await saveBatch("repayment",{p_customer_id:target.customerId,p_rows:[],p_carries:{},p_delete_ids:[id]});
    if(error)throw new Error(error.message);
    await refresh();
  },
  async cancelCompletedRepayment(id,expectedVersion){
    const target=repayments.find(row=>row.id===id);
    if(!target)throw new Error("삭제할 상환 기록을 찾지 못했습니다.");
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new Error("상환 기록을 새로 불러온 뒤 삭제해주세요.");
    const row={...target,rowVersion:expectedVersion,paidAmount:0,paidDate:"",status:"예정",promiseState:"cancelled"};
    const {error}=await saveBatch("repayment",{p_customer_id:target.customerId,p_rows:[row],p_carries:{},p_delete_ids:[]});
    if(error)throw new Error(error.message);
    await refresh();
  },
  async setCustomerRepayments(customerId,rows){
    const keepIds=new Set(rows.flatMap(row=>row.id?[row.id]:[]));
    const deletedIds=repayments.filter(row=>row.customerId===customerId&&!keepIds.has(row.id)).map(row=>row.id);
    const {error}=await saveBatch("repayment",{p_customer_id:customerId,p_rows:rows,p_carries:{},p_delete_ids:deletedIds});
    if(error)throw new Error(error.message);
    try{await syncLendersFromRepayments(rows.map(row=>({...row,customerId})))}catch(e){console.error("상환 저장 후 업체정보 동기화 실패",e);fail("상환 일정은 저장됐지만 업체정보 동기화에 실패했습니다.")}
    await refresh();
  },
  async createRescheduledRepayment(fromId,v){
    const source=repayments.find(row=>row.id===fromId);
    if(!source)throw new Error("원본 상환일정을 찾지 못했습니다.");
    const {error}=await saveBatch("repayment",{p_customer_id:source.customerId,p_rows:[source],p_carries:{[fromId]:[v]},p_delete_ids:[]});
    if(error)throw new Error(error.message);
    await refresh();
  },
  async setCustomerAdditionalContracts(customerId,rows){
    const keepIds=new Set(rows.map(row=>row.id).filter(Boolean));
    const deletedIds=additionalContracts.filter(row=>row.customerId===customerId&&!keepIds.has(row.id)).map(row=>row.id);
    const {error}=await saveBatch("additional",{p_customer_id:customerId,p_rows:rows,p_carries:{},p_delete_ids:deletedIds});
    if(error)throw new Error(error.message);
    await refresh();
  },
  async setCustomerRecoveries(customerId,rows,originalVersions){
    const customerRows=recoveries.filter(row=>row.customerId===customerId);
    const keepIds=new Set(rows.flatMap(row=>row.id?[row.id]:[]));
    const versions=originalVersions?{...originalVersions}:Object.fromEntries(customerRows.map(row=>[row.id,row.rowVersion||1]));
    if(!originalVersions)for(const row of rows)if(row.id&&row.rowVersion!==undefined)versions[row.id]=row.rowVersion;
    const deletedIds=Object.keys(versions).filter(id=>!keepIds.has(id));
    const keys=(["recoveryDate","lenderName","depositorName","amount","paymentMethod","memo","installmentAmount","clientReturnAmount"] as const);
    const changed=rows.filter(row=>{
      if(!row.id)return true;
      if(row.accountingVersion!==2)return false;
      const old=customerRows.find(saved=>saved.id===row.id);
      return !old||old.accountingVersion!==2||keys.some(key=>(row[key]??"")!==(old[key]??""));
    });
    if(!changed.length&&!deletedIds.length)return;
    const {error}=await saveBatch("recovery",{p_customer_id:customerId,p_rows:changed,p_delete_ids:deletedIds,p_versions:versions});
    if(error)throw new Error(error.message);
    await refresh();
  },

  addLender(v){void (async()=>{const norm=(x:string)=>String(x||"").trim();const normContact=(x:string)=>String(x||"").replace(/\s+/g,"");const duplicate=v.contacts.some(contact=>{const contactValue=normContact(contact.value);if(!contactValue)return false;return lenders.some(l=>norm(l.name)===norm(v.name)&&l.contacts.some(c=>c.type===contact.type&&normContact(c.value)===contactValue))});if(duplicate)return fail("업체명, 연락수단, 공백을 제외한 연락정보가 모두 같은 업체가 이미 등록되어 있습니다.");const {data,error}=await supabase.from("lenders").insert({name:v.name,account_info:v.account||null,memo:v.memo,created_at:v.createdAt||undefined}).select("id").single();if(error)return fail(error.message);if(v.contacts.length){const c=await supabase.from("lender_contacts").insert(v.contacts.map((x,i)=>({lender_id:data.id,contact_type:x.type,contact_value:x.value||"",sort_order:i})));if(c.error)return fail(c.error.message)}if(v.customerIds?.length){const links=await supabase.from("lender_customers").insert(v.customerIds.map(customerId=>({lender_id:data.id,customer_id:customerId})));if(links.error)return fail(links.error.message)}await refresh()})()},
  updateLender(id,p){void (async()=>{const cur=lenders.find(x=>x.id===id);if(!cur)return;const v={...cur,...p};const u=await supabase.from("lenders").update({name:v.name,account_info:v.account||null,memo:v.memo,created_at:v.createdAt||undefined}).eq("id",id);if(u.error)return fail(u.error.message);const d=await supabase.from("lender_contacts").delete().eq("lender_id",id);if(d.error)return fail(d.error.message);if(v.contacts.length){const c=await supabase.from("lender_contacts").insert(v.contacts.map((x,i)=>({lender_id:id,contact_type:x.type,contact_value:x.value||"",sort_order:i})));if(c.error)return fail(c.error.message)}const oldCustomerIds=new Set(cur.customerIds||[]);const nextCustomerIds=new Set(v.customerIds||[]);const removed=[...oldCustomerIds].filter(customerId=>!nextCustomerIds.has(customerId));const added=[...nextCustomerIds].filter(customerId=>!oldCustomerIds.has(customerId));if(removed.length){const dl=await supabase.from("lender_customers").delete().eq("lender_id",id).in("customer_id",removed);if(dl.error)return fail(dl.error.message)}if(added.length){const links=await supabase.from("lender_customers").insert(added.map(customerId=>({lender_id:id,customer_id:customerId})));if(links.error)return fail(links.error.message)}await refresh()})()},
  deleteLender(id){void (async()=>{const {error}=await supabase.from("lenders").update({deleted_at:new Date().toISOString()}).eq("id",id);if(error)return fail(error.message);await refresh()})()},
  addPost(v){void (async()=>{const {data,error}=await supabase.from("board_posts").insert({title:v.title,body:v.body,author:v.writer,post_date:v.date,is_notice:v.isNotice,notice_order:v.noticeOrder}).select("id").single();if(error)return fail(error.message);if(v.attachments.length){const a=await supabase.from("board_attachments").insert(v.attachments.map(x=>({post_id:data.id,file_name:x.name,storage_path:x.storagePath,file_size:x.size,mime_type:x.type})));if(a.error)return fail(a.error.message)}await refresh()})()},
  updatePost(id,p){void (async()=>{const cur=posts.find(x=>x.id===id);if(!cur)return;const v={...cur,...p};const u=await supabase.from("board_posts").update({title:v.title,body:v.body,author:v.writer,post_date:v.date,is_notice:v.isNotice,notice_order:v.noticeOrder}).eq("id",id);if(u.error)return fail(u.error.message);const d=await supabase.from("board_attachments").delete().eq("post_id",id);if(d.error)return fail(d.error.message);if(v.attachments.length){const a=await supabase.from("board_attachments").insert(v.attachments.map(x=>({post_id:id,file_name:x.name,storage_path:x.storagePath,file_size:x.size,mime_type:x.type})));if(a.error)return fail(a.error.message)}await refresh()})()},
  deletePost(id){void (async()=>{const post=posts.find(x=>x.id===id);if(post?.attachments.length)await supabase.storage.from("board-files").remove(post.attachments.map(a=>a.storagePath));const {error}=await supabase.from("board_posts").delete().eq("id",id);if(error)return fail(error.message);await refresh()})()},
  async addSettlement(v,requestId=crypto.randomUUID()){
   const payload={id:requestId,payment_date:v.paidDate,client_name:v.clientName,amount:v.amount,payment_method:v.paymentMethod,memo:v.memo,entry_source:"manual",entry_type:"계약"};
   const {error}=await supabase.from("settlement_entries").insert(payload);
   if(error){
    if(error.code!=="23505")throw new Error(error.message);
    // A response may be lost after commit. Reuse the draft UUID and acknowledge
    // only an identical active manual receipt; never overwrite or revive a row.
    const {data:saved,error:lookupError}=await supabase.from("settlement_entries").select("id,payment_date,client_name,amount,payment_method,memo,entry_source,entry_type,source_payment_schedule_id,source_recovery_id,deleted_at,user_deleted").eq("id",requestId).maybeSingle();
    if(lookupError)throw new Error(lookupError.message);
    if(!saved)throw new Error(error.message);
    if(saved.deleted_at||saved.user_deleted||saved.entry_source!=="manual"||saved.entry_type!=="계약"||saved.source_payment_schedule_id||saved.source_recovery_id
     ||String(saved.payment_date||"").slice(0,10)!==v.paidDate||saved.client_name!==v.clientName||Number(saved.amount)!==v.amount||saved.payment_method!==v.paymentMethod||saved.memo!==v.memo)
     throw new Error("같은 저장 요청으로 이미 다른 내용이 저장되었거나 삭제되었습니다. 새로고침 후 해당 정산 내역을 확인해주세요.");
   }
   await refresh();
  },
  async updateSettlement(id,p){const cur=settlements.find(x=>x.id===id);if(!cur)throw new Error("정산 내역을 찾지 못했습니다. 새로고침 후 확인해주세요.");if(cur.entrySource&&cur.entrySource!=="manual")throw new Error("자동 연동된 정산 내역은 원본 입금·환수 관리에서 수정해주세요.");const v={...cur,...p};const {error}=await supabase.from("settlement_entries").update({payment_date:v.paidDate,client_name:v.clientName,amount:v.amount,payment_method:v.paymentMethod,memo:v.memo}).eq("id",id);if(error)throw new Error(error.message);await refresh()},
  async deleteSettlement(id,expected,requestKey){
    if(!expected||!requestKey)throw new Error("실제 거래 취소 확인 정보를 다시 불러와주세요.");
    const sourceId=id.startsWith("refund:")?id.slice("refund:".length):id;
    const {data,error}=await supabase.rpc("dowon_cancel_settlement",{p_id:sourceId,p_expected:expected,p_request_key:requestKey});
    if(error)throw new Error(error.message);
    if(!data||data.cancelled!==true)throw new Error("취소 결과를 확인하지 못했습니다. 같은 확인창에서 다시 시도해주세요.");
    await refresh();
  },
  resetSample(){void refresh()}
 }),[loading,error,customers,payments,repayments,lenders,posts,settlements,metaLeads,additionalContracts,recoveries,recoveryAllocations,recoverySplits,recoveryRefunds,refresh,saveBatch]);
 return <Ctx.Provider value={value}>{loading&&!initialized?<div className="grid min-h-screen place-items-center bg-slate-50 text-sm font-semibold text-slate-500">데이터를 불러오는 중입니다...</div>:error&&!initialized?<div className="grid min-h-screen place-items-center bg-slate-50 p-6"><div className="max-w-xl rounded-xl border border-red-200 bg-white p-6 text-sm text-red-700"><b>Supabase 연결 오류</b><div className="mt-2 break-all">{error}</div><button className="mt-4 rounded-lg bg-blue-600 px-3 py-2 text-white" onClick={()=>void refresh()}>다시 시도</button></div></div>:children}</Ctx.Provider>;
}
export function useAdminStore(){const x=useContext(Ctx);if(!x)throw new Error("AdminStoreProvider missing");return x}
