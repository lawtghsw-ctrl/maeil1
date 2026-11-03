import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';

// Fabricated leads only. These tests use no network or production database.
const sql=fs.readFileSync(new URL('../supabase/ropower-lead-application-details.sql',import.meta.url),'utf8');
const supplement=fs.readFileSync(new URL('../supabase/ropower-lead-application-details-freeze.sql',import.meta.url),'utf8');
const source=fs.readFileSync(new URL('../components/meta-leads-v28.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('meta-leads-v28.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const detector=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='detectLeadSource');
assert.ok(detector,'Use the actual UI origin classifier for SQL parity');
const classifier={exports:{}};
vm.runInNewContext(ts.transpileModule(detector.getText(tree)+';exports.detect=detectLeadSource;',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:classifier,exports:classifier.exports});
const detect=classifier.exports.detect;
const cases=[
  {key:'gsheet:old-landing',native:'',label:'landing'},
  {key:'manual:old-manual',native:'123456',label:'manual wins even with numeric native'},
  {key:'gsheet-instant:old-instant',native:'',label:'instant prefix'},
  {key:' 123456 ',native:'',label:'trimmed numeric key'},
  {key:'legacy:numeric-native',native:' 987654 ',label:'numeric native'},
  {key:'gsheet:nonnumeric-native',native:'native-token',label:'gsheet with arbitrary native'},
  {key:'gsheet:blank-native',native:' \t\n\r\u00a0\ufeff',label:'native becomes empty after JS trim'},
  {key:'legacy:opaque',native:'opaque-native',label:'opaque legacy remains landing'},
  {key:'manual-without-colon',native:'opaque-native',label:'manual prefix must include colon'},
  {key:'gsheet-instantx:opaque',native:'',label:'instant prefix must include colon'},
  {key:'\ufeff\u2003manual:unicode\u00a0',native:'',label:'full JS Unicode trim'},
  {key:'\u2028gsheet:unicode-landing\u3000',native:'\u205f',label:'Unicode blank native'},
  {key:'１２３',native:'',label:'numeric classifier uses ASCII digits only'},
];
const databases=[];
after(()=>Promise.all(databases.map(db=>db.close())));
async function fixture(){
  const db=new PGlite();databases.push(db);
  await db.exec([
    'CREATE ROLE authenticated;',
    'CREATE TABLE public.meta_leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),meta_lead_id text UNIQUE NOT NULL,meta_native_lead_id text,created_at timestamptz NOT NULL DEFAULT now(),customer_name text NOT NULL,phone_number text NOT NULL,memo text NOT NULL DEFAULT \'\',collection_intensity text NOT NULL DEFAULT \'\',principal_amount text NOT NULL DEFAULT \'\',repayment_total text NOT NULL DEFAULT \'\',evidence text NOT NULL DEFAULT \'\',third_party_damage text NOT NULL DEFAULT \'\',raw_field_data jsonb,source_row_number integer);',
    'ALTER TABLE public.meta_leads ENABLE ROW LEVEL SECURITY;',
    'CREATE POLICY existing_lead_access ON public.meta_leads FOR ALL TO authenticated USING(true) WITH CHECK(true);',
    'GRANT SELECT,INSERT,UPDATE ON public.meta_leads TO authenticated;',
    'CREATE TABLE public.cutover_test_audit(action text NOT NULL);',
    'CREATE FUNCTION public.cutover_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.cutover_test_audit VALUES(TG_OP);RETURN NEW;END; $$;',
    'CREATE FUNCTION public.cutover_test_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.memo:=NEW.memo||\' [business trigger fired]\';RETURN NEW;END; $$;',
    'CREATE TRIGGER cutover_test_touch BEFORE UPDATE ON public.meta_leads FOR EACH ROW EXECUTE FUNCTION public.cutover_test_touch();',
    'CREATE TRIGGER cutover_test_ordinary AFTER INSERT OR UPDATE OR DELETE ON public.meta_leads FOR EACH ROW EXECUTE FUNCTION public.cutover_test_audit();',
    'CREATE TRIGGER cutover_test_replica AFTER INSERT OR UPDATE OR DELETE ON public.meta_leads FOR EACH ROW EXECUTE FUNCTION public.cutover_test_audit();',
    'CREATE TRIGGER cutover_test_always AFTER INSERT OR UPDATE OR DELETE ON public.meta_leads FOR EACH ROW EXECUTE FUNCTION public.cutover_test_audit();',
    'CREATE TRIGGER cutover_test_disabled AFTER INSERT OR UPDATE OR DELETE ON public.meta_leads FOR EACH ROW EXECUTE FUNCTION public.cutover_test_audit();',
    'ALTER TABLE public.meta_leads ENABLE REPLICA TRIGGER cutover_test_replica;',
    'ALTER TABLE public.meta_leads ENABLE ALWAYS TRIGGER cutover_test_always;',
    'ALTER TABLE public.meta_leads DISABLE TRIGGER cutover_test_disabled;',
  ].join('\n'));
  for(const [index,entry] of cases.entries()){
    await db.query('INSERT INTO public.meta_leads(meta_lead_id,meta_native_lead_id,created_at,customer_name,phone_number,memo,collection_intensity,principal_amount,repayment_total,evidence,third_party_damage,raw_field_data,source_row_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)',[
      entry.key,entry.native,index%2?'2099-01-01T03:00:00Z':'2001-01-01T03:00:00Z',
      '가상 고객 '+index,'0100000'+String(index).padStart(4,'0'),'원문 '+index,'강함','500000.25','300000.50','기존 증거 '+index,'기존 피해 '+index,JSON.stringify({original:true,index}),index+1,
    ]);
  }
  return db;
}
async function originalRows(db){return (await db.query("SELECT to_jsonb(lead)-'legacy_application_details' AS row FROM public.meta_leads lead ORDER BY id")).rows;}
async function allRows(db){return (await db.query('SELECT to_jsonb(lead) AS row FROM public.meta_leads lead ORDER BY id')).rows;}
async function audits(db){return (await db.query('SELECT count(*)::int AS count FROM public.cutover_test_audit')).rows[0].count;}
async function triggers(db){return (await db.query("SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='public.meta_leads'::regclass AND NOT tgisinternal ORDER BY tgname")).rows;}
async function permissions(db){return {
  policies:(await db.query("SELECT policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='meta_leads' ORDER BY policyname")).rows,
  table:(await db.query("SELECT relrowsecurity,relforcerowsecurity,relacl::text AS acl FROM pg_class WHERE oid='public.meta_leads'::regclass")).rows,
};}
async function marker(db,key){return (await db.query('SELECT legacy_application_details FROM public.meta_leads WHERE meta_lead_id=$1',[key])).rows[0].legacy_application_details;}
async function checkDefault(db){
  const column=(await db.query("SELECT column_default,is_nullable,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='meta_leads' AND column_name='legacy_application_details'")).rows[0];
  assert.deepEqual(column,{column_default:'false',is_nullable:'NO',data_type:'boolean'});
}
const db=await fixture();
const before=await originalRows(db),beforePermissions=await permissions(db),beforeTriggers=await triggers(db),beforeAudits=await audits(db);
await db.exec(sql);

test('fresh cutover freezes only old landing eligibility with actual UI classifier parity and no original-field or audit changes',async()=>{
  assert.deepEqual(await originalRows(db),before);
  assert.deepEqual(await permissions(db),beforePermissions);
  assert.deepEqual(await triggers(db),beforeTriggers);
  assert.equal(await audits(db),beforeAudits);
  for(const entry of cases)assert.equal(await marker(db,entry.key),detect({meta_lead_id:entry.key,meta_native_lead_id:entry.native})==='랜딩 광고',entry.label);
  await checkDefault(db);
});

test('all newly inserted routes stay ineligible independently of source dates and raw application answers',async()=>{
  const keys=['gsheet:new-landing','gsheet-instant:new-instant','123456789','manual:new-manual'];
  for(const [index,key] of keys.entries()){
    const row=(await db.query("INSERT INTO public.meta_leads(meta_lead_id,created_at,customer_name,phone_number,evidence,third_party_damage) VALUES($1,$2,'가상 신규 고객','01000000004','신규 원문 증거','신규 원문 피해') RETURNING legacy_application_details,evidence,third_party_damage",[key,index%2?'2099-01-01T00:00:00Z':'1990-01-01T00:00:00Z'])).rows[0];
    assert.equal(row.legacy_application_details,false,key);assert.equal(row.evidence,'신규 원문 증거');assert.equal(row.third_party_damage,'신규 원문 피해');
  }
});

test('duplicate native enrichment preserves the frozen landing marker, and both scripts remain inert on reruns',async()=>{
  const key='gsheet:old-landing';
  const answers=(await db.query('SELECT evidence,third_party_damage,raw_field_data FROM public.meta_leads WHERE meta_lead_id=$1',[key])).rows[0];
  await db.query("UPDATE public.meta_leads SET meta_native_lead_id='987654321',memo='중복 수신 메모',created_at='1980-01-01T00:00:00Z' WHERE meta_lead_id=$1",[key]);
  assert.equal(detect({meta_lead_id:key,meta_native_lead_id:'987654321'}),'인스턴트 양식');
  await db.query("INSERT INTO public.meta_leads(meta_lead_id,customer_name,phone_number,memo) VALUES($1,'가상 중복','01000000000','중복수신') ON CONFLICT(meta_lead_id) DO UPDATE SET memo=excluded.memo",[key]);
  assert.equal(await marker(db,key),true);
  assert.deepEqual((await db.query('SELECT evidence,third_party_damage,raw_field_data FROM public.meta_leads WHERE meta_lead_id=$1',[key])).rows[0],answers);
  const snapshot=await allRows(db),auditCount=await audits(db),states=await triggers(db);
  await db.exec(sql);await db.exec(supplement);await db.exec(sql);await db.exec(supplement);
  assert.deepEqual(await allRows(db),snapshot);assert.equal(await audits(db),auditCount);assert.deepEqual(await triggers(db),states);
  await checkDefault(db);
});

test('supplement normalizes the older all-true deployment once without field, audit, permission or trigger changes',async()=>{
  const legacy=await fixture();
  await legacy.exec("ALTER TABLE public.meta_leads ADD COLUMN legacy_application_details boolean NOT NULL DEFAULT true;ALTER TABLE public.meta_leads ALTER COLUMN legacy_application_details SET DEFAULT false;COMMENT ON COLUMN public.meta_leads.legacy_application_details IS 'Display only when true AND landing (old marker)';");
  await legacy.exec("INSERT INTO public.meta_leads(meta_lead_id,created_at,customer_name,phone_number) VALUES('gsheet:between-cutovers','1970-01-01T00:00:00Z','두 작업 사이 신규','01000000007');");
  const original=await originalRows(legacy),access=await permissions(legacy),states=await triggers(legacy),auditCount=await audits(legacy);
  // Rerunning fresh-install SQL must not falsely mark the old installation v2.
  await legacy.exec(sql);
  assert.ok(await marker(legacy,'manual:old-manual'));
  await legacy.exec(supplement);
  assert.deepEqual(await originalRows(legacy),original);assert.deepEqual(await permissions(legacy),access);assert.deepEqual(await triggers(legacy),states);assert.equal(await audits(legacy),auditCount);
  for(const entry of cases)assert.equal(await marker(legacy,entry.key),detect({meta_lead_id:entry.key,meta_native_lead_id:entry.native})==='랜딩 광고',entry.label);
  assert.equal(await marker(legacy,'gsheet:between-cutovers'),false);
  await legacy.query("UPDATE public.meta_leads SET meta_native_lead_id='100000' WHERE meta_lead_id='gsheet:old-landing'");
  await legacy.query("UPDATE public.meta_leads SET meta_lead_id='legacy:renamed-instant' WHERE meta_lead_id='gsheet-instant:old-instant'");
  const frozen=await allRows(legacy),frozenAudits=await audits(legacy);
  await legacy.exec(supplement);await legacy.exec(sql);await legacy.exec(supplement);
  assert.equal(await marker(legacy,'gsheet:old-landing'),true);
  assert.equal(await marker(legacy,'legacy:renamed-instant'),false);
  assert.deepEqual(await allRows(legacy),frozen);assert.equal(await audits(legacy),frozenAudits);await checkDefault(legacy);
  assert.equal((await legacy.query("INSERT INTO public.meta_leads(meta_lead_id,created_at,customer_name,phone_number) VALUES('gsheet:after-rerun','1990-01-01T00:00:00Z','재실행 후 신규','01000000008') RETURNING legacy_application_details")).rows[0].legacy_application_details,false);
});

test('an original-field regression aborts the whole cutover and restores the original trigger modes',async()=>{
  const broken=await fixture(),original=await originalRows(broken),states=await triggers(broken),auditCount=await audits(broken);
  const endHash=sql.lastIndexOf('  SELECT md5(');assert.ok(endHash>0);
  const invalid=sql.slice(0,endHash)+"  UPDATE public.meta_leads SET memo='deliberate business-field regression';\n"+sql.slice(endHash);
  await assert.rejects(broken.exec(invalid),/Original lead fields changed/);
  await broken.exec('ROLLBACK');
  assert.deepEqual(await originalRows(broken),original);assert.deepEqual(await triggers(broken),states);assert.equal(await audits(broken),auditCount);
  assert.equal((await broken.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='meta_leads' AND column_name='legacy_application_details'")).rows[0].count,0);
});
