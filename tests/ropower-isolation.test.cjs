const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);}
function compile(code,context={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,...context});return module.exports;}
function declaration(file,name){const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found;function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node;ts.forEachChild(node,visit);}visit(tree);assert.ok(found,name);return found.getText(tree);}

test('runtime includes no other-company service address, notice bank or native app bridge',()=>{
 const files=['app','components','lib'].flatMap(walk).filter(file=>/\.tsx?$/.test(file));
 for(const file of files){const code=fs.readFileSync(file,'utf8');assert.doesNotMatch(code,/tg-m(?:-ten|-doone1)?\.vercel\.app|qaydmhyayyxymwvushix|301-0373-7616-91/,file);assert.doesNotMatch(code,/DowonNative|dowon-(?:call|sms):|@\/lib\/native-app|@\/components\/call-analysis|\/api\/call-analysis|\/downloads\/(?:apps|call-companion)/,file);}
 for(const file of ['app/(admin)/apps/page.tsx','app/(admin)/calls/page.tsx','app/api/call-analysis/route.ts','app/api/sms/send/route.ts','components/external-leads.tsx'])assert.equal(fs.existsSync(file),false,file);
});
test('browser, server and service clients use only the configured company connection',async()=>{
 const env={NEXT_PUBLIC_SUPABASE_URL:'https://ropower-fixture.invalid',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'ropower-public-fixture',SUPABASE_SERVICE_ROLE_KEY:'server-fixture-only'};
 for(const [file,factory,key] of [['lib/supabase/client.ts','createBrowserClient',env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY],['lib/supabase/server.ts','createServerClient',env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY],['lib/supabase/admin.ts','createClient',env.SUPABASE_SERVICE_ROLE_KEY]]){
  const calls=[],client={fixture:true};const api=compile(fs.readFileSync(file,'utf8'),{process:{env},require:name=>name==='next/headers'?{cookies:async()=>({getAll:()=>[],set(){}})}:{[factory]:(...args)=>{calls.push(args);return client}}});
  assert.equal(await (api.createAdminClient||api.createClient)(),client);assert.equal(calls.length,1);assert.equal(calls[0][0],env.NEXT_PUBLIC_SUPABASE_URL);assert.equal(calls[0][1],key);
 }
});
test('manual, landing and instant-form DB sources remain distinct',()=>{
 const api=compile(declaration('components/meta-leads-v28.tsx','detectLeadSource')+';exports.detect=detectLeadSource;');
 for(const [row,expected] of [[{meta_lead_id:'manual:fixture'},'수기등록'],[{meta_lead_id:'gsheet-instant:fixture'},'인스턴트 양식'],[{meta_lead_id:'gsheet:fixture',meta_native_lead_id:'123'},'인스턴트 양식'],[{meta_lead_id:'gsheet:fixture'},'랜딩 광고']])assert.equal(api.detect(row),expected);
 const form=compile(declaration('components/meta-leads-v28.tsx','emptyManualLead')+';exports.create=emptyManualLead;',{manualLeadNow:()=> '2026-10-29T10:00'}).create();
 assert.equal(form.manager,'신홍규');assert.equal(form.coordinationManager,'신홍규');
});
test('refreshing a qualified no-answer lead preserves its state and performs no data writes',async()=>{
 const input={id:'lead-fixture',memo:'기존 고객 메모',lead_result:'부재',lead_stage:'부재',status:'신규',meta_lead_id:'manual:fixture'};
 const requests=[],writes=[];let rows;
 const supabase={from(table){requests.push(table);const query={select:()=>query,eq:()=>query,order:()=>query,then:resolve=>Promise.resolve({data:table==='meta_leads'?[input]:[],error:null}).then(resolve),update:patch=>{writes.push(patch);throw Error('A refresh cannot write data');}};return query;}};
 const drafts={beginRead:()=>({revision:1}),isCurrentRead:()=>true,mergeRows:value=>value};
 const api=compile(declaration('components/meta-leads-v28.tsx','load')+';exports.load=load;',{supabase,memoDrafts:drafts,setLoading(){},setError(){},setLogs(){},setRows:value=>{rows=value},formatPhone:v=>v,staffManager:v=>v,detectLeadSource:()=> '수기등록',metaLeadResults:['부재'],storedStage:value=>value,normalizeLeadStage:value=>value,longNoAnswerQualifiedDays:()=>999,CALL_WARNING_STAGES:new Set(['부재']),fetch:()=>{throw Error('A refresh cannot send conversion events');}});
 await api.load();assert.deepEqual(requests,['meta_leads','lead_call_logs']);assert.equal(writes.length,0);assert.equal(rows[0].stage,'부재');assert.equal(rows[0].memo,input.memo);assert.equal(rows[0].source,'수기등록');
});
