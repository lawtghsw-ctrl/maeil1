const CONFIG = {
  SHEET_NAME: "상담신청 불법사채",

  PRIMARY_API_URL: "https://maeil1.vercel.app/api/google-sheet/lead",
  PRIMARY_SECRET: "여기에_PRIMARY_SECRET",

  SECONDARY_API_URL: "https://tg-m-ten.vercel.app/api/google-sheet/external-lead",
  SECONDARY_SECRET: "여기에_SECONDARY_SECRET",

  MAX_PROCESS_COUNT: 500,
  REQUEST_DELAY_MS: 120,
  HEADER_ROW: 1,
  SECONDARY_BASELINE_PROPERTY: "SECONDARY_START_ROW"
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

function dedupeKey_(name, phone) {
  const n = String(name || "").trim().toLowerCase().replace(/\s+/g, "");
  const p = String(phone || "").replace(/\D/g, "");
  return n && p ? n + "|" + p : "";
}

function normalizeCreatedTime_(rawValue, displayValue) {
  if (rawValue instanceof Date && !isNaN(rawValue.getTime())) return rawValue.toISOString();
  if (displayValue) return String(displayValue).trim();
  return new Date().toISOString();
}

function validateConfig_() {
  const values = [
    [CONFIG.PRIMARY_API_URL, "PRIMARY_API_URL", "YOUR-"],
    [CONFIG.PRIMARY_SECRET, "PRIMARY_SECRET", "여기에_"],
    [CONFIG.SECONDARY_API_URL, "SECONDARY_API_URL", "YOUR-"],
    [CONFIG.SECONDARY_SECRET, "SECONDARY_SECRET", "여기에_"]
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

function getSecondaryStartRow_() {
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.SECONDARY_BASELINE_PROPERTY);
  const n = Number(raw || 0);
  return Number.isFinite(n) && n >= CONFIG.HEADER_ROW + 1 ? n : 0;
}

function setSecondaryStartRow_(row) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.SECONDARY_BASELINE_PROPERTY, String(row));
}

function testSheetColumns() {
  validateConfig_();
  const target = getTargetSheet_();
  const headers = target.sheet
    .getRange(CONFIG.HEADER_ROW, 1, 1, target.sheet.getLastColumn())
    .getDisplayValues()[0];
  Logger.log("===== 시트 컬럼 점검 =====");
  Logger.log("시트명: " + CONFIG.SHEET_NAME);
  headers.forEach(function(header, index) {
    Logger.log((index + 1) + "번 컬럼: " + header);
  });
}

