# 로파워 Admin 신규 구축 가이드

이 패키지는 기존 도원 Admin v23 기능을 기준으로 만든 **협업 로펌용 독립 복제본**입니다.
기존 운영 DB를 비우거나 복사하는 방식이 아니라 **새 Supabase / 새 Vercel / 새 Google Sheet / 새 Meta 광고계정**으로 분리하는 것을 기본 원칙으로 합니다.

## 1. 이 복제본에 반영된 내용

- 브랜딩: `도원` → `로파워`
- 담당/조율 드롭다운: `신홍규`, `이중호`
- 기본 담당자: `신홍규`
- 신규 DB / 고객 / 계약 / 입금·분납 / 상환 / 업체 / 정산 / 게시판 / 계산기 / Realtime 기능 유지
- Meta CRM CAPI 이벤트 유지
  - 부재중 → `crm_no_answer`
  - 재연락 → `crm_follow_up`
  - 상담중 → `crm_contacted`
  - 유효리드 → `crm_qualified`
  - 전환 → `crm_converted`
  - 허수 → `crm_disqualified`
- Meta `lead_event_source`: `ropower_admin`
- 일정공지의 로펌명/계좌문구는 환경변수로 분리
- 기존 도원/태광 고객 데이터는 포함하지 않음

## 2. 권장 인프라 분리

협업 로펌용으로 아래 항목을 **기존 운영 계정과 완전히 분리**하는 것을 권장합니다.

1. 새 GitHub 저장소(선택)
2. 새 Supabase 프로젝트
3. 새 Vercel 프로젝트
4. 새 Meta 광고계정 / Dataset(CRM 데이터 소스)
5. 새 Meta Instant Form → 새 Google Sheet 연결
6. 필요 시 새 eformsign 계정/템플릿
7. 필요 시 별도 Telegram Bot/Chat

기존 도원/태광 Supabase Service Role Key, Meta Token, eformsign 키를 협업 로펌 프로젝트에 재사용하지 마세요.

## 3. Supabase 신규 프로젝트

### 3-1. 프로젝트 생성
Supabase에서 새 프로젝트를 생성합니다.

### 3-2. 전체 스키마 설치
SQL Editor에서 아래 파일을 **한 번만 전체 실행**합니다.

`supabase/00_ROPOWER_FRESH_SETUP.sql`

이 파일은 신규 프로젝트 기준으로 다음을 생성/설정합니다.

- profiles
- customers
- payment_schedules
- repayment_schedules
- lenders / lender_contacts / lender_customers
- board_posts / board_attachments
- settlement_entries
- meta_leads
- additional_contracts
- recoveries
- change_history
- negotiation_guidelines
- customer_calculator_items
- customer_calculation_snapshots
- Storage `board-files`
- RLS 정책
- Realtime publication
- 입금→정산 자동연동 trigger
- 추가계약/환수→입금 자동연동 trigger
- 고객 soft delete 연동
- 상환 추심/종결 상태
- 사고자 구조
- Meta CRM 상태 필드

### 3-3. 직원 로그인 계정 생성
Supabase → Authentication → Users에서 로그인 계정 2개를 만듭니다.

- 신홍규
- 이중호

이메일/비밀번호는 협업 로펌에서 정합니다.

신규 Auth User가 생성되면 `profiles`는 자동 생성됩니다.
그 후 `supabase/01_SET_STAFF_PROFILE_NAMES.sql`의 이메일 두 곳을 실제 이메일로 바꾸고 실행합니다.

> 담당/조율 드롭다운 자체는 소스에서 이미 `신홍규`, `이중호` 두 명으로 설정되어 있습니다.

## 4. Vercel 환경변수

`.env.example`을 기준으로 Vercel Production 환경변수를 입력합니다.

### 필수

```env
NEXT_PUBLIC_BRAND_NAME=로파워
NEXT_PUBLIC_NOTICE_SENDER_NAME=협업로펌명 또는 로파워
NEXT_PUBLIC_BANK_NOTICE=계좌 안내 문구

NEXT_PUBLIC_SUPABASE_URL=https://...supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

GOOGLE_SHEET_INGEST_SECRET=충분히_긴_랜덤_문자열
```

### Meta CRM CAPI 사용 시

```env
META_CRM_DATASET_ID=새 Dataset ID
META_CRM_ACCESS_TOKEN=새 Dataset CAPI Token
META_GRAPH_API_VERSION=v26.0
META_CRM_TEST_EVENT_CODE=
```

### 선택: Telegram 신규DB 알림

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### 선택: eformsign

```env
EFORMSIGN_API_KEY=
EFORMSIGN_TEMPLATE_ID=
EFORMSIGN_MEMBER_ID=
EFORMSIGN_SENDER_MEMBER_ID=
EFORMSIGN_PRIVATE_KEY=
```

## 5. Google Sheet 신규 DB 연동

### 5-1. Meta 쪽
새 광고계정에서 Instant Form 리드를 **새 Google Sheet**로 연결합니다.

현재 연동에서 확인된 Meta Sheet 헤더 예시는 다음입니다.

```text
id
created_time
ad_id
ad_name
adset_id
adset_name
campaign_id
campaign_name
form_id
form_name
is_organic
platform
full_name
phone_number
lead_status
```

핵심 필드는 `id`, `created_time`, `full_name`, `phone_number`입니다.
`id`는 Meta native Lead ID로 인식합니다.

