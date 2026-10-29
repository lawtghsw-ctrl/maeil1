const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const vm=require('node:vm');
function compile(source,context={}){const mod={exports:{}};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,{module:mod,exports:mod.exports,Error,...context});return mod.exports;}
const {createLeadMemoDrafts}=compile(fs.readFileSync('lib/lead-memo-drafts.ts','utf8'));
const row=memo=>({id:'lead',memo});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('polling preserves an unsaved memo, including intentional empty text',()=>{
 const drafts=createLeadMemoDrafts();const read=drafts.beginRead();drafts.edit('lead','typing');assert.equal(drafts.mergeRows([row('old')],read)[0].memo,'typing');drafts.edit('lead','');assert.equal(drafts.mergeRows([row('old')],read)[0].memo,'');
});
test('save acknowledgement cannot expose an older in-flight read',async()=>{
 const drafts=createLeadMemoDrafts();const oldRead=drafts.beginRead();drafts.edit('lead','saved');await drafts.save('lead',async()=>{});assert.equal(drafts.mergeRows([row('old')],oldRead)[0].memo,'saved');
 const fresh=drafts.beginRead();assert.equal(drafts.mergeRows([row('changed by another editor')],fresh)[0].memo,'changed by another editor');assert.equal(drafts.mergeRows([row('old')],oldRead),null);
});
test('rapid edits serialize writes and an older success does not erase a newer draft',async()=>{
 const drafts=createLeadMemoDrafts(),first=deferred(),second=deferred(),writes=[];
 drafts.edit('lead','A');const a=drafts.save('lead',async value=>{writes.push(value);await first.promise});await tick();
 drafts.edit('lead','B');const read=drafts.beginRead();const b=drafts.save('lead',async value=>{writes.push(value);await second.promise});assert.deepEqual(writes,['A']);
 first.resolve();await tick();assert.deepEqual(writes,['A','B']);assert.equal(drafts.mergeRows([row('A')],read)[0].memo,'B');second.resolve();await Promise.all([a,b]);assert.equal(drafts.mergeRows([row('A')],read)[0].memo,'B');
});
test('failed save retains the latest memo and does not block queued retry',async()=>{
 const drafts=createLeadMemoDrafts(),first=deferred(),writes=[];drafts.edit('lead','A');const a=drafts.save('lead',async()=>first.promise);const failed=assert.rejects(a,/offline/);await tick();drafts.edit('lead','B');const b=drafts.save('lead',async value=>{writes.push(value)});first.reject(new Error('offline'));await failed;await b;assert.deepEqual(writes,['B']);const read=drafts.beginRead();assert.equal(drafts.mergeRows([row('B')],read)[0].memo,'B');
});
test('different rows save independently and unchanged repeated blur does not write twice',async()=>{
 const drafts=createLeadMemoDrafts(),slow=deferred();let writes=0;drafts.edit('one','A');drafts.edit('two','B');const a=drafts.save('one',async()=>slow.promise);await drafts.save('two',async()=>{writes++});await drafts.save('two',async()=>{writes++});assert.equal(writes,1);slow.resolve();await a;
});

function screen(file){
 const source=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let load;
 function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='load')load=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(load);
 const drafts=createLeadMemoDrafts(),requests=[];let rows=[row('local')],error=null;
 const supabase={from:table=>{const request=deferred();requests.push({table,...request});const q={select:()=>q,eq:()=>q,order:()=>q,then:(resolve,reject)=>request.promise.then(resolve,reject)};return q}};
 const run=vm.runInNewContext(ts.transpileModule(load.getText(ast)+';load',{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,{
  memoDrafts:drafts,supabase,setRows:value=>{rows=value},setLogs:()=>{},setLoading:()=>{},setError:value=>{error=value},detectLeadSource:()=>"랜딩 광고",formatPhone:v=>v,staffManager:v=>v,metaLeadResults:['미분류'],storedStage:v=>v,normalizeLeadStage:v=>v,CALL_WARNING_STAGES:new Set(),longNoAnswerQualifiedDays:()=>0,
 });
 const respond=(start,memo,fail=false)=>{requests[start].resolve(fail?{error:{message:'offline'},data:null}:{data:[{id:'lead',memo,status:'신규',lead_stage:'신규'}],error:null});requests[start+1].resolve({data:[],error:null});};
 return {drafts,run,respond,rows:()=>rows,error:()=>error};
}
for(const file of ['components/meta-leads-v28.tsx']){
 test(file+' refresh preserves current typing and keeps rows on failed reads',async()=>{
  const page=screen(file),read=page.run(true);page.drafts.edit('lead','typed during fetch');page.respond(0,'old');await read;assert.equal(page.rows()[0].memo,'typed during fetch');
  const before=page.rows(),failed=page.run(true);page.respond(2,'',true);await failed;assert.equal(page.rows(),before);assert.equal(page.error(),'offline');
 });
 test(file+' rejects older responses and protects a memo saved during fetch',async()=>{
  const page=screen(file),old=page.run(true),fresh=page.run(true);page.respond(2,'new server');await fresh;page.respond(0,'older server');await old;assert.equal(page.rows()[0].memo,'new server');
  const read=page.run(true);page.drafts.edit('lead','new save');await page.drafts.save('lead',async()=>{});page.respond(4,'new server');await read;assert.equal(page.rows()[0].memo,'new save');
 });
}

test('shared memo editor preserves text on save failure and verifies affected row before success',async()=>{
 const alerts=[],writes=[];let rows=[row('old')],fail=true;
 const client={from:table=>({update:patch=>{writes.push({table,...patch});return {eq:()=>({select:()=>({single:async()=>fail?{error:{message:'offline'},data:null}:{data:{id:'lead'},error:null}})})}}})};
 const {useLeadMemos}=compile(fs.readFileSync('components/use-lead-memos.ts','utf8'),{require:name=>{if(name==='react')return {useState:initial=>[initial(),()=>{}]};if(name==='@/lib/lead-memo-drafts')return {createLeadMemoDrafts};throw new Error(name)},alert:message=>alerts.push(message)});
 const editor=useLeadMemos('meta_leads',client,update=>{rows=update(rows)});editor.editMemo('lead','draft');await editor.saveMemo('lead');assert.equal(rows[0].memo,'draft');assert.equal(alerts.length,1);assert.equal(editor.memoDrafts.mergeRows([row('old')],editor.memoDrafts.beginRead())[0].memo,'draft');fail=false;await editor.saveMemo('lead');assert.equal(writes.length,2);assert.equal(writes[1].memo,'draft');
});
