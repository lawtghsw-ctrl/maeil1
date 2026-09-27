/********************************************************************
 * "상담신청 불법사채" Google Sheet -> 로파워 + 도원 동시 연동 (v4)
 *
 * 시트 1행:
 * 접수일시 | 이름 | 전화번호 | 추심강도 | 대여원금 | 상환총액 | 증거보유 | 주변인피해
 *
 * 로파워: 신규 DB(meta_leads)로 저장, 로파워에서만 CRM 상태 관리
 * 도원: DB 관리 > 타 DB(external_leads)로 저장, Meta 역전송 없음
 *
 * 기존 행: syncExistingLeadsToBoth() 1회 실행
 * 신규 행: createDualSyncTrigger() 1회 실행
 * 중복방지: Spreadsheet ID + Sheet ID + 원본 행 번호
 ********************************************************************/

const CONFIG = {
  SHEET_NAME: "상담신청 불법사채",

  // 로파워 Vercel
  ROPOWER_API_URL: "https://YOUR-ROPOWER-VERCEL-DOMAIN/api/google-sheet/lead",
  ROPOWER_SECRET: "여기에_로파워_GOOGLE_SHEET_INGEST_SECRET",

  // 도원 운영 Vercel
  DOWON_API_URL: "https://tg-m-ten.vercel.app/api/google-sheet/external-lead",
  DOWON_SECRET: "여기에_도원_EXTERNAL_SHEET_INGEST_SECRET",

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
  const values = [
    [CONFIG.ROPOWER_API_URL, "ROPOWER_API_URL", "YOUR-ROPOWER-VERCEL-DOMAIN"],
    [CONFIG.ROPOWER_SECRET, "ROPOWER_SECRET", "여기에_"],
    [CONFIG.DOWON_API_URL, "DOWON_API_URL", "YOUR-"],
    [CONFIG.DOWON_SECRET, "DOWON_SECRET", "여기에_"]
  ];
  values.forEach(function(item) {
    const value = String(item[0] || "").trim();
    if (!value || (item[2] && value.indexOf(item[2]) !== -1)) {
      throw new Error(item[1] + " 설정값을 입력해주세요.");
    }
  });
}

function getTargetSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("현재 Google Spreadsheet를 찾을 수 없습니다.");
  const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error('시트 "' + CONFIG.SHEET_NAME + '"을 찾을 수 없습니다.');
  return { spreadsheet: spreadsheet, sheet: sheet };
}

