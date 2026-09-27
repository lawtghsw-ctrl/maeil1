# 로파워 Admin 변경이력

## v2.0.0 - ADMIN / STAFF 실제 권한분리
- ADMIN(최종관리자) / STAFF(직원) 역할을 UI와 Supabase RLS 양쪽에서 분리
- ADMIN 전용 메뉴: 정산, 기간별 변동내역, 데이터 집계
- STAFF는 운영 메뉴의 등록/수정 가능, 삭제 불가
- 신규 DB 삭제, 고객/입금/상환/업체/게시글/추가계약/환수 삭제를 ADMIN으로 제한
- 전사 조율 가이드 설정 및 계산 이력 삭제를 ADMIN으로 제한
- STAFF가 자신의 profiles.role을 ADMIN으로 변경하지 못하도록 DB 컬럼 권한 제한
- 현재 계정 역할: doublestone@1.com / hsw@1.com = ADMIN, shk@1.com / wndgh1245@naver.com = STAFF
- 기존 업무 데이터 삭제 없음

# 로파워 Admin v1 변경내역

기준 소스: 기존 도원 Admin v23 (`admin-edit-safe-refresh-v23.zip`)

## 로파워 전용 변경

- 화면 브랜드 `도원 Admin` → `로파워 Admin`
- 패키지명 `ropower-admin`, 버전 `1.0.0`
- 신규 담당/조율 선택 직원: `신홍규`, `이중호`
- 기본 담당/조율값: `신홍규`
- 내부 게시판 신규 글 기본 작성자: `신홍규`
- Meta CRM `lead_event_source`: `ropower_admin`
- 기존 태광 일정공지 발신명/계좌문구 하드코딩 제거
  - `NEXT_PUBLIC_NOTICE_SENDER_NAME`
  - `NEXT_PUBLIC_BANK_NOTICE`
- 새 Google Sheet용 Apps Script 템플릿 추가
- 신규 Supabase 프로젝트를 한 번에 구성하는 Fresh Setup SQL 추가
- 신규DB `status` CHECK를 현재 코드와 동일한 `신규 / 고객등록완료`로 확정
- 신규 설치용 Auth profile 자동생성 trigger 추가
- 신규 설치 검증 SQL 및 선택적 데이터 초기화 SQL 추가

## 유지한 핵심 기능

- 고객/계약/추가계약/재조율
- 입금·분납/재약정
- 환수/정산 자동연동
- 업체/업체 연락정보/고객 연결
- 상환일정/추심/종결/상환 문제 표시
- 사고자
- eformsign
- 신규DB/Meta CRM CAPI/native Lead ID
- Supabase Realtime
- 편집 중 자동 새로고침 보호
- 모바일 중복 저장 방지 및 반응형 테이블
- 내부 게시판/첨부
- 영업/조율 계산기
- 기간별 변동내역/데이터 집계

## 데이터

이 배포본에는 기존 도원/태광의 고객·계약·입금·업체·게시판 데이터가 포함되어 있지 않습니다.
실제 업무 데이터는 새 Supabase 프로젝트에서 0건으로 시작합니다.
