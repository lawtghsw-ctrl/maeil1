# 로파워 Meta Lead Ads / CRM CAPI 설정

현재 권장 리드 수집 경로는:

`Meta Instant Form → 새 Google Sheet → Apps Script → 로파워 Admin → Supabase meta_leads`

입니다.

설정 순서는 `ROPOWER_SETUP.md`를 우선 따르세요.

## CRM CAPI

Vercel에 새 광고계정/새 Dataset 기준으로 아래를 설정합니다.

```env
META_CRM_DATASET_ID=
META_CRM_ACCESS_TOKEN=
META_GRAPH_API_VERSION=v26.0
META_CRM_TEST_EVENT_CODE=
```

이벤트 매핑:

- 부재중 → `crm_no_answer`
- 재연락 → `crm_follow_up`
- 상담중 → `crm_contacted`
- 유효리드 → `crm_qualified`
- 전환 → `crm_converted`
- 허수 → `crm_disqualified`

`meta_native_lead_id`가 있으면 Meta `lead_id`로 우선 매칭하고, 전화번호 SHA-256을 보조 매칭으로 사용합니다.

## Meta Webhook

`/api/meta/webhook` 경로도 소스에 남아 있지만, 새 협업 로펌 복제본의 기본 수집 경로는 Google Sheet입니다.
Webhook을 별도로 사용할 경우에만 `META_WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`, `META_PAGE_ACCESS_TOKEN`을 설정하세요.
