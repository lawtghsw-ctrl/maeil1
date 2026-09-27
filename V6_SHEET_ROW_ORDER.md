# Ropower Admin V6 - 신규DB 시트 행 기준 정렬

## 수정 이유
Google Sheet 백필 과정에서 일부 과거 `접수일시` 값이 현재 시각으로 해석되면,
실제 최신 시트 행보다 위에 보일 수 있습니다. 검색은 전체 데이터에서 찾기 때문에 검색 시에는 정상 노출됩니다.

## 수정
- `meta_leads.source_row_number` 추가
- 기존 `meta_lead_id`에서 원본 시트 행 번호를 복원
- 신규 Sheet API 저장 시 행 번호도 저장
- 신규 DB 기본 목록을 `source_row_number DESC` 기준으로 정렬
- 접수일시는 기존 값 그대로 표시

## 적용 순서
1. 로파워 Supabase에서 `ROPOWER_META_LEAD_SOURCE_ROW_V6.sql` 실행
2. 본 V6 전체 소스로 교체
3. `npm run build`
4. Git push → Vercel 자동배포
