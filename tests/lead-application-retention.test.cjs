const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
function compile(source,context={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,require,Error,...context});return module.exports;}
function declaration(name){const file='components/meta-leads-v28.tsx',tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found;function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node;ts.forEachChild(node,visit);}visit(tree);assert.ok(found,name);return found.getText(tree);}
const {LeadApplicationInfo,showsLegacyApplicationDetails}=compile(fs.readFileSync('components/lead-application-info.tsx','utf8'));
const base=()=>({collectionIntensity:'전화_문자_독촉',principalAmount:'0005000',repaymentTotal:'1.00_만원',evidence:'보존된_증거_원문',thirdPartyDamage:'보존된_주변인피해_원문'});
function plainText(html){return html.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#x27;/g,"'").replace(/&quot;/g,'"');}
function view(lead){const html=renderToStaticMarkup(React.createElement(LeadApplicationInfo,{lead}));return {html,labels:Array.from(html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>/g),m=>plainText(m[1])),values:Array.from(html.matchAll(/<dd\b[^>]*>([\s\S]*?)<\/dd>/g),m=>plainText(m[1]))};}
test('a lead marked as an existing landing record retains both historic application detail fields',()=>{
 const lead=Object.freeze({...base(),source:'랜딩 광고',legacyApplicationDetails:true}),before=JSON.stringify(lead),result=view(lead);
 assert.deepEqual(result.labels,['추심강도','대여원금','상환총액','증거보유','주변인피해']);assert.deepEqual(result.values,Object.values(base()));assert.equal(JSON.stringify(lead),before);
});
test('an existing landing lead keeps its historic answers after native-ID backfill changes its displayed source',()=>{
 const lead=Object.freeze({...base(),source:'인스턴트 양식',legacyApplicationDetails:true}),result=view(lead);assert.deepEqual(result.labels,['추심강도','대여원금','상환총액','증거보유','주변인피해']);assert.equal(result.values[3],lead.evidence);assert.equal(result.values[4],lead.thirdPartyDamage);
});
for(const [label,classification] of [
 ['an existing instant-form lead',{source:'인스턴트 양식',legacyApplicationDetails:false}],
 ['an existing manual lead',{source:'수기등록',legacyApplicationDetails:false}],
 ['a new landing lead',{source:'랜딩 광고',legacyApplicationDetails:false}],
 ['a new instant-form lead',{source:'인스턴트 양식',legacyApplicationDetails:false}],
 ['a landing lead with no explicit old-record marker',{source:'랜딩 광고'}],
 ['a record with no recognized source or old-record eligibility',{legacyApplicationDetails:false}],
])test(label+' shows only the three retained fields without changing stored raw values',()=>{
 const lead=Object.freeze({...base(),...classification}),before=JSON.stringify(lead),result=view(lead);
 assert.deepEqual(result.labels,['추심강도','대여원금','상환총액']);assert.deepEqual(result.values,Object.values(base()).slice(0,3));assert.doesNotMatch(result.html,/증거보유|주변인피해|보존된_증거_원문|보존된_주변인피해_원문/);assert.equal(JSON.stringify(lead),before);
});
test('new landing records remain three-field records even with a deliberately backdated intake date',()=>{
 const result=view({...base(),source:'랜딩 광고',legacyApplicationDetails:false,createdAt:'2020-01-01T00:00:00Z'});assert.equal(result.labels.length,3);assert.doesNotMatch(result.html,/보존된_증거_원문|보존된_주변인피해_원문/);
});
test('blank legacy landing fields retain five placeholders while future records retain three',()=>{
 const empty={collectionIntensity:'',principalAmount:'',repaymentTotal:'',evidence:'',thirdPartyDamage:'',source:'랜딩 광고'};
 assert.deepEqual(view({...empty,legacyApplicationDetails:true}).values,['-','-','-','-','-']);assert.deepEqual(view({...empty,legacyApplicationDetails:false}).values,['-','-','-']);
});
test('long retained raw strings preserve underscores and complete values',()=>{
 const raw='기존_원문_'.repeat(30),result=view({...base(),source:'랜딩 광고',legacyApplicationDetails:true,evidence:raw,thirdPartyDamage:'가족 & 직장 <연락>'});assert.equal(result.values[3],raw);assert.equal(result.values[4],'가족 & 직장 <연락>');
});
function search(rows,q){
 const file='components/meta-leads-v28.tsx',tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let filtered;
 function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='filtered')filtered=node;ts.forEachChild(node,visit);}visit(tree);assert.ok(filtered);
 return compile('const '+filtered.getText(tree)+';exports.rows=filtered;',{managedRows:rows,q,stage:'전체',useMemo:fn=>fn(),showsLegacyApplicationDetails}).rows;
}
test('search includes historic answers only for leads with frozen old-landing eligibility',()=>{
 const rows=[{id:'old-landing',source:'랜딩 광고',legacyApplicationDetails:true},{id:'enriched-old-landing',source:'인스턴트 양식',legacyApplicationDetails:true},{id:'old-instant',source:'인스턴트 양식',legacyApplicationDetails:false},{id:'new-landing',source:'랜딩 광고',legacyApplicationDetails:false},{id:'manual',source:'수기등록',legacyApplicationDetails:false}].map(row=>Object.freeze({...base(),name:'가상 고객',phone:'01000000000',manager:'신홍규',coordinationManager:'이중호',leadResult:'신규DB',stage:'신규',memo:'상담 메모',...row}));
 assert.deepEqual(Array.from(search(rows,'보존된_증거_원문'),row=>row.id),['old-landing','enriched-old-landing']);assert.deepEqual(Array.from(search(rows,'보존된_주변인피해_원문'),row=>row.id),['old-landing','enriched-old-landing']);assert.equal(search(rows,'0005000').length,5);assert.equal(search(rows,'상담 메모').length,5);
});
test('loading history derives the marker only from its explicit database boolean and does not write',async()=>{
 const source=compile(declaration('detectLeadSource')+';exports.detect=detectLeadSource;').detect;
 const records=[
  {id:'old-landing',meta_lead_id:'gsheet:old',legacy_application_details:true},
  {id:'backdated-new',meta_lead_id:'gsheet:new',created_at:'2020-01-01',legacy_application_details:false},
  {id:'old-instant',meta_lead_id:'123456789',legacy_application_details:false},
  {id:'no-marker',meta_lead_id:'manual:no-marker'},
 ].map(row=>({memo:'원본 메모',status:'신규',lead_result:'미분류',collection_intensity:'원문_추심',principal_amount:'0005000',repayment_total:'1.00',evidence:'증거_원문',third_party_damage:'주변인_원문',...row}));
 const before=JSON.stringify(records);let rows;
 const supabase={from(table){const query={select:()=>query,eq:()=>query,order:()=>query,then:resolve=>Promise.resolve({data:table==='meta_leads'?records:[],error:null}).then(resolve),update(){throw Error('Read cannot update')},insert(){throw Error('Read cannot insert')},delete(){throw Error('Read cannot delete')}};return query;}};
 const {load}=compile(declaration('load')+';exports.load=load;',{supabase,memoDrafts:{beginRead:()=>({}),isCurrentRead:()=>true,mergeRows:value=>value},setLoading(){},setError(){},setLogs(){},setRows:value=>{rows=value},formatPhone:v=>v,staffManager:v=>v,detectLeadSource:source,metaLeadResults:['미분류'],storedStage:v=>v});
 await load();assert.deepEqual(Array.from(rows,row=>row.legacyApplicationDetails),[true,false,false,false]);assert.deepEqual(Array.from(rows,row=>view(row).labels.length),[5,3,3,3]);assert.equal(JSON.stringify(records),before);
});
test('manual intake no longer exposes or submits the two retired application questions',async()=>{
 const factory=compile(declaration('emptyManualLead')+';exports.create=emptyManualLead;',{manualLeadNow:()=> '2026-11-03T12:00'}).create;
 const value=factory();assert.equal('evidence' in value,false);assert.equal('thirdPartyDamage' in value,false);
 const inserts=[],alerts=[];
 const {save}=compile(declaration('saveManualLead')+';exports.save=saveManualLead;',{manualSaving:false,manualForm:{...value,name:'가상 고객',phone:'01000000000',evidence:'낡은폼_증거',thirdPartyDamage:'낡은폼_주변인'},formatPhone:v=>v,phoneDigits:v=>String(v).replace(/\D/g,''),rows:[],setManualSaving(){},setManualOpen(){},setPage(){},load:async()=>{},alert:message=>alerts.push(message),crypto:{randomUUID:()=> 'fixture'},supabase:{from(table){assert.equal(table,'meta_leads');return {insert:async payload=>{inserts.push(payload);return {error:null}}}}}});
 await save();assert.equal(inserts.length,1);assert.equal('evidence' in inserts[0],false);assert.equal('third_party_damage' in inserts[0],false);assert.notEqual(inserts[0].legacy_application_details,true);assert.match(alerts[0],/완료/);
});
