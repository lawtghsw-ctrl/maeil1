type ReadToken={sequence:number;revision:number};
type Draft={value:string;revision:number;dirty:boolean};

// One controller per mounted lead list. No browser storage or global user cache.
export function createLeadMemoDrafts(){
 const drafts=new Map<string,Draft>();
 const saves=new Map<string,Promise<void>>();
 let revision=0,readSequence=0;
 const isCurrentRead=(read:ReadToken)=>read.sequence===readSequence;
 return {
  beginRead():ReadToken{return {sequence:++readSequence,revision}},
  isCurrentRead,
  edit(id:string,value:string){
   if(drafts.get(id)?.value===value)return;
   drafts.set(id,{value,revision:++revision,dirty:true});
  },
  mergeRows<T extends {id:string;memo:string}>(rows:T[],read:ReadToken):T[]|null{
   if(!isCurrentRead(read))return null;
   return rows.map(row=>{
    const draft=drafts.get(row.id);
    if(!draft)return row;
    if(draft.dirty||draft.revision>read.revision)return {...row,memo:draft.value};
    // This read began after the save was acknowledged, so its server value is
    // authoritative. Older reads are excluded by readSequence above.
    drafts.delete(row.id);
    return row;
   });
  },
  save(id:string,write:(value:string)=>Promise<void>):Promise<void>{
   const previous=saves.get(id)??Promise.resolve();
   const pending=previous.catch(()=>{}).then(async()=>{
    const draft=drafts.get(id);
    if(!draft?.dirty)return;
    const {value,revision:version}=draft;
    await write(value);
    // A slow response must not clear edits made while it was in flight.
    if(drafts.get(id)?.revision===version){
     drafts.set(id,{value,revision:++revision,dirty:false});
    }
   });
   saves.set(id,pending);
   const release=()=>{if(saves.get(id)===pending)saves.delete(id)};
   void pending.then(release,release);
   return pending;
  },
 };
}
