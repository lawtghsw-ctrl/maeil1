/********************************************************************
 * "상담신청 불법사채" Google Sheet -> 로파워 Admin 신규DB (v3)
 *
 * 시트 1행 기준:
 * 접수일시 | 이름 | 전화번호 | 추심강도 | 대여원금 | 상환총액 | 증거보유 | 주변인피해
 *
 * - 기존 행: syncExistingLeadsToAdmin() 1회 실행
 * - 앞으로 들어오는 행: createRopowerSyncTrigger() 1회 실행
 * - 중복 방지: Spreadsheet ID + Sheet ID + 원본 행 번호
 * - 기존 행을 다시 보내도 서버에서 중복 생성하지 않음
 ********************************************************************/

const CONFIG = {
  SHEET_NAME: "상담신청 불법사채",
  ADMIN_API_URL: "https://YOUR-ROPOWER-VERCEL-DOMAIN/api/google-sheet/lead",
  ADMIN_LEAD_INGEST_SECRET: "여기에_VERCEL의_GOOGLE_SHEET_INGEST_SECRET_입력",
  MAX_PROCESS_COUNT: 500,
  REQUEST_DELAY_MS: 120,
  HEADER_ROW: 1
};

function normalizeHeader_(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\/\\_\-]/g, "")
    .replace(/[()[\]{}]/g, "");
}

function findColumn_(headers, candidates) {
  const wanted = candidates.map(normalizeHeader_);
  return headers.findIndex(function(header) {
    return wanted.includes(normalizeHeader_(header));
  });
}

function ensureColumn_(sheet, columnName) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, lastColumn).getDisplayValues()[0];
  const index = headers.findIndex(function(header) {
    return String(header || "").trim() === columnName;
  });
  if (index !== -1) return index + 1;
  const newColumn = lastColumn + 1;
  sheet.getRange(CONFIG.HEADER_ROW, newColumn).setValue(columnName);
  return newColumn;
}

function normalizePhone_(value) {
  let phone = String(value || "").trim().replace(/\D/g, "");
  if (!phone) return "";
  if (phone.startsWith("82") && phone.length >= 11) phone = "0" + phone.substring(2);
  if (phone.length === 10 && phone.startsWith("10")) phone = "0" + phone;
  if (phone.length === 11 && phone.startsWith("010")) {
    return phone.substring(0, 3) + "-" + phone.substring(3, 7) + "-" + phone.substring(7);
  }
  return phone;
}

function normalizeCreatedTime_(rawValue, displayValue) {
  if (rawValue instanceof Date && !isNaN(rawValue.getTime())) return rawValue.toISOString();
  if (displayValue) return String(displayValue).trim();
  return new Date().toISOString();
}

function validateConfig_() {
  const secret = String(CONFIG.ADMIN_LEAD_INGEST_SECRET || "").trim();
  const apiUrl = String(CONFIG.ADMIN_API_URL || "").trim();
  if (!secret || secret.indexOf("여기에_") === 0) {
    throw new Error("ADMIN_LEAD_INGEST_SECRET에 Vercel의 GOOGLE_SHEET_INGEST_SECRET 값을 입력해주세요.");
  }
  if (!apiUrl || apiUrl.includes("YOUR-ROPOWER-VERCEL-DOMAIN")) {
    throw new Error("ADMIN_API_URL에 로파워 Vercel 주소를 입력해주세요.");
  }
  return { secret: secret, apiUrl: apiUrl };
}

function getTargetSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("현재 Google Spreadsheet를 찾을 수 없습니다.");
  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error('시트 "' + CONFIG.SHEET_NAME + '"을 찾을 수 없습니다.');
  return { spreadsheet: spreadsheet, sheet: sheet };
}

function testRopowerSheetColumns() {
  const target = getTargetSheet_();
  validateConfig_();
  const headers = target.sheet
    .getRange(CONFIG.HEADER_ROW, 1, 1, target.sheet.getLastColumn())
    .getDisplayValues()[0];

  Logger.log("===== 로파워 시트 연동 점검 =====");
  Logger.log("시트명: " + CONFIG.SHEET_NAME);
  headers.forEach(function(header, index) {
    Logger.log((index + 1) + "번 컬럼: " + header);
  });
}

