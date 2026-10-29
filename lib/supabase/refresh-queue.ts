// Serialize refreshes. Calls made during a fetch request one trailing fetch,
// so a save cannot be hidden by an older response finishing afterwards.
export function createRefreshQueue(run:(tables:ReadonlySet<string>|null)=>Promise<void>){
 let pending:Set<string>|null|undefined;
 let active:Promise<void>|undefined;
 return function refresh(tables?:readonly string[]):Promise<void>{
  if(!tables)pending=null;
  else if(pending!==null){pending??=new Set();for(const table of tables)pending.add(table)}
  if(!active)active=Promise.resolve().then(async()=>{
   while(pending!==undefined){const next=pending;pending=undefined;await run(next)}
  }).finally(()=>{active=undefined});
  return active;
 };
}

type RowsResult<T>={data:T[]|null;error:{message:string}|null};
// Cache belongs to one mounted provider, never to a shared server/session.
export function createTableLoader(){
 const cache=new Map<string,RowsResult<unknown>>();
 return async function load<T>(table:string,reload:boolean,fetch:()=>Promise<RowsResult<T>>):Promise<RowsResult<T>>{
  if(!reload&&cache.has(table))return cache.get(table) as RowsResult<T>;
  // A failed refresh must not reuse stale rows alongside newer related tables.
  cache.delete(table);
  const result=await fetch();
  if(!result.error)cache.set(table,result);
  return result;
 };
}

// Avoid publishing a new store and resetting downstream memo/effect work when
// a fallback poll returned the same values (including nested contact lists).
export function reuseUnchangedRows<T>(previous:T[],next:T[]):T[]{
 return previous.length===next.length&&JSON.stringify(previous)===JSON.stringify(next)?previous:next;
}

export function groupBy<T>(rows:readonly T[],key:(row:T)=>string):Map<string,T[]>{
 const groups=new Map<string,T[]>();
 for(const row of rows){const id=key(row);const group=groups.get(id);if(group)group.push(row);else groups.set(id,[row])}
 return groups;
}
