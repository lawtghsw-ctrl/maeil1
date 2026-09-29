
## V7 레거시 데이터 재파싱 (2026-09-29)

과거 DB 메모/담당자/현황, 수임인/성공보수, 실제 입금 원장을 재파싱합니다. 적용 전 `ROPOWER_LEGACY_REPARSE_V7.sql`을 Supabase SQL Editor에서 1회 실행하세요. 상세 내용은 `V7_LEGACY_DATA_REPARSE.md`를 참고하세요.

# 로파워 Admin

협업 로펌용 독립 Admin 복제본입니다.

처음 설치할 때는 **`ROPOWER_SETUP.md`**부터 읽으세요.

핵심 설치 파일:

- `supabase/00_ROPOWER_FRESH_SETUP.sql` — 새 Supabase 전체 스키마
- `supabase/01_SET_STAFF_PROFILE_NAMES.sql` — 신홍규/이중호 로그인 프로필명 설정
- `GOOGLE_SHEET_TO_ROPOWER_V1.gs` — 새 Google Sheet → Admin 연동
- `.env.example` — Vercel 환경변수 예시

기본 신규 담당/조율 직원:

- 신홍규
- 이중호

브랜드 기본값:

- 로파워
