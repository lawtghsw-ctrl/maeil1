type Result<T>={data:T[]|null;error:{message:string}|null;count?:number|null};
type Query<T>={range:(from:number,to:number)=>PromiseLike<Result<T>>};

// Use the first page's count when supplied; otherwise read through an empty page.
// A short page is never treated as EOF: the server may enforce a lower cap.
// Callers must supply stable ordering with a unique final sort key.
export async function fetchAllRows<T>(query:(firstPage:boolean)=>Query<T>,pageSize=500):Promise<Result<T>>{
 const rows:T[]=[];
 let total:number|null=null;
 try{
  for(;;){
   const result=await query(rows.length===0).range(rows.length,rows.length+pageSize-1);
   if(result.error)return {data:null,error:result.error};
   if(!result.data?.length)return {data:rows,error:null};
   if(rows.length===0&&typeof result.count==="number")total=result.count;
   rows.push(...result.data);
   if(total!==null&&rows.length>=total)return {data:rows,error:null};
  }
 }catch(error){return {data:null,error:{message:error instanceof Error?error.message:String(error)}}}
}
