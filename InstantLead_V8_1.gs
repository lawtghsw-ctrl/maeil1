/**
 * 로파워 사채 어드민 — Meta 인스턴트 양식 연동 전용
 * 기존 랜딩 Code.gs 및 syncNewLeads 트리거는 변경하지 않습니다.
 * 기존 InstantLead.gs 내용 전체를 이 파일 내용으로 교체하세요.
 *
 * 스크립트 속성 (비밀 값은 로그에 남기지 않음):
 *   ROP_INSTANT_ADMIN_URL=https://maeil1.vercel.app/api/google-sheet/lead
 *   ROP_INSTANT_INGEST_SECRET=Vercel GOOGLE_SHEET_INGEST_SECRET 과 동일한 값
 *
 * 최초 설정이 이미 끝났다면 setupRopowerInstantLead()를 다시 실행할 필요가 없습니다.
 * 진단: inspectRopowerInstantLead() / retryRopowerInstantRow36()
 * 자동 동기화: syncRopowerInstantLead() (기존 1분 트리거 사용)
 */
const ROP_INSTANT_CFG = Object.freeze({
  sheetName: '사채인증DB',
  headerRow: 1,
  batchSize: 40,
  cursorPrefix: 'ROP_INSTANT_LAST_ROW_',
});

function ropInstantNormalize_(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC').toLowerCase().replace(/[\s_\\()[\]{}?？.,·:!\-\/]+/g, '');
}
function ropInstantColumn_(headers, aliases) {
  const normalizedAliases = aliases.map(ropInstantNormalize_);
  return headers.findIndex(h => normalizedAliases.includes(ropInstantNormalize_(h)));
}
function ropInstantSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw Error('스프레드시트에 연결된 Apps Script에서 실행해야 합니다.');
  const sheet = ss.getSheetByName(ROP_INSTANT_CFG.sheetName);
  if (!sheet) throw Error('사채인증DB 탭을 찾지 못했습니다.');
  return { ss, sheet, cursorKey: ROP_INSTANT_CFG.cursorPrefix + ss.getId() + '_' + sheet.getSheetId() };
}
function ropInstantConnection_() {
  const props = PropertiesService.getScriptProperties();
  const url = String(props.getProperty('ROP_INSTANT_ADMIN_URL') || '').trim().replace(/\/+$/, '');
  const secret = String(props.getProperty('ROP_INSTANT_INGEST_SECRET') || '').trim();
  if (!/^https:\/\/[^/]+\/api\/google-sheet\/lead$/.test(url)) {
    throw Error('ROP_INSTANT_ADMIN_URL은 https://도메인/api/google-sheet/lead 전체 주소여야 합니다.');
  }
  if (!secret) throw Error('ROP_INSTANT_INGEST_SECRET이 비어 있습니다.');
  return { url, secret };
}

/** 설정 초기화. 이미 설정된 커서는 변경하지 않습니다. */
function setupRopowerInstantLead() {
  ropInstantConnection_();
  const target = ropInstantSheet_();
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(target.cursorKey) === null) {
    props.setProperty(target.cursorKey, String(Math.max(ROP_INSTANT_CFG.headerRow, target.sheet.getLastRow())));
  }
  const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncRopowerInstantLead');
  if (!triggers.length) {
    ScriptApp.newTrigger('syncRopowerInstantLead').timeBased().everyMinutes(1).create();
  }
  Logger.log('설정 확인: 마지막 처리 행=' + props.getProperty(target.cursorKey) + ', 시트 마지막 행=' + target.sheet.getLastRow() + ', 전용 트리거=' + (triggers.length || 1) + '개');
}

