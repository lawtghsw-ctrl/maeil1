-- 고객 조율 계산기 v3
-- 누적 원금/기상환금액 입력 없이, 연락수단 x 기간별 원화 감액 가이드액으로 빠른 조율금액을 계산합니다.
-- 기존 고객/계약/입금/상환/계산이력 데이터는 삭제하지 않습니다.
-- v1/v2 SQL을 실행한 프로젝트에서 1회 실행하세요.

begin;

alter table public.negotiation_guidelines
  add column if not exists guide_1w_amount numeric,
  add column if not exists guide_2w_amount numeric,
  add column if not exists guide_3w_amount numeric,
  add column if not exists guide_4w_amount numeric,
  add column if not exists guide_2m_amount numeric;

update public.negotiation_guidelines
set guide_1w_amount = coalesce(guide_1w_amount, 0),
    guide_2w_amount = coalesce(guide_2w_amount, 0),
    guide_3w_amount = coalesce(guide_3w_amount, 0),
    guide_4w_amount = coalesce(guide_4w_amount, 0),
    guide_2m_amount = coalesce(guide_2m_amount, 0)
where guide_1w_amount is null
   or guide_2w_amount is null
   or guide_3w_amount is null
   or guide_4w_amount is null
   or guide_2m_amount is null;

alter table public.negotiation_guidelines
  alter column guide_1w_amount set default 0,
  alter column guide_1w_amount set not null,
  alter column guide_2w_amount set default 0,
  alter column guide_2w_amount set not null,
  alter column guide_3w_amount set default 0,
  alter column guide_3w_amount set not null,
  alter column guide_4w_amount set default 0,
  alter column guide_4w_amount set not null,
  alter column guide_2m_amount set default 0,
  alter column guide_2m_amount set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_guide_1w_amount_check') then
    alter table public.negotiation_guidelines add constraint negotiation_guidelines_guide_1w_amount_check check (guide_1w_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_guide_2w_amount_check') then
    alter table public.negotiation_guidelines add constraint negotiation_guidelines_guide_2w_amount_check check (guide_2w_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_guide_3w_amount_check') then
    alter table public.negotiation_guidelines add constraint negotiation_guidelines_guide_3w_amount_check check (guide_3w_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_guide_4w_amount_check') then
    alter table public.negotiation_guidelines add constraint negotiation_guidelines_guide_4w_amount_check check (guide_4w_amount >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='negotiation_guidelines_guide_2m_amount_check') then
    alter table public.negotiation_guidelines add constraint negotiation_guidelines_guide_2m_amount_check check (guide_2m_amount >= 0);
  end if;
end $$;

-- 네 연락수단 행이 없는 환경도 안전하게 보완합니다.
insert into public.negotiation_guidelines(contact_type,default_period,guide_1w_amount,guide_2w_amount,guide_3w_amount,guide_4w_amount,guide_2m_amount)
values
 ('번호','1주',0,0,0,0,0),
 ('텔레그램','1주',0,0,0,0,0),
 ('카카오톡','1주',0,0,0,0,0),
 ('라인','1주',0,0,0,0,0)
on conflict (contact_type) do nothing;

commit;
