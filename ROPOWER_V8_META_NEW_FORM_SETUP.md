# 로파워 사채 어드민 V8.0 — 신규 양식 연동

기준: 전달된 `maeil1.zip` 내 V7.9 전체본. 도원 연동은 포함하지 않습니다.

## 기존 소스 확인 결과
- `/api/google-sheet/lead`: 시트 리드 수신 및 중복 검사 구현되어 있음.
- `/api/meta/crm-event`: CRM 이벤트 전송 구현되어 있음.
- 신규 DB 상태, 수기 DB, 전자계약 등 V7.9 기능을 유지함.

## 이번 보완
- 신규 양식의 질문 열이 달라져도 이름/연락처로 입고할 수 있는 독립 Apps Script 추가.
- 최초 활성화 시 기존 시트 행은 자동 제외. 신규 행부터 1분마다 수집.
- 수기 DB, 출처 불명 DB, 허수 DB의 Meta CAPI 전송을 서버에서도 차단.
- Meta CAPI 설정 누락을 전송 성공으로 취급하지 않도록 HTTP 503 반환.
- Meta 직접 Webhook은 `META_APP_SECRET` 없이 수신하지 않음(서명 검증 필수).

## 설치 순서
1. Vercel에 로파워용 `GOOGLE_SHEET_INGEST_SECRET`, `META_CRM_DATASET_ID`, `META_CRM_ACCESS_TOKEN` 설정. 기존 값이 있다면 교체하지 말고 현재 로파워 연동 값을 확인.
2. 신규 인스턴트 양식의 전용 Google Sheet에 `GOOGLE_SHEET_ROPOWER_V8_NEW_FORM.gs`를 Apps Script로 추가 (동일한 이름의 기존 함수와 충돌 없음).
3. Apps Script > 프로젝트 설정 > 스크립트 속성에 `ROP_ADMIN_URL`=`https://로파워배포도메인/api/google-sheet/lead`, `ROP_INGEST_SECRET`=Vercel의 GOOGLE_SHEET_INGEST_SECRET와 동일한 값 설정. 키를 채팅에 공유하지 않음.
4. `ROP_V8.SHEET_NAME`에 실제 시트 탭 이름 입력 (비워 두면 활성 시트). `setupRopowerNewFormSync` 1회 실행.
5. Meta 테스트 리드 1개 생성 후 1분 내 신규 DB 입고 확인. 상태를 유효리드로 변경하여 Meta 이벤트 관리자 테스트 이벤트 확인.
6. 테스트 완료 후 `META_CRM_TEST_EVENT_CODE`는 필요에 따라 제거하고 Vercel 재배포.

## 주의사항
- 신규 시트 필수 열: `full_name` 또는 `phone_number`, 권장 열: `created_time`, `id`(Meta lead ID). Meta 매칭률을 위해 `id`를 반드시 보존하세요.
- 질문 열 `추심강도`, `대여원금`, `상환총액`, `증거보유`, `주변인피해`는 존재할 때만 가져옵니다. 새로운 질문이 있으면 추가 매핑 작업이 필요합니다.
- 이름+전화번호가 동일한 서로 다른 행은 기존 API 정책상 중복 처리됩니다. 반복 신청을 별도 DB로 관리하려면 중복 정책 별도 변경 필요.
- 실제 Meta 수신 확인은 배포/환경변수/연동 계정이 있어야 가능합니다. 이 ZIP만으로 외부 계정 연결이 끝나는 것은 아닙니다.
- 이번 변경에는 Supabase SQL 실행이 필요하지 않습니다.
