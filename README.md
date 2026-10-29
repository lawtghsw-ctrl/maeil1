# 로파워 Admin

현재 웹 기능 패치: [V8.2 적용 범위와 데이터 보존](ROPOWER_V8_2_WEB_FEATURE_PATCH.md). 기존 운영 DB에 신규 설치·초기화 SQL을 실행하지 마세요.

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
