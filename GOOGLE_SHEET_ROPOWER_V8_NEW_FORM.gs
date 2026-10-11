/**
 * 로파워 사채 어드민 V8.0 전용 / 신규 Meta 인스턴트 양식 → Sheet → Admin
 * 기존 DB는 최초 활성화 시 모두 건너뜁니다. 절대로 과거 행을 일괄 전송하지 않습니다.
 * Script Properties로 ROP_ADMIN_URL / ROP_INGEST_SECRET 값을 설정하세요.
 * 사용: setupRopowerNewFormSync() 1회 → 매분 syncRopowerNewForm() 자동 수행
 */
const ROP_V8 = { SHEET_NAME: '', HEADER_ROW: 1, BATCH: 50 };
const ROP_CURSOR_PREFIX = 'ROP_V8_CURSOR_';
function ropHeader_(x){return String(x||'').toLowerCase().replace(/[\s_\-()]/g,'');}
function ropColumn_(headers, names){
 const norm = names.map(ropHeader_);
 return headers.findIndex(h=>norm.includes(ropHeader_(h)));
}
function ropTarget_(){
 const ss=SpreadsheetApp.getActiveSpreadsheet();
 const sheet=ROP_V8.SHEET_NAME?ss.getSheetByName(ROP_V8.SHEET_NAME):ss.getActiveSheet();
 if(!sheet)throw Error('시트를 찾을 수 없습니다. SHEET_NAME을 확인하세요.');
 return {ss,sheet,key:ROP_CURSOR_PREFIX+ss.getId()+'_'+sheet.getSheetId()};
}
function ropConfig_(){
 const props=PropertiesService.getScriptProperties();
 const url=String(props.getProperty('ROP_ADMIN_URL')||'').trim();
 const secret=String(props.getProperty('ROP_INGEST_SECRET')||'').trim();
 if(!/^https:\/\//.test(url)||!url.endsWith('/api/google-sheet/lead')||!secret)throw Error('스크립트 속성 ROP_ADMIN_URL / ROP_INGEST_SECRET을 설정하세요.');
 return {url,secret};
}
function setupRopowerNewFormSync(){
 ropConfig_();
 const t=ropTarget_(); const props=PropertiesService.getScriptProperties();
 if(props.getProperty(t.key)===null)props.setProperty(t.key,String(t.sheet.getLastRow()));
 ScriptApp.getProjectTriggers().filter(x=>x.getHandlerFunction()==='syncRopowerNewForm').forEach(x=>ScriptApp.deleteTrigger(x));
 ScriptApp.newTrigger('syncRopowerNewForm').timeBased().everyMinutes(1).create();
 Logger.log('활성화 완료. 기존 '+props.getProperty(t.key)+'행까지 건너뜀. 신규 행부터 자동 전송.');
}
function syncRopowerNewForm(){
 const config=ropConfig_();const t=ropTarget_();
 const props=PropertiesService.getScriptProperties();const saved=props.getProperty(t.key);
 if(saved===null)throw Error('setupRopowerNewFormSync()를 먼저 실행하세요.');
 const last=t.sheet.getLastRow();let cursor=Number(saved);
 if(last<=cursor)return;
 const lastCol=t.sheet.getLastColumn();
 const headers=t.sheet.getRange(ROP_V8.HEADER_ROW,1,1,lastCol).getDisplayValues()[0];
 const map={
  created_time:ropColumn_(headers,['created_time','접수일시','접수시간','timestamp']),
  full_name:ropColumn_(headers,['full_name','이름','성명','고객명']),
  phone_number:ropColumn_(headers,['phone_number','phone','전화번호','휴대폰','연락처']),
  leadgen_id:ropColumn_(headers,['id','lead_id','leadgen_id','meta_lead_id']),
  collection_strength:ropColumn_(headers,['추심강도','collection_strength']),
  original_principal:ropColumn_(headers,['대여원금','original_principal']),
  repayment_total:ropColumn_(headers,['상환총액','repayment_total']),
  evidence_held:ropColumn_(headers,['증거보유','evidence_held']),
  surrounding_damage:ropColumn_(headers,['주변인피해','surrounding_damage'])
 };
 if(map.full_name<0&&map.phone_number<0)throw Error('시트에 이름 또는 연락처 열이 없습니다.');
 for(let row=cursor+1;row<=Math.min(last,cursor+ROP_V8.BATCH);row++){
  const raw=t.sheet.getRange(row,1,1,lastCol).getValues()[0];
  const cells=t.sheet.getRange(row,1,1,lastCol).getDisplayValues()[0];
  const val=key=>map[key]<0?'':String(cells[map[key]]||'').trim();
  const payload={
   created_time:map.created_time>=0&&raw[map.created_time] instanceof Date?raw[map.created_time].toISOString():(val('created_time')||new Date().toISOString()),
   full_name:val('full_name'),phone_number:val('phone_number'),leadgen_id:val('leadgen_id').replace(/^l:/i,''),
   collection_strength:val('collection_strength'),original_principal:val('original_principal'),
   repayment_total:val('repayment_total'),evidence_held:val('evidence_held'),surrounding_damage:val('surrounding_damage'),
   spreadsheet_id:t.ss.getId(),sheet_id:String(t.sheet.getSheetId()),row_number:String(row)
  };
  if(!payload.full_name&&!payload.phone_number){props.setProperty(t.key,String(row));continue;}
  const response=UrlFetchApp.fetch(config.url,{method:'post',contentType:'application/json',headers:{'x-ingest-secret':config.secret},payload:JSON.stringify(payload),muteHttpExceptions:true});
  const status=response.getResponseCode();
  if(status<200||status>=300){Logger.log('행 '+row+' 오류 '+status+' '+response.getContentText().slice(0,250));break;}
  props.setProperty(t.key,String(row));
  Logger.log('행 '+row+' 완료 '+response.getContentText().slice(0,150));
 }
}
