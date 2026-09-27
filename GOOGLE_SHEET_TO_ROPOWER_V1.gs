/********************************************************************
 * Meta Instant Form -> Google Sheet -> 로파워 Admin 신규DB (v18)
 *
 * 기존/자동 트리거 함수: syncLeadsToAdmin
 * 수동 테스트/강제 재전송 함수: forceResendLeadsToAdmin
 *
 * 중요:
 * - 자동 트리거는 ADMIN_SYNC=OK 행을 건너뜁니다.
 * - syncLeadsToAdmin은 ADMIN_SYNC=OK 행을 건너뜁니다.
 * - forceResendLeadsToAdmin은 OK 행도 다시 Admin에 확인 요청합니다.
 *   이미 존재하는 리드는 서버에서 duplicate 처리되고 Lead ID가 비어 있으면 백필합니다.
 ********************************************************************/

const CONFIG = {
  SHEET_NAME: "여기에_새_시트탭명",
  ADMIN_API_URL: "https://YOUR-NEW-VERCEL-DOMAIN/api/google-sheet/lead",
  ADMIN_LEAD_INGEST_SECRET: "여기에_VERCEL_SECRET_입력",
  MAX_PROCESS_COUNT: 500,
  REQUEST_DELAY_MS: 120,
  HEADER_ROW: 1
};

function normalizeHeader_(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "").replace(/[_\-]/g, "").replace(/[()[\]{}]/g, "");
}

function findColumn_(headers, candidates) {
  const wanted = candidates.map(normalizeHeader_);
  return headers.findIndex(function(header) { return wanted.includes(normalizeHeader_(header)); });
}

function ensureColumn_(sheet, columnName) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, lastColumn).getDisplayValues()[0];
  const index = headers.findIndex(function(header) { return String(header || "").trim() === columnName; });
  if (index !== -1) return index + 1;
  const newColumn = lastColumn + 1;
  sheet.getRange(CONFIG.HEADER_ROW, newColumn).setValue(columnName);
  return newColumn;
}

function normalizePhone_(value) {
  let phone = String(value || "").trim().replace(/\D/g, "");
  if (!phone) return "";
  if (phone.startsWith("82") && phone.length >= 11) phone = "0" + phone.substring(2);
  // Google Sheet가 숫자로 저장하면서 010의 첫 0을 제거한 경우 복원
  if (phone.length === 10 && phone.startsWith("10")) phone = "0" + phone;
  if (phone.length === 11 && phone.startsWith("010")) {
    return phone.substring(0, 3) + "-" + phone.substring(3, 7) + "-" + phone.substring(7);
  }
  return phone;
}

function normalizeLeadId_(value) {
  let leadId = String(value || "").trim();
  if (!leadId) return "";
  // Meta 네이티브 Google Sheets 연동에서 Lead ID가 `l:123...` 형태로 내려오는 경우가 있어
  // CRM CAPI에서 사용할 수 있도록 접두사만 제거하고 실제 숫자 ID는 그대로 보존합니다.
  if (/^l:/i.test(leadId)) leadId = leadId.replace(/^l:/i, "").trim();
  return leadId;
}

function normalizeCreatedTime_(rawValue, displayValue) {
  if (rawValue instanceof Date && !isNaN(rawValue.getTime())) return rawValue.toISOString();
  if (displayValue) return String(displayValue).trim();
  return new Date().toISOString();
}

function validateSecret_() {
  const secret = String(CONFIG.ADMIN_LEAD_INGEST_SECRET || "").trim();
  if (!secret || secret === "여기에_VERCEL_SECRET_입력") throw new Error("CONFIG.ADMIN_LEAD_INGEST_SECRET에 Vercel의 GOOGLE_SHEET_INGEST_SECRET 값을 입력해주세요.");
  return secret;
}

function getTargetSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("현재 Google Spreadsheet를 찾을 수 없습니다.");
  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error('시트 "' + CONFIG.SHEET_NAME + '"을 찾을 수 없습니다.');
  return { spreadsheet: spreadsheet, sheet: sheet };
}

