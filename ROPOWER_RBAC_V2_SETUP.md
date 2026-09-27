# 로파워 Admin v2 권한분리 적용

현재 로파워 Supabase에 `00_ROPOWER_FRESH_SETUP.sql`을 이미 실행한 경우,
추가로 `supabase/03_RBAC_ADMIN_STAFF.sql`만 1회 실행합니다.

## 계정 역할
- doublestone@1.com: ADMIN (최종관리자)
- hsw@1.com: ADMIN (최종관리자)
- shk@1.com: STAFF / 신홍규
- wndgh1245@naver.com: STAFF / 이중호

## ADMIN
- 전체 메뉴 접근
- 정산
- 기간별 변동내역
- 데이터 집계
- 업무 데이터 삭제
- 전사 조율 가이드 설정
- 조율 계산 이력 삭제

## STAFF
- 대시보드
- 신규 DB
- 고객 관리
- 계약 관리
- 입금/분납 관리
- 상환 일정 관리
- 사채업체 관리
- 내부 게시판
- 등록/수정 가능
- 삭제 불가
- 정산 / 기간별 변동내역 / 데이터 집계 접근 불가
- 전사 조율 가이드 설정 불가
- 본인 role을 ADMIN으로 변경 불가

## 적용 순서
1. `03_RBAC_ADMIN_STAFF.sql` 실행
2. `04_VERIFY_RBAC.sql` 실행해 역할/정책 확인
3. v2 소스 GitHub push
4. Vercel 배포
5. ADMIN 계정과 STAFF 계정 각각 로그인하여 메뉴/삭제 제한 확인

`03_RBAC_ADMIN_STAFF.sql`은 업무 데이터를 삭제하지 않습니다.
