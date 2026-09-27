# 로파워 eformsign 설정 (선택)

협업 로펌에서 eformsign을 사용할 경우 해당 로펌의 별도 계정/템플릿 자격증명을 사용합니다.
기존 도원/태광 운영 프로젝트의 키를 그대로 복사하지 마세요.

Vercel 환경변수:

```env
EFORMSIGN_API_KEY=
EFORMSIGN_PRIVATE_KEY=
EFORMSIGN_TEMPLATE_ID=
EFORMSIGN_MEMBER_ID=
EFORMSIGN_SENDER_MEMBER_ID=
```

고객관리의 `서명상태 새로고침`은 저장된 `eformsign_document_id`로 문서 상태를 조회합니다.
필요 DB 컬럼은 `supabase/00_ROPOWER_FRESH_SETUP.sql`에 포함되어 있습니다.