function testAdminLeadSettings() {
  const target = getTargetSheet_();
  validateSecret_();
  Logger.log("===== Admin 연동 설정 확인 =====");
  Logger.log("시트명: " + CONFIG.SHEET_NAME);
  Logger.log("시트 존재: " + Boolean(target.sheet));
  Logger.log("API URL: " + CONFIG.ADMIN_API_URL);
  Logger.log("Secret 존재: true");
  Logger.log("기본 설정 정상");
}

function testSheetColumns() {
  const target = getTargetSheet_();
  const headers = target.sheet.getRange(CONFIG.HEADER_ROW, 1, 1, target.sheet.getLastColumn()).getDisplayValues()[0];
  Logger.log("===== 시트 컬럼 =====");
  headers.forEach(function(header, index) { Logger.log((index + 1) + "번 컬럼: " + header); });
}

function syncCore_(forceResend) {
  const secret = validateSecret_();
  const target = getTargetSheet_();
  const spreadsheet = target.spreadsheet;
  const sheet = target.sheet;
  const firstDataRow = CONFIG.HEADER_ROW + 1;
  if (sheet.getLastRow() < firstDataRow) { Logger.log("전송할 리드가 없습니다."); return; }

  const syncColumn = ensureColumn_(sheet, "ADMIN_SYNC");
  const syncAtColumn = ensureColumn_(sheet, "ADMIN_SYNC_AT");
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const displayValues = sheet.getRange(CONFIG.HEADER_ROW, 1, lastRow - CONFIG.HEADER_ROW + 1, lastColumn).getDisplayValues();
  const rawValues = sheet.getRange(CONFIG.HEADER_ROW, 1, lastRow - CONFIG.HEADER_ROW + 1, lastColumn).getValues();
  const headers = displayValues[0];

  const createdTimeIndex = findColumn_(headers, ["created_time","created time","createdtime","timestamp","제출시간","제출 일시","접수시간","등록시간","생성시간","리드생성시간","응답시간","응답 시간","시간"]);
  const nameIndex = findColumn_(headers, ["full_name","full name","fullname","name","이름","성명","성함","고객명","이름을 입력해주세요","성함을 입력해주세요"]);
  const phoneIndex = findColumn_(headers, ["phone_number","phone number","phonenumber","phone","mobile","전화번호","전화 번호","연락처","휴대폰","휴대전화","핸드폰","연락처를 입력해주세요","전화번호를 입력해주세요"]);
  const leadIdIndex = findColumn_(headers, [
    "leadgen_id","leadgen id","lead_id","lead id","meta_lead_id","meta lead id",
    "facebook lead id","unique_lead_id","unique lead id","리드id","리드 id","메타 리드 id",
    // Meta 네이티브 Google Sheets 연동에서 Lead ID 헤더가 단순 `id`로 생성되는 경우 대응
    "id"
  ]);

  if (nameIndex === -1 && phoneIndex === -1) throw new Error("고객 이름/전화번호 컬럼을 찾지 못했습니다. testSheetColumns를 실행해 컬럼명을 확인해주세요.");

  const spreadsheetId = spreadsheet.getId();
  const sheetId = String(sheet.getSheetId());
  let processed = 0, success = 0, duplicate = 0, errorCount = 0, skipped = 0;

  for (let rowNumber = firstDataRow; rowNumber <= lastRow; rowNumber++) {
    if (processed >= CONFIG.MAX_PROCESS_COUNT) break;
    const arrayIndex = rowNumber - CONFIG.HEADER_ROW;
    const displayRow = displayValues[arrayIndex];
    const rawRow = rawValues[arrayIndex];
    const syncStatus = String(displayRow[syncColumn - 1] || "").trim().toUpperCase();
    if (!forceResend && syncStatus === "OK") { skipped++; continue; }

    const fullName = nameIndex >= 0 ? String(displayRow[nameIndex] || "").trim() : "";
    const phoneNumber = phoneIndex >= 0 ? normalizePhone_(displayRow[phoneIndex]) : "";
    // Meta가 010의 첫 0을 빼고 보내더라도 시트 자체도 010-0000-0000 형식으로 정리합니다.
    if (phoneIndex >= 0 && phoneNumber && String(displayRow[phoneIndex] || "").trim() !== phoneNumber) {
      sheet.getRange(rowNumber, phoneIndex + 1).setValue(phoneNumber);
    }
    if (!fullName && !phoneNumber) { skipped++; continue; }
    const createdTime = createdTimeIndex >= 0 ? normalizeCreatedTime_(rawRow[createdTimeIndex], displayRow[createdTimeIndex]) : new Date().toISOString();
    const leadgenId = leadIdIndex >= 0 ? normalizeLeadId_(displayRow[leadIdIndex]) : "";

    const payload = {
      created_time: createdTime,
      full_name: fullName,
      phone_number: phoneNumber,
      leadgen_id: leadgenId,
      spreadsheet_id: spreadsheetId,
      sheet_id: sheetId,
      row_number: String(rowNumber)
    };

    try {
      const response = UrlFetchApp.fetch(CONFIG.ADMIN_API_URL, {
        method: "post",
        contentType: "application/json",
        headers: { "x-ingest-secret": secret },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const statusCode = response.getResponseCode();
      const responseText = response.getContentText();
      let json = {};
      try { json = JSON.parse(responseText || "{}"); } catch (_) {}

      if (statusCode >= 200 && statusCode < 300) {
        sheet.getRange(rowNumber, syncColumn).setValue("OK");
        sheet.getRange(rowNumber, syncAtColumn).setValue(new Date());
        if (json && json.duplicate) duplicate++; else success++;
      } else {
        sheet.getRange(rowNumber, syncColumn).setValue("ERROR " + statusCode + " " + String(responseText).substring(0, 220));
        errorCount++;
      }
    } catch (error) {
      sheet.getRange(rowNumber, syncColumn).setValue("ERROR " + String(error).substring(0, 220));
      errorCount++;
    }
    processed++;
    Utilities.sleep(CONFIG.REQUEST_DELAY_MS);
  }

  Logger.log("==============================");
  Logger.log((forceResend ? "수동 강제 재전송" : "자동 동기화") + " 완료");
  Logger.log("처리: " + processed + "건 / 신규저장: " + success + "건 / 기존중복: " + duplicate + "건 / 오류: " + errorCount + "건 / 건너뜀: " + skipped + "건");
  Logger.log("==============================");
}

// 기존 자동화/일반 실행용: 이미 OK인 행은 건너뜁니다.
function syncLeadsToAdmin() { syncCore_(false); }

// 수동 테스트용: ADMIN_SYNC=OK도 다시 서버에 보냅니다.
// Admin에서 삭제한 테스트 리드는 이 함수 실행 시 다시 생성됩니다.
function forceResendLeadsToAdmin() { syncCore_(true); }

function deleteAdminSyncTriggers() {
  const names = ["syncLeadsToAdmin", "scheduledSyncLeadsToAdmin"];
  let deletedCount = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (names.includes(trigger.getHandlerFunction())) { ScriptApp.deleteTrigger(trigger); deletedCount++; }
  });
  Logger.log("기존 Admin 동기화 트리거 삭제: " + deletedCount + "개");
}