function syncCore_(forceResend) {
  const config = validateConfig_();
  const target = getTargetSheet_();
  const spreadsheet = target.spreadsheet;
  const sheet = target.sheet;
  const firstDataRow = CONFIG.HEADER_ROW + 1;

  if (sheet.getLastRow() < firstDataRow) {
    Logger.log("전송할 DB가 없습니다.");
    return;
  }

  const syncColumn = ensureColumn_(sheet, "ROPOWER_SYNC");
  const syncAtColumn = ensureColumn_(sheet, "ROPOWER_SYNC_AT");
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  const displayValues = sheet.getRange(CONFIG.HEADER_ROW, 1, lastRow - CONFIG.HEADER_ROW + 1, lastColumn).getDisplayValues();
  const rawValues = sheet.getRange(CONFIG.HEADER_ROW, 1, lastRow - CONFIG.HEADER_ROW + 1, lastColumn).getValues();
  const headers = displayValues[0];

  const createdTimeIndex = findColumn_(headers, ["접수일시", "접수 일시", "접수시간", "created_time", "timestamp"]);
  const nameIndex = findColumn_(headers, ["이름", "성명", "성함", "고객명", "full_name", "name"]);
  const phoneIndex = findColumn_(headers, ["전화번호", "연락처", "휴대폰", "phone_number", "phone"]);
  const collectionStrengthIndex = findColumn_(headers, ["추심강도"]);
  const originalPrincipalIndex = findColumn_(headers, ["대여원금"]);
  const repaymentTotalIndex = findColumn_(headers, ["상환총액"]);
  const evidenceHeldIndex = findColumn_(headers, ["증거보유"]);
  const surroundingDamageIndex = findColumn_(headers, ["주변인피해"]);
  const leadIdIndex = findColumn_(headers, ["id", "lead_id", "leadgen_id", "meta_lead_id"]);

  const required = [
    [createdTimeIndex, "접수일시"],
    [nameIndex, "이름"],
    [phoneIndex, "전화번호"],
    [collectionStrengthIndex, "추심강도"],
    [originalPrincipalIndex, "대여원금"],
    [repaymentTotalIndex, "상환총액"],
    [evidenceHeldIndex, "증거보유"],
    [surroundingDamageIndex, "주변인피해"]
  ];
  const missing = required.filter(function(item) { return item[0] === -1; }).map(function(item) { return item[1]; });
  if (missing.length) throw new Error("시트에서 다음 컬럼을 찾지 못했습니다: " + missing.join(", "));

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

    const fullName = String(displayRow[nameIndex] || "").trim();
    const phoneNumber = normalizePhone_(displayRow[phoneIndex]);
    if (!fullName && !phoneNumber) { skipped++; continue; }

    if (phoneNumber && String(displayRow[phoneIndex] || "").trim() !== phoneNumber) {
      sheet.getRange(rowNumber, phoneIndex + 1).setValue(phoneNumber);
    }

    const payload = {
      created_time: normalizeCreatedTime_(rawRow[createdTimeIndex], displayRow[createdTimeIndex]),
      full_name: fullName,
      phone_number: phoneNumber,
      leadgen_id: leadIdIndex >= 0 ? String(displayRow[leadIdIndex] || "").trim().replace(/^l:/i, "") : "",
      collection_strength: String(displayRow[collectionStrengthIndex] || "").trim(),
      original_principal: String(displayRow[originalPrincipalIndex] || "").trim(),
      repayment_total: String(displayRow[repaymentTotalIndex] || "").trim(),
      evidence_held: String(displayRow[evidenceHeldIndex] || "").trim(),
      surrounding_damage: String(displayRow[surroundingDamageIndex] || "").trim(),
      spreadsheet_id: spreadsheetId,
      sheet_id: sheetId,
      row_number: String(rowNumber)
    };

    try {
      const response = UrlFetchApp.fetch(config.apiUrl, {
        method: "post",
        contentType: "application/json",
        headers: { "x-ingest-secret": config.secret },
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
  Logger.log((forceResend ? "강제 재전송" : "동기화") + " 완료");
  Logger.log("처리: " + processed + "건");
  Logger.log("신규저장: " + success + "건");
  Logger.log("기존중복: " + duplicate + "건");
  Logger.log("오류: " + errorCount + "건");
  Logger.log("건너뜀: " + skipped + "건");
  Logger.log("==============================");
}

// 최초 1회 실행: 현재 시트에 이미 있는 기존 행을 전부 Admin으로 보냅니다.
function syncExistingLeadsToAdmin() {
  syncCore_(false);
}

// 1분 자동 트리거가 호출하는 함수입니다.
function syncLeadsToAdmin() {
  syncCore_(false);
}

// 테스트/복구용. OK 행까지 서버에 다시 확인 요청합니다.
// 서버가 Spreadsheet + Sheet + 행 번호로 중복 방지하므로 고객 DB가 중복 생성되지는 않습니다.
function forceResendLeadsToAdmin() {
  syncCore_(true);
}

function deleteRopowerSyncTriggers() {
  let deletedCount = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "syncLeadsToAdmin") {
      ScriptApp.deleteTrigger(trigger);
      deletedCount++;
    }
  });
  Logger.log("기존 로파워 동기화 트리거 삭제: " + deletedCount + "개");
}

// 최초 1회 실행: 이후 새 행을 1분마다 자동 수집합니다.
function createRopowerSyncTrigger() {
  deleteRopowerSyncTriggers();
  ScriptApp.newTrigger("syncLeadsToAdmin").timeBased().everyMinutes(1).create();
  Logger.log("로파워 1분 자동 동기화 트리거 생성 완료");
}