function ropInstantColumns_(sheet) {
  const headers = sheet.getRange(ROP_INSTANT_CFG.headerRow, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const columns = {
    id: ropInstantColumn_(headers, ['id', 'lead_id', 'leadgen_id']),
    created: ropInstantColumn_(headers, ['created_time']),
    name: ropInstantColumn_(headers, ['full_name']),
    phone: ropInstantColumn_(headers, ['phone_number']),
    threats: ropInstantColumn_(headers, ['현재_독촉/협박/추심_행위가_발생하고_있나요?_']),
    remaining: ropInstantColumn_(headers, ['현재_남은_원금_(현재_갚아야_할_돈)_']),
    borrowed: ropInstantColumn_(headers, ['대략_현재까지_총_빌린_금액_(입금_받았던_총_금액)_']),
    repaid: ropInstantColumn_(headers, ['대략_현재까지_총_갚은_금액_(보낸_총_금액)']),
  };
  if (columns.name < 0 || columns.phone < 0 || columns.created < 0 || columns.id < 0) {
    throw Error('필수 컬럼 id / created_time / full_name / phone_number를 확인하세요.');
  }
  return columns;
}

function ropInstantSendRow_(target, conn, columns, rowNumber) {
  const cells = target.sheet.getRange(rowNumber, 1, 1, target.sheet.getLastColumn()).getDisplayValues()[0];
  const v = key => columns[key] < 0 ? '' : String(cells[columns[key]] || '').trim();
  const name = v('name');
  const phone = v('phone');
  const leadId = v('id').replace(/^l:/i, '');
  if (!name && !phone && !leadId) {
    Logger.log('행 ' + rowNumber + ': 빈 행 — 커서 이동하지 않음');
    return false;
  }
  if (!leadId || !phone || !name || !v('created')) {
    Logger.log('행 ' + rowNumber + ': 필수 값 누락 — lead ID=' + !!leadId + ', 이름=' + !!name + ', 전화=' + !!phone + ', 생성시각=' + !!v('created') + '. 커서 유지');
    return false;
  }
  const payload = {
    created_time: v('created'),
    full_name: name,
    phone_number: phone,
    leadgen_id: leadId,
    source_type: "instant",
    collection_strength: v('threats'),
    original_principal: v('remaining'),
    repayment_total: v('repaid'),
    total_borrowed_amount: v('borrowed'), // 현 API에 별도 저장 필드 없음
    spreadsheet_id: target.ss.getId(),
    sheet_id: String(target.sheet.getSheetId()),
    row_number: String(rowNumber),
  };
  let response;
  try {
    response = UrlFetchApp.fetch(conn.url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-ingest-secret': conn.secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
  } catch (err) {
    Logger.log('행 ' + rowNumber + ': 요청 실패 — ' + String(err));
    return false;
  }
  const status = response.getResponseCode();
  const raw = response.getContentText();
  // 서버 응답에 고객 이름, 번호 등이 포함될 수 있어 전체 본문 대신 검증된 상태 필드만 출력
  let result;
  try { result = JSON.parse(raw); } catch (_) {
    Logger.log('행 ' + rowNumber + ': HTTP ' + status + ' / JSON 아님 (앞부분): ' + raw.slice(0, 120));
    return false;
  }
  if (status < 200 || status >= 300 || !result || result.ok !== true) {
    Logger.log('행 ' + rowNumber + ': HTTP ' + status + ' / 오류=' + String(result && (result.error || result.message) || '응답 확인 필요').slice(0, 250));
    return false;
  }
  if (result.saved === true) {
    Logger.log('행 ' + rowNumber + ': HTTP ' + status + ' / 신규 저장 성공');
    return true;
  }
  if (result.duplicate === true) {
    Logger.log('행 ' + rowNumber + ': HTTP ' + status + ' / 기존 DB 중복 처리 (방식=' + String(result.duplicateBy || 'source_key') + ', 기존 ID=' + String(result.id || '미제공') + ')');
    return true; // 실제 어드민 DB가 존재한다고 서버가 확인한 경우
  }
  Logger.log('행 ' + rowNumber + ': HTTP ' + status + ' / 저장 여부가 불명확한 응답 — 커서 유지');
  return false;
}

/** 안전한 수동/자동 동기화. 실제 저장 또는 중복 확인 성공 시에만 커서 이동. */
function syncRopowerInstantLead() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { Logger.log('이미 다른 동기화 실행 중입니다.'); return; }
  try {
    const conn = ropInstantConnection_();
    const target = ropInstantSheet_();
    const props = PropertiesService.getScriptProperties();
    const saved = props.getProperty(target.cursorKey);
    if (saved === null) throw Error('setupRopowerInstantLead 함수를 먼저 실행하세요.');
    const cursor = Number(saved);
    if (!Number.isSafeInteger(cursor) || cursor < ROP_INSTANT_CFG.headerRow) throw Error('커서가 잘못되었습니다.');
    const lastRow = target.sheet.getLastRow();
    Logger.log('동기화 시작: 커서=' + cursor + ', 시트 마지막 행=' + lastRow);
    if (lastRow <= cursor) { Logger.log('전송할 신규 행 없음'); return; }
    const columns = ropInstantColumns_(target.sheet);
    const end = Math.min(lastRow, cursor + ROP_INSTANT_CFG.batchSize);
    for (let row = cursor + 1; row <= end; row++) {
      if (!ropInstantSendRow_(target, conn, columns, row)) {
        Logger.log('행 ' + row + ': 처리 중단. 다음 실행에서 재시도');
        break;
      }
      props.setProperty(target.cursorKey, String(row));
    }
    Logger.log('동기화 종료: 최종 커서=' + props.getProperty(target.cursorKey));
  } finally {
    lock.releaseLock();
  }
}

/** 전송 없이 현 상태 확인. 비밀키와 개인정보는 출력하지 않습니다. */
function inspectRopowerInstantLead() {
  const target = ropInstantSheet_();
  const cursor = PropertiesService.getScriptProperties().getProperty(target.cursorKey);
  const count = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncRopowerInstantLead').length;
  Logger.log('시트=' + ROP_INSTANT_CFG.sheetName + ', 마지막 행=' + target.sheet.getLastRow() + ', 커서=' + cursor + ', 전용 트리거=' + count + '개');
  Logger.log('필수 열 위치=' + JSON.stringify(ropInstantColumns_(target.sheet)));
}

/** 36행 단건 진단/재전송: 커서는 변경하지 않음. 이미 저장된 DB는 서버에서 중복 처리. */
function retryRopowerInstantRow36() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { Logger.log('이미 동기화 실행 중입니다.'); return; }
  try {
    const target = ropInstantSheet_();
    if (target.sheet.getLastRow() < 36) throw Error('36행이 존재하지 않습니다.');
    const success = ropInstantSendRow_(target, ropInstantConnection_(), ropInstantColumns_(target.sheet), 36);
    Logger.log('36행 단건 진단 결과=' + (success ? '서버 저장/중복 확인됨' : '저장 확인 실패') + ' (커서 변경 없음)');
  } finally { lock.releaseLock(); }
}