function createAdminSyncTrigger() {
  deleteAdminSyncTriggers();
  ScriptApp.newTrigger("syncLeadsToAdmin").timeBased().everyMinutes(1).create();
  Logger.log("1분 자동 동기화 트리거 생성 완료: syncLeadsToAdmin");
}

// 기존 시트의 전화번호를 한 번에 010-0000-0000 형식으로 정리할 때 1회 실행
function normalizeAllSheetPhoneNumbers() {
  const target = getTargetSheet_();
  const sheet = target.sheet;
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow <= CONFIG.HEADER_ROW) return;
  const headers = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, lastColumn).getDisplayValues()[0];
  const phoneIndex = findColumn_(headers, ["phone_number","phone number","phonenumber","phone","mobile","전화번호","전화 번호","연락처","휴대폰","휴대전화","핸드폰","연락처를 입력해주세요","전화번호를 입력해주세요"]);
  if (phoneIndex === -1) throw new Error("전화번호 컬럼을 찾지 못했습니다.");
  const range = sheet.getRange(CONFIG.HEADER_ROW + 1, phoneIndex + 1, lastRow - CONFIG.HEADER_ROW, 1);
  const values = range.getDisplayValues();
  const normalized = values.map(function(row) {
    const phone = normalizePhone_(row[0]);
    return [phone || row[0]];
  });
  range.setValues(normalized);
  Logger.log("기존 전화번호 정규화 완료: " + normalized.length + "행");
}