function postJson_(url, secret, payload) {
  const response = UrlFetchApp.fetch(url, {
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
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error("HTTP " + statusCode + " " + String(responseText).substring(0, 220));
  }
  return json;
}

function testDualSheetColumns() {
  validateConfig_();
  const target = getTargetSheet_();
  const headers = target.sheet
    .getRange(CONFIG.HEADER_ROW, 1, 1, target.sheet.getLastColumn())
    .getDisplayValues()[0];

  Logger.log("===== 로파워 + 도원 동시연동 점검 =====");
  Logger.log("시트명: " + CONFIG.SHEET_NAME);
  headers.forEach(function(header, index) {
    Logger.log((index + 1) + "번 컬럼: " + header);
  });
}

function syncCore_(forceResend) {
  validateConfig_();
  const target = getTargetSheet_();
  const spreadsheet = target.spreadsheet;
  const sheet = target.sheet;
  const firstDataRow = CONFIG.HEADER_ROW + 1;

  if (sheet.getLastRow() < firstDataRow) {
    Logger.log("전송할 DB가 없습니다.");
    return;
  }

  const ropowerSyncColumn = ensureColumn_(sheet, "ROPOWER_SYNC");
  const ropowerSyncAtColumn = ensureColumn_(sheet, "ROPOWER_SYNC_AT");
  const dowonSyncColumn = ensureColumn_(sheet, "DOWON_SYNC");
  const dowonSyncAtColumn = ensureColumn_(sheet, "DOWON_SYNC_AT");

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
    [createdTimeIndex, "접수일시"], [nameIndex, "이름"], [phoneIndex, "전화번호"],
    [collectionStrengthIndex, "추심강도"], [originalPrincipalIndex, "대여원금"],
    [repaymentTotalIndex, "상환총액"], [evidenceHeldIndex, "증거보유"],
    [surroundingDamageIndex, "주변인피해"]
  ];
  const missing = required.filter(function(item) { return item[0] === -1; }).map(function(item) { return item[1]; });
  if (missing.length) throw new Error("시트에서 다음 컬럼을 찾지 못했습니다: " + missing.join(", "));

  const spreadsheetId = spreadsheet.getId();
  const sheetId = String(sheet.getSheetId());
  let processed = 0;
  let ropowerOk = 0, dowonOk = 0, errorCount = 0, skipped = 0;

  for (let rowNumber = firstDataRow; rowNumber <= lastRow; rowNumber++) {
    if (processed >= CONFIG.MAX_PROCESS_COUNT) break;

    const arrayIndex = rowNumber - CONFIG.HEADER_ROW;
    const displayRow = displayValues[arrayIndex];
    const rawRow = rawValues[arrayIndex];
    const fullName = String(displayRow[nameIndex] || "").trim();
    const phoneNumber = normalizePhone_(displayRow[phoneIndex]);
    if (!fullName && !phoneNumber) { skipped++; continue; }

    if (phoneNumber && String(displayRow[phoneIndex] || "").trim() !== phoneNumber) {
      sheet.getRange(rowNumber, phoneIndex + 1).setValue(phoneNumber);
    }

    const createdTime = normalizeCreatedTime_(rawRow[createdTimeIndex], displayRow[createdTimeIndex]);
    const collectionStrength = String(displayRow[collectionStrengthIndex] || "").trim();
    const originalPrincipal = String(displayRow[originalPrincipalIndex] || "").trim();
    const repaymentTotal = String(displayRow[repaymentTotalIndex] || "").trim();
    const evidenceHeld = String(displayRow[evidenceHeldIndex] || "").trim();
    const surroundingDamage = String(displayRow[surroundingDamageIndex] || "").trim();
    const nativeLeadId = leadIdIndex >= 0 ? String(displayRow[leadIdIndex] || "").trim().replace(/^l:/i, "") : "";

    const ropowerStatus = String(displayRow[ropowerSyncColumn - 1] || "").trim().toUpperCase();
    const dowonStatus = String(displayRow[dowonSyncColumn - 1] || "").trim().toUpperCase();
    let didWork = false;

    if (forceResend || ropowerStatus !== "OK") {
      didWork = true;
      try {
        postJson_(CONFIG.ROPOWER_API_URL, CONFIG.ROPOWER_SECRET, {
          created_time: createdTime,
          full_name: fullName,
          phone_number: phoneNumber,
          leadgen_id: nativeLeadId,
          collection_strength: collectionStrength,
          original_principal: originalPrincipal,
          repayment_total: repaymentTotal,
          evidence_held: evidenceHeld,
          surrounding_damage: surroundingDamage,
          spreadsheet_id: spreadsheetId,
          sheet_id: sheetId,
          row_number: String(rowNumber)
        });
        sheet.getRange(rowNumber, ropowerSyncColumn).setValue("OK");
        sheet.getRange(rowNumber, ropowerSyncAtColumn).setValue(new Date());
        ropowerOk++;
      } catch (error) {
        sheet.getRange(rowNumber, ropowerSyncColumn).setValue("ERROR " + String(error).substring(0, 220));
        errorCount++;
      }
    }

    if (forceResend || dowonStatus !== "OK") {
      didWork = true;
      try {
        postJson_(CONFIG.DOWON_API_URL, CONFIG.DOWON_SECRET, {
          received_time: createdTime,
          full_name: fullName,
          phone_number: phoneNumber,
          collection_intensity: collectionStrength,
          principal_amount: originalPrincipal,
          repayment_total: repaymentTotal,
          evidence: evidenceHeld,
          third_party_damage: surroundingDamage,
          source_name: "로파워",
          spreadsheet_id: spreadsheetId,
          sheet_id: sheetId,
          row_number: String(rowNumber),
          raw_data: {
            "접수일시": createdTime,
            "이름": fullName,
            "전화번호": phoneNumber,
            "추심강도": collectionStrength,
            "대여원금": originalPrincipal,
            "상환총액": repaymentTotal,
            "증거보유": evidenceHeld,
            "주변인피해": surroundingDamage
          }
        });
        sheet.getRange(rowNumber, dowonSyncColumn).setValue("OK");
        sheet.getRange(rowNumber, dowonSyncAtColumn).setValue(new Date());
        dowonOk++;
      } catch (error) {
        sheet.getRange(rowNumber, dowonSyncColumn).setValue("ERROR " + String(error).substring(0, 220));
        errorCount++;
      }
    }

    if (didWork) {
      processed++;
      Utilities.sleep(CONFIG.REQUEST_DELAY_MS);
    } else {
      skipped++;
    }
  }

  Logger.log("==============================");
  Logger.log((forceResend ? "강제 재전송" : "동시 동기화") + " 완료");
  Logger.log("처리행: " + processed + "건");
  Logger.log("로파워 성공: " + ropowerOk + "건");
  Logger.log("도원 성공: " + dowonOk + "건");
  Logger.log("오류: " + errorCount + "건");
  Logger.log("건너뜀: " + skipped + "건");
  Logger.log("==============================");
}

// 기존 행 전체 + 아직 한쪽에만 전송된 행을 채웁니다.
function syncExistingLeadsToBoth() {
  syncCore_(false);
}

// 1분 트리거용
function syncLeadsToBoth() {
  syncCore_(false);
}

// 복구/백필용: 두 서버에 다시 보내도 서버에서 원본행 기준으로 중복 생성되지 않습니다.
function forceResendLeadsToBoth() {
  syncCore_(true);
}

function deleteDualSyncTriggers() {
  let deletedCount = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "syncLeadsToBoth") {
      ScriptApp.deleteTrigger(trigger);
      deletedCount++;
    }
  });
  Logger.log("기존 동시연동 트리거 삭제: " + deletedCount + "개");
}

// 최초 1회: 이후 1분마다 로파워 + 도원 동시 전송
function createDualSyncTrigger() {
  deleteDualSyncTriggers();
  ScriptApp.newTrigger("syncLeadsToBoth").timeBased().everyMinutes(1).create();
  Logger.log("로파워 + 도원 1분 자동 동기화 트리거 생성 완료");
}