function syncCore_(options) {
  validateConfig_();
  options = options || {};
  const forcePrimary = !!options.forcePrimary;
  const allowSecondary = options.allowSecondary !== false;
  const maxRowOverride = Number(options.maxRow || 0);

  const target = getTargetSheet_();
  const spreadsheet = target.spreadsheet;
  const sheet = target.sheet;
  const firstDataRow = CONFIG.HEADER_ROW + 1;

  if (sheet.getLastRow() < firstDataRow) {
    Logger.log("전송할 DB가 없습니다.");
    return;
  }

  const primarySyncColumn = ensureColumn_(sheet, "ROPOWER_SYNC");
  const primarySyncAtColumn = ensureColumn_(sheet, "ROPOWER_SYNC_AT");
  const secondarySyncColumn = ensureColumn_(sheet, "EXTERNAL_SYNC");
  const secondarySyncAtColumn = ensureColumn_(sheet, "EXTERNAL_SYNC_AT");

  const lastRow = maxRowOverride > 0 ? Math.min(sheet.getLastRow(), maxRowOverride) : sheet.getLastRow();
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
  const secondaryStartRow = getSecondaryStartRow_();
  const seenKeys = new Set();
  let processed = 0;
  let primaryOk = 0;
  let secondaryOk = 0;
  let duplicateCount = 0;
  let errorCount = 0;
  let skipped = 0;

  for (let rowNumber = firstDataRow; rowNumber <= lastRow; rowNumber++) {
    if (processed >= CONFIG.MAX_PROCESS_COUNT) break;

    const arrayIndex = rowNumber - CONFIG.HEADER_ROW;
    const displayRow = displayValues[arrayIndex];
    const rawRow = rawValues[arrayIndex];
    const fullName = String(displayRow[nameIndex] || "").trim();
    const phoneNumber = normalizePhone_(displayRow[phoneIndex]);

    if (!fullName && !phoneNumber) {
      skipped++;
      continue;
    }

    if (phoneNumber && String(displayRow[phoneIndex] || "").trim() !== phoneNumber) {
      sheet.getRange(rowNumber, phoneIndex + 1).setValue(phoneNumber);
    }

    const key = dedupeKey_(fullName, phoneNumber);
    if (key && seenKeys.has(key)) {
      sheet.getRange(rowNumber, primarySyncColumn).setValue("DUPLICATE");
      if (!secondaryStartRow || rowNumber >= secondaryStartRow) sheet.getRange(rowNumber, secondarySyncColumn).setValue("DUPLICATE");
      duplicateCount++;
      continue;
    }
    if (key) seenKeys.add(key);

    const createdTime = normalizeCreatedTime_(rawRow[createdTimeIndex], displayRow[createdTimeIndex]);
    const collectionStrength = String(displayRow[collectionStrengthIndex] || "").trim();
    const originalPrincipal = String(displayRow[originalPrincipalIndex] || "").trim();
    const repaymentTotal = String(displayRow[repaymentTotalIndex] || "").trim();
    const evidenceHeld = String(displayRow[evidenceHeldIndex] || "").trim();
    const surroundingDamage = String(displayRow[surroundingDamageIndex] || "").trim();
    const nativeLeadId = leadIdIndex >= 0 ? String(displayRow[leadIdIndex] || "").trim().replace(/^l:/i, "") : "";

    const primaryStatus = String(displayRow[primarySyncColumn - 1] || "").trim().toUpperCase();
    const secondaryStatus = String(displayRow[secondarySyncColumn - 1] || "").trim().toUpperCase();
    let didWork = false;

    if (forcePrimary || (primaryStatus !== "OK" && primaryStatus !== "DUPLICATE")) {
      didWork = true;
      try {
        postJson_(CONFIG.PRIMARY_API_URL, CONFIG.PRIMARY_SECRET, {
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
        sheet.getRange(rowNumber, primarySyncColumn).setValue("OK");
        sheet.getRange(rowNumber, primarySyncAtColumn).setValue(new Date());
        primaryOk++;
      } catch (error) {
        sheet.getRange(rowNumber, primarySyncColumn).setValue("ERROR " + String(error).substring(0, 220));
        errorCount++;
      }
    }

    const secondaryEligible = allowSecondary && secondaryStartRow > 0 && rowNumber >= secondaryStartRow;
    if (!secondaryEligible && secondaryStartRow > 0 && rowNumber < secondaryStartRow && secondaryStatus !== "BASELINE_SKIP") {
      sheet.getRange(rowNumber, secondarySyncColumn).setValue("BASELINE_SKIP");
    }

    if (secondaryEligible && secondaryStatus !== "OK" && secondaryStatus !== "DUPLICATE") {
      didWork = true;
      try {
        postJson_(CONFIG.SECONDARY_API_URL, CONFIG.SECONDARY_SECRET, {
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
        sheet.getRange(rowNumber, secondarySyncColumn).setValue("OK");
        sheet.getRange(rowNumber, secondarySyncAtColumn).setValue(new Date());
        secondaryOk++;
      } catch (error) {
        sheet.getRange(rowNumber, secondarySyncColumn).setValue("ERROR " + String(error).substring(0, 220));
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
  Logger.log("동기화 완료");
  Logger.log("처리행: " + processed + "건");
  Logger.log("PRIMARY 성공: " + primaryOk + "건");
  Logger.log("SECONDARY 성공: " + secondaryOk + "건");
  Logger.log("중복 제외: " + duplicateCount + "건");
  Logger.log("오류: " + errorCount + "건");
  Logger.log("건너뜀: " + skipped + "건");
  Logger.log("==============================");
}

// 최초 1회 실행:
// 현재 시트에 이미 있는 행은 PRIMARY에만 강제 백필하고,
// SECONDARY는 이 실행 이후 새로 추가되는 행부터 전송합니다.
function initializeExistingAndFutureSync() {
  validateConfig_();
  const target = getTargetSheet_();
  const sheet = target.sheet;
  const firstDataRow = CONFIG.HEADER_ROW + 1;
  const lastExistingRow = sheet.getLastRow();
  const secondaryStartRow = Math.max(firstDataRow, lastExistingRow + 1);
  setSecondaryStartRow_(secondaryStartRow);

  const secondarySyncColumn = ensureColumn_(sheet, "EXTERNAL_SYNC");
  const secondarySyncAtColumn = ensureColumn_(sheet, "EXTERNAL_SYNC_AT");
  ensureColumn_(sheet, "ROPOWER_SYNC");
  ensureColumn_(sheet, "ROPOWER_SYNC_AT");

  if (lastExistingRow >= firstDataRow) {
    const count = lastExistingRow - firstDataRow + 1;
    sheet.getRange(firstDataRow, secondarySyncColumn, count, 1).setValue("BASELINE_SKIP");
    sheet.getRange(firstDataRow, secondarySyncAtColumn, count, 1).setValue(new Date());
    syncCore_({forcePrimary:true, allowSecondary:false, maxRow:lastExistingRow});
  }

  createSyncTrigger();
  Logger.log("초기 설정 완료. SECONDARY 시작 행: " + secondaryStartRow);
}

function syncNewLeads() {
  syncCore_({forcePrimary:false, allowSecondary:true});
}

// PRIMARY에 기존 데이터가 빠졌을 때만 수동 실행합니다.
function forcePrimaryBackfill() {
  syncCore_({forcePrimary:true, allowSecondary:false});
}

function deleteSyncTriggers() {
  let deletedCount = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "syncNewLeads") {
      ScriptApp.deleteTrigger(trigger);
      deletedCount++;
    }
  });
  Logger.log("기존 자동 동기화 트리거 삭제: " + deletedCount + "개");
}

function createSyncTrigger() {
  if (!getSecondaryStartRow_()) {
    const target = getTargetSheet_();
    setSecondaryStartRow_(target.sheet.getLastRow() + 1);
  }
  deleteSyncTriggers();
  ScriptApp.newTrigger("syncNewLeads").timeBased().everyMinutes(1).create();
  Logger.log("1분 자동 동기화 트리거 생성 완료");
}