### 5-2. Apps Script
파일:

`GOOGLE_SHEET_TO_ROPOWER_V1.gs`

상단 CONFIG에서 세 항목을 수정합니다.

```js
SHEET_NAME: "실제 시트 탭 이름",
ADMIN_API_URL: "https://새-버셀-도메인/api/google-sheet/lead",
ADMIN_LEAD_INGEST_SECRET: "Vercel GOOGLE_SHEET_INGEST_SECRET과 동일한 값",
```

저장 후 Apps Script에서 `createAdminSyncTrigger`를 **한 번 실행**합니다.
그 후 `syncLeadsToAdmin`이 1분마다 실행됩니다.

기존 행을 강제로 다시 전송할 필요가 있을 때만:

`forceResendLeadsToAdmin`

을 수동 실행합니다.

## 6. Meta 새 광고계정 / CRM Dataset

새 광고계정용으로 CRM Dataset을 새로 만들고 CAPI Access Token을 발급하는 것을 권장합니다.

Admin은 Dataset으로 아래 CRM 이벤트를 보냅니다.

| Admin 결과 | Meta event_name |
|---|---|
| 미분류 | 전송 안 함 |
| 부재중 | crm_no_answer |
| 재연락 | crm_follow_up |
| 상담중 | crm_contacted |
| 유효리드 | crm_qualified |
| 전환 | crm_converted |
| 허수 | crm_disqualified |

매칭은 Meta native Lead ID를 우선 사용하고 전화번호 SHA-256을 보조로 사용합니다.

새 Dataset ID/Token을 Vercel에 입력한 뒤 Redeploy 합니다.

## 7. 브랜딩 / 일정공지

앱 화면 브랜드는:

```env
NEXT_PUBLIC_BRAND_NAME=로파워
```

고객 일정공지 발신명은:

```env
NEXT_PUBLIC_NOTICE_SENDER_NAME=법무법인 OOO
```

처럼 별도로 지정할 수 있습니다.

입금 계좌 문구도 기존 태광 계좌가 코드에 남지 않도록 환경변수로 분리했습니다.

```env
NEXT_PUBLIC_BANK_NOTICE=★★★은행 계좌번호 예금주★★★
```

빈 값이면 일정공지 하단 계좌문구를 출력하지 않습니다.

## 8. eformsign

eformsign을 사용할 경우 **협업 로펌의 API 키/템플릿 ID**를 별도로 설정하세요.
기존 태광 eformsign 자격증명을 복사하지 않는 것을 권장합니다.
사용하지 않으면 환경변수를 비워두고 관련 기능은 설정 전 상태로 둘 수 있습니다.

## 9. 배포

```powershell
cd C:\Users\PC\Desktop\ropower-admin
npm install
npm run build
```

빌드 성공 후 새 GitHub 저장소를 사용할 경우:

```powershell
git init
git add .
git commit -m "로파워 어드민 신규 구축"
git branch -M main
git remote add origin <새 저장소 URL>
git push -u origin main
```

Vercel에서 해당 저장소를 새 프로젝트로 Import하고 환경변수를 등록한 뒤 Deploy 합니다.

## 10. 최초 운영 확인 체크

1. 로그인 2계정 모두 접속 가능
2. 고객 등록 → Supabase customers 저장 확인
3. 담당/조율에서 신홍규/이중호만 신규 선택되는지 확인
4. 입금/분납 저장 확인
5. 상환일정 저장 및 업체 자동등록 확인
6. 추심/종결 상태 확인
7. 내부 게시판 첨부 업로드 확인
8. Meta 테스트 리드 → 새 Sheet 입력 확인
9. Apps Script → Admin 신규DB 입력 확인
10. 신규DB `id`가 Native Lead ID로 저장되는지 확인
11. 유효리드 변경 → `crm_qualified` Meta 수신 확인
12. 고객등록 완료 → `crm_converted` 수신 확인
13. 모바일 iPhone/Android에서 테이블 좌우스크롤/글자 깨짐 확인
14. 수정 모달을 열어둔 상태에서 Realtime 갱신이 들어와도 입력값이 초기화되지 않는지 확인

## 11. 데이터 초기화

새 Supabase 프로젝트를 사용하면 처음부터 업무 데이터는 0건입니다.
따라서 별도 삭제 작업은 필요 없습니다.

이미 로파워 테스트 데이터를 넣은 뒤 다시 초기화해야 할 경우에만:

`supabase/99_OPTIONAL_RESET_ROPOWER_DATA.sql`

을 사용할 수 있습니다.

**기존 도원/태광 운영 Supabase에는 절대 실행하지 마세요.**

---

## v2 ADMIN / STAFF 권한분리 추가

`00_ROPOWER_FRESH_SETUP.sql`을 이미 실행한 현재 프로젝트는 아래 순서로 추가 적용합니다.

1. `supabase/03_RBAC_ADMIN_STAFF.sql` 실행
2. `supabase/04_VERIFY_RBAC.sql` 실행
3. v2 소스를 GitHub/Vercel에 배포

현재 역할:
- doublestone@1.com: ADMIN
- hsw@1.com: ADMIN
- shk@1.com: STAFF (신홍규)
- wndgh1245@naver.com: STAFF (이중호)

ADMIN 전용 메뉴는 정산 / 기간별 변동내역 / 데이터 집계이며, STAFF는 삭제 및 전사 조율 가이드 설정이 제한됩니다.
