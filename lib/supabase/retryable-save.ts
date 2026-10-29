type RpcResult={data:unknown;error:{message:string;code?:string}|null};
type Rpc=(name:string,args:Record<string,unknown>)=>PromiseLike<RpcResult>;

// Keep a failed request's key for a retry in the same mounted editor/session.
// Concurrent identical submissions share the same promise. Successful requests
// release the key so a later intentional identical operation remains possible.
export function createRetryableSave(rpc:Rpc,uuid=()=>crypto.randomUUID()){
 const pending=new Map<string,{key:string;args:Record<string,unknown>;promise?:Promise<RpcResult>}>();
 return function save(kind:string,args:Record<string,unknown>,preparedArgs=args):Promise<RpcResult>{
  const identity=JSON.stringify([kind,args]);
  // Snapshot derived versions on the FIRST attempt. A realtime refresh after a
  // committed-but-lost response must not turn the retry into a second insert.
  const entry=pending.get(identity)||{key:uuid(),args:JSON.parse(JSON.stringify(preparedArgs)) as Record<string,unknown>};
  if(entry.promise)return entry.promise;
  pending.set(identity,entry);
  entry.promise=Promise.resolve().then(()=>{
   const {p_carries,...directArgs}=entry.args;
   if(kind==="payment"||kind==="repayment"){
    if(p_carries&&Object.keys(p_carries as object).length)throw new Error("재조율 기능이 변경되었습니다. 일정을 직접 수정해주세요.");
    return rpc("dowon_save_schedule_batch_v3",{...directArgs,p_kind:kind,p_request_key:entry.key});
   }
   if(kind==="recovery")return rpc("dowon_save_recovery_batch_v2",{...directArgs,p_request_key:entry.key});
   return rpc("dowon_save_schedule_batch_once",{...entry.args,p_kind:kind,p_request_key:entry.key});
  }).then(result=>{
   // These PostgreSQL errors confirm a rollback. A refreshed retry can use a
   // new snapshot; ambiguous transport/connection failures must retain it.
   const code=result.error?.code||"";
   if(!result.error||/^(22|23|42|P0)/.test(code)||code==="40001"||code==="40P01")pending.delete(identity);
   return result;
  }).finally(()=>{entry.promise=undefined});
  return entry.promise;
 };
}
