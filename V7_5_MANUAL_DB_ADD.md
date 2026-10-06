# ROPOWER 사채 어드민 V7.5 - DB 수기등록

## 변경사항
- 신규 DB 화면 우측 상단에 `DB 수기등록` 버튼 추가
- Meta/Google Sheet를 거치지 않고 `meta_leads`에 직접 신규 DB 등록 가능
- 수기등록 항목
  - DB 접수일시
  - 고객명 / 연락처
  - 업체수
  - 영업 담당자 / 조율 담당자
  - 추심강도
  - 대여원금 / 상환총액
  - 증거보유 / 주변인피해
  - 메모
- 수기등록 DB는 목록에 `수기` 배지 표시
- 수기등록 DB도 기존과 동일하게 고객정보등록 가능
- 수기등록 DB는 Meta 원본 Lead가 아니므로 CRM Meta 전송 대상에서 제외
- 기존 Google Sheet / Meta 유입 DB 동작은 유지
- 별도 SQL 없음

## 참고
수기등록 행은 현재 최신 source_row_number 다음 번호를 내부 정렬값으로 사용해 목록 상단에 자연스럽게 표시됩니다. 실제 Meta/Google Sheet 원본 식별은 `meta_lead_id`로 계속 분리됩니다.
