const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const clone=value=>JSON.parse(JSON.stringify(value));
const secret='local-fixture-secret';
const baseBody=(patch={})=>({created_time:'2026-11-03T03:00:00Z',full_name:'가상 고객',phone_number:'+82 10-0000-0000',spreadsheet_id:'fixture-book',sheet_id:'fixture-tab',row_number:'11',collection_strength:'전화_문자_독촉',original_principal:'0005000',repayment_total:'1.00_만원',evidence_held:'입력하면_안되는_증거_원문',surrounding_damage:'입력하면_안되는_주변인_원문',evidence:'다른키_증거_원문',third_party_damage:'다른키_주변인_원문',legacy_application_details:true,...patch});
function existing(patch={}){return {id:'existing-lead',meta_lead_id:'gsheet:fixture-book:fixture-tab:11',customer_name:'가상 고객',phone_number:'010-0000-0000',meta_native_lead_id:null,source_row_number:11,collection_intensity:'기존_추심',principal_amount:'기존_원금',repayment_total:'기존_상환',evidence:'보존할_기존_증거',third_party_damage:'보존할_기존_주변인피해',legacy_application_details:true,...patch};}
function harness(initial=[]){
 const rows=clone(initial),calls=[];let network=0;
 const project=(row,columns)=>Object.fromEntries(columns.split(',').map(column=>column.trim()).map(column=>[column,row[column]]));
 const supabase={from(table){assert.equal(table,'meta_leads');return {
  select(columns){calls.push({action:'select',columns});const conditions=[];const matches=()=>rows.filter(row=>conditions.every(([key,value])=>row[key]===value));const query={eq(key,value){conditions.push([key,value]);return query;},limit:async()=>({data:matches().map(row=>project(row,columns)),error:null}),maybeSingle:async()=>({data:matches()[0]?project(matches()[0],columns):null,error:null})};return query;},
  insert(payload){calls.push({action:'insert',payload:clone(payload)});if(rows.some(row=>row.meta_lead_id===payload.meta_lead_id))return Promise.resolve({error:{code:'23505',message:'fixture duplicate'}});rows.push({id:'new-lead',evidence:'',third_party_damage:'',legacy_application_details:false,...clone(payload)});return Promise.resolve({error:null});},
  update(payload){calls.push({action:'update',payload:clone(payload)});return {eq:async(key,value)=>{for(const row of rows)if(row[key]===value)Object.assign(row,clone(payload));return {error:null};}};},
 };}};
 const module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync('app/api/google-sheet/lead/route.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,process:{env:{GOOGLE_SHEET_INGEST_SECRET:secret}},Error,Date,console:{error(){},warn(){}},fetch(){network++;throw Error('Fixture must not send network requests');},require:name=>{
  if(name==='next/server')return {NextResponse:{json:(value,options={})=>new Response(JSON.stringify(value),{status:options.status||200,headers:{'Content-Type':'application/json'}})}};
  if(name==='@/lib/supabase/admin')return {createAdminClient:()=>supabase};
  throw Error('Unexpected dependency '+name);
 }});
 return {rows,calls,get network(){return network},post:(body,providedSecret=secret)=>module.exports.POST(new Request('https://fixture.invalid/api/google-sheet/lead',{method:'POST',headers:{'Content-Type':'application/json','x-ingest-secret':providedSecret},body:JSON.stringify(body)}))};
}
function assertRetiredFieldsOmitted(payload){assert.equal('evidence' in payload,false);assert.equal('third_party_damage' in payload,false);assert.equal('evidence_held' in payload,false);assert.equal('surrounding_damage' in payload,false);assert.notEqual(payload.legacy_application_details,true);}

