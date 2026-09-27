# 로파워 v4 / Google Sheet + 도원 동시연동

## 시트
- 시트명: `상담신청 불법사채`
- 1행: `접수일시 | 이름 | 전화번호 | 추심강도 | 대여원금 | 상환총액 | 증거보유 | 주변인피해`

## 로파워 변경
- 5개 상담 추가정보는 메모가 아니라 `meta_leads` 전용 컬럼에 저장됩니다.
- 신규 DB PC 표 / 모바일 카드에 직접 표시됩니다.
- 고객정보등록 시 5개 항목을 고객 메모로 자동 복사하지 않습니다.

## 배포 순서
1. 로파워 Supabase에 `supabase/05_ROPOWER_LEAD_INTAKE_FIELDS_V4.sql` 1회 실행
2. v4 소스를 GitHub에 push하고 Vercel 재배포
3. 도원 v25 설치/배포 후 도원 Vercel에 `EXTERNAL_SHEET_INGEST_SECRET` 추가
4. Google Sheet Apps Script에 `GOOGLE_SHEET_TO_ROPOWER_AND_DOWON_V4.gs` 붙여넣기
5. 로파워 Vercel URL / 로파워 `GOOGLE_SHEET_INGEST_SECRET` 입력
6. 도원 `EXTERNAL_SHEET_INGEST_SECRET` 입력
7. `testDualSheetColumns()` 실행
8. `syncExistingLeadsToBoth()` 실행: 기존 행 전체 동기화
9. `createDualSyncTrigger()` 실행: 이후 1분마다 신규행 자동 동기화

## 시트에 자동 추가되는 열
- `ROPOWER_SYNC`
- `ROPOWER_SYNC_AT`
- `DOWON_SYNC`
- `DOWON_SYNC_AT`

각 시스템의 성공 여부를 별도로 기록하므로 한쪽만 실패해도 다음 실행 때 실패한 쪽만 재시도합니다.