for(const source_type of ['landing','instant'])test('new '+source_type+' ingestion discards retired answers and cannot opt back into legacy display',async()=>{
 const h=harness(),response=await h.post(baseBody({source_type,leadgen_id:source_type==='instant'?'123456789012345':undefined}));assert.equal(response.status,200);assert.equal((await response.json()).saved,true);assert.equal(h.rows.length,1);
 const inserted=h.calls.find(call=>call.action==='insert').payload;assertRetiredFieldsOmitted(inserted);assert.equal(inserted.collection_intensity,'전화_문자_독촉');assert.equal(inserted.principal_amount,'0005000');assert.equal(inserted.repayment_total,'1.00_만원');assert.equal(inserted.meta_lead_id.startsWith(source_type==='instant'?'gsheet-instant:':'gsheet:'),true);
 assert.equal(h.rows[0].legacy_application_details,false);assert.equal(h.rows[0].evidence,'');assert.equal(h.rows[0].third_party_damage,'');assert.equal(h.network,0);
});
test('a newly imported backdated landing lead remains a new three-field record',async()=>{
 const h=harness(),response=await h.post(baseBody({created_time:'1990-01-01T00:00:00Z'}));assert.equal(response.status,200);assert.equal(h.rows[0].created_at,'1990-01-01T00:00:00.000Z');assert.equal(h.rows[0].legacy_application_details,false);assertRetiredFieldsOmitted(h.calls.find(call=>call.action==='insert').payload);
});
test('a name/phone duplicate with complete retained fields leaves every original value unchanged',async()=>{
 const original=existing(),h=harness([original]),response=await h.post(baseBody());assert.equal(response.status,200);assert.equal((await response.json()).duplicateBy,'name_phone');assert.deepEqual(h.rows,[original]);assert.equal(h.calls.some(call=>call.action==='insert'||call.action==='update'),false);assert.equal(h.network,0);
});
test('duplicate backfill can fill missing retained fields but cannot read or overwrite historic retired answers',async()=>{
 const original=existing({collection_intensity:'',principal_amount:'',repayment_total:'',source_row_number:null}),h=harness([original]),response=await h.post(baseBody({row_number:'99'}));assert.equal(response.status,200);
 const updated=h.calls.find(call=>call.action==='update').payload;assertRetiredFieldsOmitted(updated);assert.deepEqual(Object.keys(updated).sort(),['collection_intensity','principal_amount','repayment_total','source_row_number']);
 assert.equal(h.rows[0].evidence,original.evidence);assert.equal(h.rows[0].third_party_damage,original.third_party_damage);assert.equal(h.rows[0].legacy_application_details,true);
 for(const call of h.calls.filter(call=>call.action==='select'))assert.doesNotMatch(call.columns,/\bevidence\b|\bthird_party_damage\b|\blegacy_application_details\b/);
});
test('retired answers stay empty on an old duplicate instead of being newly collected',async()=>{
 const original=existing({evidence:'',third_party_damage:''}),h=harness([original]);await h.post(baseBody());assert.deepEqual(h.rows,[original]);assert.equal(h.calls.some(call=>call.action==='update'),false);
});
test('native-ID enrichment of an old landing duplicate preserves its frozen eligibility and original answers',async()=>{
 const original=existing(),h=harness([original]),response=await h.post(baseBody({source_type:'instant',leadgen_id:'123456789012345'}));assert.equal(response.status,200);assert.equal((await response.json()).duplicateBy,'name_phone');
 const updated=h.calls.find(call=>call.action==='update').payload;assert.deepEqual(updated,{meta_native_lead_id:'123456789012345'});assert.equal(h.rows[0].legacy_application_details,true);assert.equal(h.rows[0].evidence,original.evidence);assert.equal(h.rows[0].third_party_damage,original.third_party_damage);assert.equal(h.rows[0].meta_lead_id,original.meta_lead_id);assert.equal(h.rows.length,1);
});
test('source-key duplicate conflict preserves old answers and the existing cutover marker',async()=>{
 const original=existing(),h=harness([original]),response=await h.post(baseBody({full_name:'',collection_strength:original.collection_intensity,original_principal:original.principal_amount,repayment_total:original.repayment_total}));assert.equal(response.status,200);assert.equal((await response.json()).duplicate,true);
 const updated=h.calls.find(call=>call.action==='update').payload;assertRetiredFieldsOmitted(updated);assert.equal(h.rows[0].evidence,original.evidence);assert.equal(h.rows[0].third_party_damage,original.third_party_damage);assert.equal(h.rows[0].legacy_application_details,true);assert.equal(h.rows.length,1);
});
test('repeated ingestion of a new lead cannot turn its false marker into an old-record marker',async()=>{
 const original=existing({legacy_application_details:false}),h=harness([original]);await h.post(baseBody({created_time:'1990-01-01T00:00:00Z'}));assert.equal(h.rows[0].legacy_application_details,false);assert.equal(h.rows[0].evidence,original.evidence);assert.equal(h.rows[0].third_party_damage,original.third_party_damage);
});
test('an invalid intake secret cannot reach the database or send an alert',async()=>{
 const h=harness(),response=await h.post(baseBody(),'incorrect-fixture-secret');assert.equal(response.status,401);assert.deepEqual(h.calls,[]);assert.deepEqual(h.rows,[]);assert.equal(h.network,0);
});
