-- ROPOWER 사채 어드민 V7.4 · 계약/실입금/분납/미수금 정밀 대조 패치
-- 기준 원본:
-- 1) DB 원본(메모/담당자/현황)
-- 2) 수임인 리스트(선임료/성공보수/누적 선임료 입금액)
-- 3) 실입금 원장(입금날짜/의뢰인/입금액/결제방식)
--
-- 적용 전제: V7.3 레거시 재파싱 SQL이 적용된 로파워 Supabase.
-- 이 SQL은 기존 일반 운영 데이터를 전체 삭제하지 않습니다.
-- V7.3이 만든 과거 실입금 일정만 교체하고, 수임인 리스트와 실입금 원장을 교차검증하여 누락분을 보정합니다.
-- 성공보수는 '환수', 수임계약과 대조되지 않는 실입금은 정산표의 '기타'로 분리합니다.

begin;

-- 0) 안전 확인
do $$
begin
  if to_regclass('public.customers') is null
     or to_regclass('public.payment_schedules') is null
     or to_regclass('public.settlement_entries') is null
     or to_regclass('public.additional_contracts') is null then
    raise exception 'ROPOWER V7.4 safety check failed: required tables are missing.';
  end if;
end $$;

-- 1) 레거시 실입금 추적 컬럼
alter table public.payment_schedules add column if not exists legacy_imported boolean not null default false;
alter table public.payment_schedules add column if not exists legacy_source_row integer;
alter table public.payment_schedules add column if not exists legacy_source_kind text;
alter table public.payment_schedules add column if not exists legacy_reconcile_note text;

alter table public.settlement_entries add column if not exists legacy_imported boolean not null default false;
alter table public.settlement_entries add column if not exists legacy_source_row integer;
alter table public.settlement_entries add column if not exists legacy_source_kind text;

-- 수임인과 직접 대조되지 않는 실제 현금유입을 계약/환수와 분리해 정산표에 보존
alter table public.settlement_entries drop constraint if exists settlement_entries_entry_type_check;
alter table public.settlement_entries add constraint settlement_entries_entry_type_check
check (entry_type in ('계약','환수','기타'));

-- 2) 이관 중 변경이력/직원 soft-delete 방지 트리거만 임시 해제
do $$
begin
  if exists(select 1 from pg_trigger where tgrelid='public.payment_schedules'::regclass and tgname='trg_change_history_payments' and not tgisinternal) then
    execute 'alter table public.payment_schedules disable trigger trg_change_history_payments';
  end if;
  if exists(select 1 from pg_trigger where tgrelid='public.settlement_entries'::regclass and tgname='trg_change_history_settlements' and not tgisinternal) then
    execute 'alter table public.settlement_entries disable trigger trg_change_history_settlements';
  end if;
  if exists(select 1 from pg_trigger where tgrelid='public.customers'::regclass and tgname='trg_change_history_customers' and not tgisinternal) then
    execute 'alter table public.customers disable trigger trg_change_history_customers';
  end if;
  if exists(select 1 from pg_trigger where tgrelid='public.payment_schedules'::regclass and tgname='trg_prevent_staff_soft_delete' and not tgisinternal) then
    execute 'alter table public.payment_schedules disable trigger trg_prevent_staff_soft_delete';
  end if;
end $$;

-- 3) stage key -> 고객 해석
create or replace function public.ropower_v74_resolve_customer(p_stage_key text)
returns uuid
language plpgsql
stable
set search_path=public
as $$
declare
  v_id uuid;
  v_phone text;
  v_name text;
begin
  if p_stage_key is null or btrim(p_stage_key)='' then return null; end if;

  if p_stage_key like 'phone:%' then
    v_phone := substring(p_stage_key from 7);
    select c.id into v_id
    from public.customers c
    where c.deleted_at is null
      and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=regexp_replace(v_phone,'[^0-9]','','g')
    order by coalesce(c.legacy_imported,false) desc, c.admin_created_at asc nulls last, c.id
    limit 1;
  elsif p_stage_key like 'paymentonly:%' then
    v_name := substring(p_stage_key from 13);
    select c.id into v_id
    from public.customers c
    where c.deleted_at is null and btrim(coalesce(c.name,''))=btrim(v_name)
    order by coalesce(c.legacy_imported,false) desc, c.admin_created_at asc nulls last, c.id
    limit 1;
  end if;
  return v_id;
end;
$$;

-- 4) 동일 고객의 최초계약 + 추가계약이 중복 합산되던 5개 레거시 그룹의 '최초 계약' 값 복구
-- 추가계약 행은 기존 additional_contracts에 그대로 남기므로, 전체 계약금액은 수임인 리스트 합계와 일치합니다.
update public.customers set contract_amount=220000, registered_at='2026-05-04', contract_date='2026-05-04'
where id=public.ropower_v74_resolve_customer('phone:01097491875');
update public.customers set contract_amount=330000, registered_at='2026-04-27', contract_date='2026-04-27'
where id=public.ropower_v74_resolve_customer('phone:01074055042');
update public.customers set contract_amount=6600000, registered_at='2026-05-19', contract_date='2026-05-19'
where id=public.ropower_v74_resolve_customer('phone:01087742886');
update public.customers set contract_amount=440000, registered_at='2026-05-20', contract_date='2026-05-20'
where id=public.ropower_v74_resolve_customer('phone:01021180495');
update public.customers set contract_amount=1320000, registered_at='2026-07-10', contract_date='2026-07-10'
where id=public.ropower_v74_resolve_customer('phone:01066339869');

-- 선임료 칸이 X였지만 실제 입금 55만원이 확인되는 이선구는 실제 수임액을 보수적으로 계약금액으로 보정
update public.customers
set contract_amount=greatest(coalesce(contract_amount,0),550000)
where id=public.ropower_v74_resolve_customer('phone:01076547811');

-- 원본 열 밀림으로 이름 자리에 메모가 들어간 고객: 실입금 원장 이름으로 복구
update public.customers
set name='정우현'
where id=public.ropower_v74_resolve_customer('phone:01077537906');

-- 5) V7.3에서 생성한 과거 실입금 일정 + V7.4 재실행 시 기존 V7.4 일정만 soft-delete
-- 일반 사용자가 직접 만든 운영 일정은 건드리지 않습니다.
update public.payment_schedules
set deleted_at=coalesce(deleted_at,now())
where id in (
    'c577b7cc-4f21-5400-b7ab-2fce951f29f2'::uuid,
    '3553b499-f85a-58ae-a4fc-be3148d9f028'::uuid,
    '0732815a-0f91-5961-adfb-c4a36013dd06'::uuid,
    'd28a32a0-8a0f-534f-bc3d-000c0e6412b8'::uuid,
    '12cf8759-4cc2-5bd8-8424-287d7d2f7cb0'::uuid,
    'fb8aee71-8e08-5412-9483-39f5a1b95beb'::uuid,
    'f8236aea-72d0-5309-a850-b419b404597b'::uuid,
    'f2a1d005-b743-5b43-b8bb-b869932de287'::uuid,
    '7cd09ff7-e29a-593d-a77b-922f9d529be8'::uuid,
    '01a641db-7afb-5645-a744-4733da8e2e9f'::uuid,
    '0db465f7-be08-5155-aeac-204b00fab16d'::uuid,
    '1d597414-bcd6-5192-a298-989dcdfacec7'::uuid,
    'b5f02e2d-f138-5b5a-86e2-9c51f2646409'::uuid,
    '1e1b878e-7d2a-5ff9-84b3-b76c843117a3'::uuid,
    '8fdbe6c9-091e-53ef-949b-7a8926b47b50'::uuid,
    'c6c3088f-5fff-5eb4-bea4-9ccd3b61d299'::uuid,
    '3989ac7a-eeb4-59cd-8b8c-54cb0b9385bc'::uuid,
    '5a2762e4-5f33-5aa4-aaa9-c366b42b2c3d'::uuid,
    'ffad09ae-c7c5-5a3a-b9ef-c51ea35d61ce'::uuid,
    '14a50150-51d5-5eff-954b-fc754d850025'::uuid,
    '20669852-830d-5391-8e6e-9672ddfa542e'::uuid,
    '1fef7610-6f82-514c-b9e7-f2012e9477aa'::uuid,
    '6f846ee5-2893-594c-9b9c-c002dce3e527'::uuid,
    '0740133a-cbb1-5ee7-a0ef-adb207f9b287'::uuid,
    '02c0bee4-8f8e-51bc-b189-175d87793f35'::uuid,
    'ccde84e0-4f57-5559-9ff4-cfeabce43b19'::uuid,
    '82997eba-2dff-5d63-b932-eac4986f395e'::uuid,
    'fb00cd2c-2f82-5581-8319-eef7cb3a8b3e'::uuid,
    '3166c984-28b0-536f-943c-dd1f59eff164'::uuid,
    '9c77d557-75b5-5c68-b9bc-5fc107c59a3f'::uuid,
    '973bb28a-ca07-5ae9-b85e-7f5fa500ca2c'::uuid,
    '1c16de45-9b5c-51fd-b1ab-89360b08511d'::uuid,
    '8831246d-627e-552f-8e27-48f2ae23323a'::uuid,
    '06b3e08b-9432-5083-8e48-a4ba6393c77f'::uuid,
    'b154c29a-259a-5523-b828-a382def26d40'::uuid,
    'f63308b1-4f5c-534e-8274-fc7816746abf'::uuid,
    '9446db29-9cc3-5353-87eb-89a2e73ca3fb'::uuid,
    '7d9b1c12-ed39-56c0-9be4-1aa9c8c46ffe'::uuid,
    '88ae31f3-0f50-56f0-ab26-32cf463b6937'::uuid,
    'fa546f0f-40e8-5017-a6ce-04b33e3e4303'::uuid,
    'f2860c35-e3c3-50d9-9640-415428295ddd'::uuid,
    'a63b6c31-901d-5f5a-a5a8-ac064b60de84'::uuid,
    '92866f55-cd9f-5722-9eb7-cb796d22290c'::uuid,
    'e2c27145-c039-5347-8002-fc3bc1026633'::uuid,
    'bdf86ff7-91d5-5d51-aa14-f2a9b6eff547'::uuid,
    '7c2e7a56-2233-50ee-bfd9-b6ed95bd051a'::uuid,
    'd331dd03-fc5f-582f-b88c-681715486df3'::uuid,
    '1f78b865-a03b-57e0-afdd-347c868d00fc'::uuid,
    'b796522c-4c79-51f8-9eee-66416a83aaba'::uuid,
    '1b1a3d8a-e84b-5b21-bc6f-da44133e4d0d'::uuid,
    'ec171ebe-ebb0-5cd4-9b20-94d440ae0eb2'::uuid,
    '94872bac-c867-58ab-8bf6-97b808442908'::uuid,
    '2ae6b16a-6470-5309-ac99-edbbeabfccc4'::uuid,
    'ef546c87-c5cc-5771-ba6e-e050a9e16953'::uuid,
    '2e0f1c23-05cf-541f-940b-7e3045d4744b'::uuid,
    '08047036-475c-5b8c-9a39-ea1ce52efa7a'::uuid,
    '4a6d26ea-b369-5aca-bc68-ac91d47e545a'::uuid,
    '5ee627c8-3ae8-5bd7-ad05-81363e245cbc'::uuid,
    '5c62e49f-149d-5410-8c99-93379265c421'::uuid,
    '3672491f-4f95-5d48-a106-14ae1b096b64'::uuid,
    '6a30a20c-f778-59e7-813c-6f315e3316db'::uuid,
    'eb085c70-cabb-56de-97fe-3a1d100434ff'::uuid,
    'f596f2c0-a00e-5be3-b5e1-2d3c9a537040'::uuid,
    '0cdbc864-29d1-51bd-89c2-8c6b5ff67216'::uuid,
    'c265d367-89f3-5495-aa41-aeece8f0cc83'::uuid,
    'a2135c5d-9a42-5235-b7bc-878bcd8b2544'::uuid,
    '53bc2f59-1fb1-591d-b1f6-712ac6f1bb6d'::uuid,
    'ad354c26-89b4-531f-81fb-b16278c7261c'::uuid,
    'c9872337-fdfe-52eb-aff7-f058e3f6f00e'::uuid,
    'd46e110f-4498-58a3-95d0-720c7aaf1b74'::uuid,
    '8e9670df-740c-517a-9a31-289c3f588b91'::uuid,
    '94f9d265-030e-5cd0-b3fa-a788367d8141'::uuid,
    'a4136947-914f-5fdc-9df9-19b08ba8fed6'::uuid,
    '72dff2b1-63d5-5c87-8fb2-a286a82b40d8'::uuid,
    '9839c4ba-63e9-510b-8083-61a3ddfb358c'::uuid,
    '16b33c7f-f2e3-5fe1-8226-38b6e61e8a26'::uuid,
    '4484ea26-c103-56be-ba9b-a861f7d37132'::uuid,
    '15b2d6d1-d36b-5670-818d-4f2d6d9b0974'::uuid,
    '62a1646e-be54-53ae-bbb8-50a9fed05253'::uuid,
    '69532d7b-6e1c-504d-ad7e-2dd51bf806d2'::uuid,
    'ee2b30ce-7a4b-5d14-a2fb-898e121c0563'::uuid,
    '29521b62-4bfe-552a-8b73-705717e2d387'::uuid,
    '79ddcb93-10f9-57b2-a436-e6a9467efb0e'::uuid,
    '5e61d1ef-ac49-5d81-9f63-3e78d6073ad7'::uuid,
    '5c6953b8-598a-5670-b4e3-ac27455ea85e'::uuid,
    'f9d89d4c-0312-5eeb-a65c-85bc2c356914'::uuid,
    '14c4f49c-e7e2-56b0-8b40-f2579000886d'::uuid,
    '684699b4-9938-5de0-8d54-f417ca79e243'::uuid,
    '4e865a88-c04e-5adc-82b2-5920e889de2f'::uuid,
    '46c3b9ac-980a-544d-a732-8b899ed68074'::uuid,
    'e3063e8f-4d6d-50d4-bed0-8ff10f543c15'::uuid,
    '5d341961-deb7-59e3-9cb2-24c87eee19fb'::uuid,
    '1a539907-0de9-5aa5-a2fc-c30bde669b03'::uuid,
    '5b419248-6849-562c-b6a4-842bfafe5fed'::uuid,
    '1e06ebf5-019f-5de1-bc84-1e6be759f7c3'::uuid,
    '3a339785-006d-5453-9372-29af6c15a3f4'::uuid,
    'd8344efa-2a0a-543a-b4e6-522517340f03'::uuid,
    '4fd72a1d-0db6-5620-8927-3bdd616df41e'::uuid,
    'b62e0283-cd37-5662-ad0b-7a24213b4385'::uuid,
    '715b9085-a797-519e-ae9f-5325e9e714f5'::uuid,
    '7b843683-d070-56ba-8688-c2b19139cf11'::uuid,
    'b2fd6023-4a0b-5d09-852b-371bee684f78'::uuid,
    '2e24a260-8f3a-551d-b27d-873beb832529'::uuid,
    'ca57803b-68ca-5cb4-b444-329abfcc630f'::uuid,
    'cd71c84f-ebf5-57b4-95b8-5b7896de2428'::uuid,
    '0f1480cc-65ca-570e-a27d-a5804321ca03'::uuid,
    '641e7b0d-d622-5992-8f3c-ad3aba0770a5'::uuid,
    'fac344c1-951e-5339-b212-f6552ff6c777'::uuid,
    '784a0fdf-2212-5c4d-906b-c3f9feb3a50c'::uuid,
    'e77ae348-53cb-5cc4-a753-fb177f6f52dc'::uuid,
    '24e65502-8bd9-5023-b98e-3b3f7b1a21f1'::uuid,
    '5319b6f8-e88c-58fa-8969-572b6b259604'::uuid,
    '3e8a773d-a5cd-5825-8623-05ec13b91832'::uuid,
    'a98743b3-532e-5f41-a4e3-746e5e89ea20'::uuid,
    '205b2ef3-4639-53a5-b884-2e2bc2372ecc'::uuid,
    'a81b94cd-44ba-577a-86b1-ef4fcf334b48'::uuid,
    '0615df90-78aa-5f60-8661-68dbcbf261e4'::uuid,
    '8aa00097-d112-5189-a6ff-1a98d90cd6cf'::uuid,
    'd406c491-ebae-5e39-85ee-ffcd5531bbc3'::uuid,
    '2df3bfb4-767a-56cd-ab21-59e1bf989202'::uuid,
    'bf037d40-1131-554a-826a-e4bc1f3fb1a0'::uuid,
    '8ad8f673-b9e9-59aa-b9ec-afc2bee7497f'::uuid,
    'd1b2de1c-7b7e-5ed8-bff8-e8de89d07611'::uuid,
    '85c22d99-5d20-55c1-98c2-88031dcba69a'::uuid,
    '8fe63830-ccbe-5dea-aa30-0499f8b5f38e'::uuid,
    '4fac79db-0f13-5598-9bad-2fc29accd607'::uuid,
    '839832e6-983a-503c-80b4-daf2b74eaa83'::uuid,
    '3c4e05a6-9b55-50f0-b217-0a99e0366cd1'::uuid,
    '71d8f359-cf3b-5ba4-b8c5-41844494b99b'::uuid,
    '6ac21ef9-9000-582f-bbaa-822a29c03219'::uuid,
    'afc74f86-3b2a-591b-9828-b574b07b9e6e'::uuid,
    'd3c2f055-7d17-5300-af38-0355b9e88f1a'::uuid,
    'cbd27fa7-ff0b-544d-8ef8-97efa32d6dda'::uuid,
    '5c94f924-99f3-5aa4-ac6e-26289b5524be'::uuid,
    '695e2d39-2a81-5826-9e91-d84248343ccd'::uuid,
    '7fa2f6c2-0800-533c-94c1-547fd239b1a5'::uuid,
    'e9a77e4b-5bb2-52eb-83e7-915f2e254ba5'::uuid,
    '5bdc976d-4e7d-5dcb-93ea-0acfdb03b25e'::uuid,
    'b9e32c65-dc4e-5b29-94bf-d0fe7ac71ca6'::uuid,
    'b2ddf42c-29ed-5256-8018-b997b8c84b45'::uuid,
    'dafeecaa-a794-5d82-8800-621776bf4971'::uuid,
    'ede2546d-0061-5f2a-bab1-2764055ab040'::uuid,
    'a2111c4d-7bd3-5f52-9d2c-437d20dfb5fd'::uuid,
    '2cdf520c-84a0-5b0c-9834-b0956e9a949f'::uuid,
    '31c2fe2e-b134-5697-a9d8-5f57e52f8003'::uuid,
    '6ba3034a-474e-58fa-8c30-cd8eb5f85c7d'::uuid,
    '4628f012-9552-5be0-b535-c638fd268776'::uuid,
    '87a277f8-c6a6-5c09-8bf0-65fe38ab9344'::uuid,
    '91bc243b-d8b1-5e99-af1b-ab50cd76d0b4'::uuid,
    'b5e644ea-2165-5493-a8f3-15f34f7fe05f'::uuid,
    '7e020f96-a178-5836-b68d-eb286488169f'::uuid,
    '270a7fa3-8b1f-5dd5-986d-db7abd05db6f'::uuid,
    '05ec9833-5eb9-5d0d-9747-76d845ad757f'::uuid,
    '47b5c587-b8c6-56f4-9059-6060c7b5fa5a'::uuid,
    'dd1fa603-3fa3-5357-ae35-5268ea332407'::uuid,
    '00ac9f5a-d535-516a-b636-6162b5f0ac59'::uuid,
    'e8379aab-f05a-5a07-81c7-f2b87d382aa7'::uuid,
    'ba5a76d3-b41b-5630-829b-34ff91e46701'::uuid,
    '9d5b6d33-9b9b-5458-84f6-baf3a0b47d4c'::uuid,
    '7026416c-30d5-5d49-84bb-de8b56d796da'::uuid,
    'add8ca40-8450-5eb4-835a-64ffb02b408d'::uuid,
    '7f343aab-e1a6-5396-84dc-6c668aa35214'::uuid,
    '498ac756-1107-5bde-a37b-4ceb8de04b81'::uuid,
    'a7bea71c-a598-578b-9838-c4062d919a7f'::uuid,
    'bc19d28d-4066-582f-91b1-98cb9727315f'::uuid,
    '9cce7611-ea90-5cdd-99b8-3941af8a32be'::uuid,
    '79e36d47-a112-507d-b09e-3433a45e9fdf'::uuid,
    '7e20bb25-b55c-50a5-bb6a-c9a4b90907e0'::uuid,
    '94a639ee-8b6c-5b32-b4da-ad3daf2e85f0'::uuid,
    'cc96681e-a957-5448-8c8b-4c55b0993fba'::uuid,
    'a3c67f12-197d-53a2-9e26-d49e8d397c3b'::uuid,
    'bb33038b-0a74-52b1-ba54-d972104aba35'::uuid,
    '17a7ef0d-68d0-5675-9cf4-27110128604a'::uuid,
    'aac0806e-da09-503f-90cd-50ab8b01fa45'::uuid,
    '0f016719-fe67-5067-86cf-e39b55800ab7'::uuid,
    '210c97d9-456f-5adb-93ff-bbb140b689ef'::uuid,
    '0e733c44-5e9c-54d9-8658-721ff880ead9'::uuid,
    '58888f7b-831e-5bab-b339-11222a82f6f7'::uuid,
    '7490ee8b-d9e2-5df8-ae03-49797fe41cc1'::uuid,
    '7e281c49-ceab-5be1-ae2c-23564e6605e9'::uuid,
    '82673618-2f1c-5430-a5b1-e2aba935bd2d'::uuid,
    'c26cab52-e552-58b7-b780-90630a9ab911'::uuid,
    '8a21f26b-c5af-5562-b85f-f2bd2446ea31'::uuid,
    '3b2a75b3-a673-54b3-a96d-68153f432310'::uuid,
    '4d37d61a-5d4c-52e6-a2cc-f67c24abedbf'::uuid,
    'ee0b0e91-8d0a-54a6-878c-f41693a79fba'::uuid,
    'f4134cfb-a760-547b-87b1-73cd0f7a6aa1'::uuid,
    '1767f550-9b59-5c8a-9119-90a6db235f39'::uuid,
    '664b4ddb-a3ee-5225-b367-19eca1fd05a0'::uuid,
    '4d6ff144-f792-57ed-8833-f1c5e8e56297'::uuid,
    '3b4bf929-9971-5499-815d-8d9f9e264ba6'::uuid,
    'd5b54576-0c11-5573-8025-8e5f88917e30'::uuid,
    '09f5f09b-ca3e-5999-a806-366b5ee907b0'::uuid,
    'e2bd9898-74d1-50fc-9b50-b1faac2b6b6b'::uuid,
    '9a371617-0431-58d5-9ae4-61fa6c636e19'::uuid,
    'cfec9a9a-8538-5d7a-8fe3-4ab1c2eb2576'::uuid,
    'f0849166-48c3-553e-ac1e-cdf027b3eb1e'::uuid,
    '84637ef1-9bf4-5827-bfa4-596b6c25afe1'::uuid,
    'fb114aa6-f42e-5ee7-93d3-15e5e7137269'::uuid,
    'e67f3aa4-e475-5b5c-af06-b1af132268c3'::uuid,
    'e26cbce3-e785-5353-90bf-14597877d8ac'::uuid,
    '1af37e24-9d24-5ade-bcc3-40946c70d007'::uuid,
    '7570ae09-a026-5551-bb07-38b621aca650'::uuid,
    'a52dd2a4-8a08-56b3-becd-ca65668a0fea'::uuid,
    'b60a4afa-aa38-5976-88c9-d74dea83ee39'::uuid,
    'd473f26d-f9e5-52b7-af38-d8b5f225016a'::uuid,
    'ee6d42e2-bff1-5763-bd13-06911ca7dd6f'::uuid,
    '7cbbd106-453c-5f24-9b44-9c4ff6c6709a'::uuid,
    '65408c16-7607-5ad0-ad9a-735be487150d'::uuid,
    '4a84faa1-1b08-524a-ab33-afe9d2ec3b77'::uuid,
    'c4c9d7ee-b0af-5a7c-a262-fd3df3a85b34'::uuid,
    'e3f47091-e8dd-5673-b1bc-817c4fe37115'::uuid,
    'd8e035fd-7b42-5089-b3a7-83fa4854df65'::uuid,
    '0182999a-0df1-5405-9bed-397fce671ffd'::uuid,
    '3cc404c6-95f2-5fda-9a51-4d4ac6426781'::uuid,
    '80f989a4-3c10-55d6-ae05-3890b40bec21'::uuid,
    'f0737df0-fc0e-5770-a98f-ec2af6f2e806'::uuid,
    '07ad6984-fce2-5421-acc3-551a06ae7637'::uuid,
    '2ded5125-7d5b-5628-a4a5-3dcb630862a6'::uuid,
    '4b147c04-11a5-5f45-a660-f89dd63681aa'::uuid,
    '6dd3c94b-ee37-5d2c-88b0-3508e91c2b5c'::uuid,
    'a3218d5d-6777-50cc-9677-578be8c39338'::uuid,
    '0bd1f919-ff6e-5e20-ab3c-38ce14fc2010'::uuid,
    '48d7f3e1-86ee-5cfa-9039-cb32c5dabe27'::uuid,
    '2fe5473d-b48f-57f5-a19f-b81e9fb615f2'::uuid,
    'c7ab32c2-3126-5d71-8bac-287e0393fcaf'::uuid,
    '0af4d3bf-e708-575a-9f9c-cebf94df8b46'::uuid,
    'dbb0d4f3-9974-5cc6-a045-49fa08902870'::uuid,
    'f63e62e7-b0f3-50ef-9079-b6a679570203'::uuid,
    'abeec4d3-5090-55b3-90f4-44c7f15173be'::uuid,
    'ded63531-0a39-5bd9-a04c-6d9c434b3dd3'::uuid,
    '33a65fef-2f41-558a-b51f-32bc28cf60c5'::uuid,
    '3dc562e0-4932-5d49-916b-e62319dac1b8'::uuid,
    '2e6f8f4e-3294-548c-baa0-e1e80cefb1c4'::uuid,
    'a293fd86-acb5-59aa-85ec-55f1af06226a'::uuid,
    '1a7ea768-c92a-5baf-a847-6384d372d05c'::uuid,
    '8e1cc146-c874-5923-bcd7-189399d3212e'::uuid,
    '6a60e31c-6146-5bf4-beac-7245ea93d88b'::uuid,
    '8228acb4-adc2-5291-84d2-0804aa2f4cdb'::uuid,
    'b5f068d4-fda5-5b22-8b46-1a5dfda1c9fa'::uuid,
    'b22787ab-7a8e-5d98-9b8e-d4cf04fe7dbc'::uuid,
    'b54d5036-8988-5974-be46-77c0c59dcfa4'::uuid,
    'ab00bf6b-3a33-51fb-bce5-5b00c72edf8f'::uuid,
    '0f6b33cf-5c79-5044-929e-0c7deb7b73b2'::uuid,
    '306b7711-b4e6-5b15-b969-9e20475cfe5b'::uuid,
    '790b9bf2-dbb6-58a3-a30a-03b7acecef00'::uuid,
    '4ff9c5c4-794a-59bc-abc8-2daf671a8f01'::uuid,
    '3654ca8d-847f-59c3-828b-a422bffc7809'::uuid,
    'f5b10b03-ff0b-5d73-8951-d8ae4d87ccd9'::uuid,
    'b2cd5fee-632a-5ffd-adde-0002ca662bee'::uuid,
    'a85f4351-e8d9-5700-b42f-2fe919567208'::uuid,
    '6e4572b0-5c54-59a2-9833-fc8f2d072589'::uuid,
    'c70cf905-03fd-56ff-a0b0-f3c3cadc26de'::uuid,
    '738cf974-b17d-5ee4-b296-19da270d098c'::uuid,
    '20627f9e-c17d-55da-bc8b-3f1b01ed528f'::uuid
)
or (coalesce(legacy_imported,false)=true and legacy_source_kind in ('입금원장','수임인보정'));

-- V7.4 기타 정산 재실행 대비
update public.settlement_entries
set deleted_at=coalesce(deleted_at,now())
where coalesce(legacy_imported,false)=true and legacy_source_kind='기타실입금';

-- 6) 실입금 원장 247개 양수 입금 전체 + 성공보수 정확 분리 + 수임인 리스트 누락 입금 보정
with p(id,stage_key,source_row,paid_date,paid_amount,payment_method,schedule_type,duplicate_rank,memo,source_kind) as (
  values
  ('2c9dcad0-1c65-51a4-88d8-de6be7ef8f30'::uuid,'phone:01076547811',4,'2026-05-05'::date,200000,'계좌이체','일반',1,'','입금원장'),
  ('5d16a42c-732e-5028-bc34-a87897873c63'::uuid,'phone:01097491875',5,'2026-05-06'::date,200000,'계좌이체','일반',1,'','입금원장'),
  ('47d7913a-2bad-59a2-b450-bbfafdbb4af4'::uuid,'phone:01075402674',6,'2026-05-07'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('9e4d473a-e0ae-5caa-af9b-d9ee436d15bf'::uuid,'phone:01074055042',7,'2026-05-08'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('ce2fe00c-78ab-5d5c-aea9-e0df23aa8b36'::uuid,'phone:01076964290',8,'2026-05-08'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('b2365388-7a0c-5a08-a410-fb3030470bd2'::uuid,'phone:01099819641',9,'2026-05-09'::date,300000,'계좌이체','일반',1,'','입금원장'),
  ('85949343-b363-5f8d-9003-9c12702d2c1f'::uuid,'phone:01039730249',10,'2026-05-10'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('d2c06c37-d3c3-5ef4-8c83-cf0657897ee4'::uuid,'phone:01076547811',11,'2026-05-11'::date,350000,'계좌이체','일반',1,'','입금원장'),
  ('e66f8cce-4149-5db4-9dd4-5330d8d48a9b'::uuid,'phone:01023516321',13,'2026-05-11'::date,1100000,'계좌이체','일반',1,'','입금원장'),
  ('7ed15fd0-eabf-5517-9afa-c62d9fa1fdc8'::uuid,'phone:01056436599',14,'2026-05-11'::date,33000,'계좌이체','일반',1,'','입금원장'),
  ('ac82d423-c576-571f-87c4-ba8299b10f36'::uuid,'phone:01081852744',12,'2026-05-12'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('6d2b4cab-18ff-5d61-a7ad-1b5047b11efb'::uuid,'phone:01030788522',15,'2026-05-15'::date,590000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('72503184-4e4f-5201-a3cc-9d2a2798ad59'::uuid,'phone:01030788522',15,'2026-05-15'::date,1320000,'계좌이체','일반',1,'','입금원장'),
  ('ca5f25a1-42b9-5b47-92ab-8f9093b07c7f'::uuid,'phone:01089241384',16,'2026-05-18'::date,176000,'계좌이체','일반',1,'','입금원장'),
  ('cb391624-cfa3-5f41-99e6-44059c3eaa46'::uuid,'phone:01087742886',17,'2026-05-19'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('c606da56-c2e8-5f30-b293-a61c6dbde2aa'::uuid,'phone:01097491875',18,'2026-05-19'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('5e571be0-8041-521b-b6b7-37598fdb5354'::uuid,'phone:01099775135',19,'2026-05-19'::date,30000,'계좌이체','일반',1,'','입금원장'),
  ('00793ebd-4aee-5d21-87f9-a608e02cde1a'::uuid,'phone:01081852744',20,'2026-05-20'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('27a9cdfa-4f10-5b09-a50e-5ba5d4853e26'::uuid,'phone:01058039268',21,'2026-05-20'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('75c6c724-1772-543f-8e92-dc883058fd1e'::uuid,'phone:01021180495',22,'2026-05-20'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('5ed39766-60b2-51d0-8cd8-56556ea2ed66'::uuid,'phone:01082252320',23,'2026-05-21'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('681823e8-5fa7-59e4-abed-5e2b967e6c0e'::uuid,'phone:01056455701',24,'2026-05-21'::date,132000,'계좌이체','일반',1,'','입금원장'),
  ('e6f20967-9324-54ec-90d4-772ed4b0315f'::uuid,'phone:01039730249',25,'2026-05-21'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('1db44b26-9553-5454-963e-018741ef5641'::uuid,'phone:01076964290',9010,'2026-05-21'::date,120000,'계좌이체','일반',1,'수임인 리스트 후납 12만원 · 21일로 변경 메모 반영','수임인보정'),
  ('2877a780-011f-5bbf-9f68-493d673e2fa2'::uuid,'phone:01051912863',26,'2026-05-22'::date,360000,'계좌이체','일반',1,'','입금원장'),
  ('f0321e84-a0f9-5b16-b345-8ad573a87437'::uuid,'phone:01090931029',27,'2026-05-25'::date,500000,'계좌이체','일반',1,'','입금원장'),
  ('fe0f01a1-53dd-540f-984b-278d2b544b14'::uuid,'phone:01064663639',28,'2026-05-26'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('731a0ec4-5a17-53fe-b936-0162d296f527'::uuid,'phone:01055955376',29,'2026-05-26'::date,640000,'계좌이체','일반',1,'','입금원장'),
  ('8945ed92-f725-543c-97ae-e6c5ac9f6018'::uuid,'phone:01055955376',29,'2026-05-26'::date,750000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('2f9a4ba8-f0f8-5d8a-aba0-32d156382827'::uuid,'phone:01090931029',30,'2026-05-27'::date,500000,'계좌이체','일반',1,'','입금원장'),
  ('0e7dc427-0ae2-5218-9475-fdcdb8ed8c48'::uuid,'phone:01082252320',32,'2026-05-27'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('6140f203-2ce7-590c-baae-33c637768d34'::uuid,'phone:01027251646',33,'2026-05-27'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('4c842921-bbcb-5d29-8ff5-d524daed7587'::uuid,'phone:01051912863',34,'2026-05-27'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('ab0eae23-024e-5ee9-9648-9e942572d7b3'::uuid,'phone:01089241384',35,'2026-05-28'::date,124000,'계좌이체','일반',1,'','입금원장'),
  ('1b9fb35c-9948-5c79-9872-4b28ebd3a7fc'::uuid,'phone:01051912863',36,'2026-05-28'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('fc09980e-7ee7-59bf-88ae-73ef21d06044'::uuid,'phone:01074055042',37,'2026-05-28'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('81d25817-a7db-586a-81bf-113baad81802'::uuid,'phone:01075944992',38,'2026-05-28'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('37f9d78e-2d2e-5f96-9f0f-e4da1e7f9b8f'::uuid,'phone:01082252320',40,'2026-05-29'::date,550000,'계좌이체','일반',1,'','입금원장'),
  ('f8180f01-b703-5dba-8bce-f927a9666258'::uuid,'phone:01062232776',41,'2026-05-29'::date,264000,'계좌이체','일반',1,'','입금원장'),
  ('ddf4aad5-65b9-5ede-87e5-a9e7b977d7e7'::uuid,'phone:01039916233',42,'2026-05-30'::date,660000,'계좌이체','일반',1,'','입금원장'),
  ('9e1ec032-d9a9-5dfd-b9fb-9c8b62656370'::uuid,'phone:01074055042',43,'2026-06-01'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('81036704-4988-5e96-915b-0d0d507e368a'::uuid,'phone:01089241384',44,'2026-06-03'::date,500000,'계좌이체','일반',1,'','입금원장'),
  ('a66dfb13-06ae-5917-9e1f-9b36414d594b'::uuid,'phone:01055488733',45,'2026-06-03'::date,300000,'계좌이체','일반',1,'','입금원장'),
  ('292c13cb-0e2e-5d4a-b3e9-d2f36e27d7cc'::uuid,'phone:01055488733',46,'2026-06-03'::date,500000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('3d1dc471-c376-5c4e-8b60-c60c6c6e4307'::uuid,'phone:01055488733',9015,'2026-06-03'::date,30000,'계좌이체','일반',1,'수임인 리스트 6/3 계약금 33만원 대비 입금원장 30만원 차액 보정','수임인보정'),
  ('668252e9-858b-5f29-b6a3-9355ee779155'::uuid,'phone:01095071688',47,'2026-06-04'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('866458ce-f799-5b15-b81f-75833d192e55'::uuid,'phone:01095071688',48,'2026-06-04'::date,200000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('b49d21fc-5c8c-5634-9c9f-9f6962807716'::uuid,'phone:01095071688',48,'2026-06-04'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('56108a4c-62ce-50a2-9981-fe8dba81fedf'::uuid,'phone:01064663639',49,'2026-06-05'::date,300000,'계좌이체','일반',1,'','입금원장'),
  ('9eb4f86a-75f3-5409-ba5f-af2456050cab'::uuid,'phone:01075944992',50,'2026-06-05'::date,250000,'계좌이체','일반',1,'','입금원장'),
  ('91947882-9e26-5208-b1cd-36db8fe87374'::uuid,'phone:01045164841',51,'2026-06-05'::date,350000,'계좌이체','일반',1,'','입금원장'),
  ('530c79ef-c25c-508a-bf15-12986d1f89c1'::uuid,'phone:01051912863',52,'2026-06-05'::date,410000,'계좌이체','일반',1,'','입금원장'),
  ('fa824ef0-9a76-52a0-88d9-7bf1c0a3e0c7'::uuid,'phone:01075402674',53,'2026-06-05'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('a6f1a908-d8bc-50fd-9179-4b6cf921603e'::uuid,'phone:01090931029',54,'2026-06-05'::date,650000,'계좌이체','일반',1,'','입금원장'),
  ('1dec9d41-11bb-593f-8555-85d8a194ec6d'::uuid,'phone:01074658460',74,'2026-06-05'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('349f0298-38d1-5581-85fc-6fdd38f27c7a'::uuid,'phone:01074198963',238,'2026-06-05'::date,265000,'계좌이체','일반',1,'','입금원장'),
  ('03b7c32f-21a9-5494-9270-e55fea2bd041'::uuid,'phone:01097937286',55,'2026-06-08'::date,600000,'계좌이체','일반',1,'','입금원장'),
  ('7bc00f62-b64f-5e34-8adf-ac0b55c2e172'::uuid,'phone:01055488733',56,'2026-06-10'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('f74d9350-85e3-5f2a-80ab-57996a05675f'::uuid,'phone:01089241384',57,'2026-06-10'::date,200000,'계좌이체','일반',1,'','입금원장'),
  ('5e8d7ca5-2e99-5e8d-9eaf-733a987db748'::uuid,'phone:01075944992',58,'2026-06-10'::date,470000,'계좌이체','일반',1,'','입금원장'),
  ('a72caf6b-4015-56f5-bf01-eca7c6820c27'::uuid,'phone:01095071688',59,'2026-06-10'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('2e0f3af2-3627-54a5-8c17-4babdb8fa9eb'::uuid,'phone:01062232776',60,'2026-06-10'::date,396000,'계좌이체','일반',1,'','입금원장'),
  ('e8ffd1a7-dd27-59b9-8efe-a6a1fdec9013'::uuid,'phone:01072061173',61,'2026-06-11'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('892a50e6-67e1-5251-b8ee-66f36714d70e'::uuid,'phone:01087742886',62,'2026-06-11'::date,6270000,'계좌이체','일반',1,'','입금원장'),
  ('a77ba9ca-351e-5f6c-a4a9-f5d3abed6465'::uuid,'phone:01075944992',88,'2026-06-11'::date,1000000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('d9aa2c1b-c094-5510-8377-cde24acc32f5'::uuid,'phone:01077537906',63,'2026-06-12'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('e006b7b9-4ec2-58c1-aca9-a26bfff41b2a'::uuid,'phone:01025235003',64,'2026-06-12'::date,440000,'계좌이체','일반',1,'','입금원장'),
  ('cf5afab5-2147-57c4-955a-4329ec7c5603'::uuid,'phone:01089241384',65,'2026-06-14'::date,300000,'계좌이체','일반',1,'','입금원장'),
  ('24e41494-d7bf-5621-b0d4-10b91024bd55'::uuid,'phone:01084512789',66,'2026-06-15'::date,308000,'계좌이체','일반',1,'','입금원장'),
  ('ba0c1bd8-89f7-563b-a59e-3212e64c937e'::uuid,'phone:01077537906',67,'2026-06-15'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('e032a113-8269-5104-9a8c-3f61f67b85d7'::uuid,'phone:01097937286',68,'2026-06-15'::date,9850000,'계좌이체','일반',1,'','입금원장'),
  ('213bcc48-2e1b-510d-a1a0-643ed78e621a'::uuid,'phone:01077694474',69,'2026-06-15'::date,500000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('c2a59020-0326-55a6-9b00-9491a79e57b5'::uuid,'phone:01046958552',70,'2026-06-15'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('e771dd3a-65b2-556a-808e-765191ed3bca'::uuid,'phone:01046958552',71,'2026-06-16'::date,750000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('f5f0a5d4-22bc-5c92-aebb-276b5802e3dd'::uuid,'phone:01046958552',72,'2026-06-16'::date,850000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('458cae3c-261b-51e7-8426-9142795cff54'::uuid,'phone:01027958846',73,'2026-06-17'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('f0a82337-a472-5429-9a26-df1ff03746d8'::uuid,'phone:01089241384',75,'2026-06-17'::date,300000,'계좌이체','일반',1,'','입금원장'),
  ('44755c4e-ec1f-5a74-b1ed-e6f0f513bbce'::uuid,'phone:01075402674',76,'2026-06-17'::date,150000,'계좌이체','일반',1,'','입금원장'),
  ('cc8b358b-51cc-54b2-8928-632d01ae4483'::uuid,'phone:01083414340',77,'2026-06-17'::date,198000,'계좌이체','일반',1,'','입금원장'),
  ('dcfb27c9-e96a-596c-b4ea-19532bb747c7'::uuid,'phone:01075944992',78,'2026-06-18'::date,500000,'계좌이체','일반',1,'','입금원장'),
  ('a75208d2-7819-5e85-9c3a-15a6b1cacfca'::uuid,'phone:01072055177',79,'2026-06-18'::date,110000,'로피결제','일반',1,'','입금원장'),
  ('219b7520-6e98-566e-8d3d-2d94b39eac58'::uuid,'phone:01076706256',80,'2026-06-19'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('8f7271c4-0633-549d-9f4c-c7ae4eb48254'::uuid,'phone:01047987224',82,'2026-06-23'::date,550000,'계좌이체','일반',1,'','입금원장'),
  ('0e6d48f4-cc02-5490-919d-0513d1819757'::uuid,'phone:01089241384',84,'2026-06-24'::date,160000,'계좌이체','일반',1,'','입금원장'),
  ('50db01af-ec3b-5486-aac6-d708ee836da0'::uuid,'phone:01086226110',85,'2026-06-25'::date,220000,'로피결제','일반',1,'','입금원장'),
  ('58a55cfc-9cbc-5c5a-a0cd-15af755f651b'::uuid,'phone:01039916233',86,'2026-06-25'::date,1320000,'계좌이체','일반',1,'','입금원장'),
  ('a5164f96-1c83-5dc0-8ecf-b472f4ee0ed1'::uuid,'phone:01047987224',87,'2026-06-26'::date,550000,'계좌이체','일반',1,'','입금원장'),
  ('a23a7135-e59f-5565-998f-38683eca03ad'::uuid,'phone:01080807216',89,'2026-06-29'::date,220000,'로피결제','일반',1,'','입금원장'),
  ('8f18e7ad-d2ea-533d-8366-99ab8fe25752'::uuid,'phone:01047987224',90,'2026-06-29'::date,13500,'계좌이체','환수',1,'성공보수','입금원장'),
  ('f1d336d7-fd58-5b8c-a275-e37da8e8f3b4'::uuid,'phone:01047987224',91,'2026-06-29'::date,985000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('ef850fb5-9a9e-5584-85a4-04fd1c05f461'::uuid,'phone:01058621359',122,'2026-06-30'::date,130000,'계좌이체','일반',1,'','입금원장'),
  ('b0009854-b9bf-5a13-bea8-1d228859a598'::uuid,'phone:01074055042',92,'2026-07-01'::date,275000,'계좌이체','일반',1,'','입금원장'),
  ('4fef4234-01bd-5c65-b1b0-090ef7053b33'::uuid,'phone:01087172713',93,'2026-07-01'::date,200000,'계좌이체','일반',1,'','입금원장'),
  ('5ddd7904-98f1-5000-8ca0-7f3afbe6bb2a'::uuid,'phone:01067720991',94,'2026-07-02'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('b17f3188-125c-57e5-9034-d5422c0d6a48'::uuid,'phone:01065209025',95,'2026-07-03'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('8278d74f-8212-54ef-8bf9-186a56e4d644'::uuid,'phone:01099570750',96,'2026-07-03'::date,275000,'계좌이체','일반',1,'','입금원장'),
  ('a05a4c90-4560-522f-bba2-b7c7465e0db4'::uuid,'phone:01077694474',97,'2026-07-03'::date,500000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('d2aa0062-988e-5628-8f6f-3398074e8876'::uuid,'phone:01093588206',124,'2026-07-03'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('d25af22b-45da-533d-989d-222cb5f337ae'::uuid,'phone:01033818966',98,'2026-07-04'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('a41cc8dc-60b2-54df-b3b1-5a3ba0f4e1b9'::uuid,'phone:01026167073',99,'2026-07-06'::date,100000,'로피결제','일반',1,'','입금원장'),
  ('7327d98d-9f86-5035-ac43-c53415473252'::uuid,'phone:01033818966',100,'2026-07-08'::date,120000,'계좌이체','일반',1,'','입금원장'),
  ('e550a916-7aab-534c-bae3-049a741cd5c1'::uuid,'phone:01039742334',9011,'2026-07-08'::date,120000,'계좌이체','일반',1,'수임인 리스트 계약금 12만원 보정','수임인보정'),
  ('5c261934-c8c2-5e7c-8d70-0c47327b5992'::uuid,'phone:01058348435',101,'2026-07-09'::date,110000,'로피결제','일반',1,'','입금원장'),
  ('5cbc9890-cd62-5360-a945-1a93077e7e27'::uuid,'phone:01082654642',102,'2026-07-09'::date,100000,'로피결제','일반',1,'','입금원장'),
  ('90ba04dd-9697-57b9-81d9-6053f462ccc6'::uuid,'phone:01026041022',103,'2026-07-09'::date,110000,'로피결제','일반',1,'','입금원장'),
  ('2fa63a41-68bd-5955-863b-a3c08fcc55a3'::uuid,'phone:01055505373',104,'2026-07-10'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('0d55692f-d420-59cd-8655-bc0ce10c2357'::uuid,'phone:01099570750',105,'2026-07-10'::date,500000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('da142e4b-8e43-5b4a-b9f0-9b1ec32d860d'::uuid,'phone:01094190993',106,'2026-07-10'::date,440000,'계좌이체','일반',1,'','입금원장'),
  ('d1e5535a-1ab9-56fe-90a1-6f38ece119fd'::uuid,'phone:01026609464',107,'2026-07-10'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('3df308bc-20e2-5b7c-8315-6cff699ffed5'::uuid,'phone:01066339869',9003,'2026-07-10'::date,330000,'계좌이체','일반',1,'수임인 리스트 누적 입금액 보정','수임인보정'),
  ('af6476fa-f4bd-5fa5-8999-35ae54f08914'::uuid,'phone:01083414340',108,'2026-07-11'::date,198000,'계좌이체','일반',1,'','입금원장'),
  ('3ebd28d8-a255-5942-833d-91aa01def9ed'::uuid,'phone:01076706256',109,'2026-07-11'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('bcbef31d-c305-5644-bfd2-46a097e15a25'::uuid,'phone:01095071688',110,'2026-07-12'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('9e3c7804-89c1-531c-ad4f-1bf7da96f0e8'::uuid,'phone:01095283851',111,'2026-07-12'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('6a06e6e8-ef8c-5754-9a86-520563f00789'::uuid,'phone:01064663639',112,'2026-07-13'::date,302000,'계좌이체','일반',1,'','입금원장'),
  ('5351e529-e131-5b72-ad8b-8403c2136af4'::uuid,'phone:01027958846',113,'2026-07-13'::date,180000,'계좌이체','일반',1,'','입금원장'),
  ('d91c5a15-1542-5e77-96a6-7a3713722e79'::uuid,'phone:01049195588',9008,'2026-07-13'::date,440000,'계좌이체','일반',1,'수임인 리스트 누적 입금액 보정 · 상세 입금일 미기재','수임인보정'),
  ('e0dbd0bd-99d3-557b-9d6a-8a1273b32ee5'::uuid,'phone:01056400295',9013,'2026-07-13'::date,100000,'계좌이체','일반',1,'수임인 리스트 계약금 10만원 보정','수임인보정'),
  ('c20ec760-aef8-526e-a781-c7a0e43c5957'::uuid,'phone:01047196953',114,'2026-07-14'::date,550000,'계좌이체','일반',1,'','입금원장'),
  ('c57a0d41-457e-502f-b21e-99f94c24fc0a'::uuid,'phone:01047196953',116,'2026-07-14'::date,250000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('1c4c6a04-671b-5e0f-ad52-67fd66223877'::uuid,'phone:01095283851',117,'2026-07-14'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('e14bfa80-d62f-5475-a8e3-3112f8ec83aa'::uuid,'phone:01066339869',9004,'2026-07-14'::date,462000,'계좌이체','일반',1,'수임인 리스트 누적 입금액 보정','수임인보정'),
  ('89ae0e7f-0628-528a-a99e-1b4968ac456b'::uuid,'phone:01099819641',118,'2026-07-15'::date,540000,'로피결제','일반',1,'','입금원장'),
  ('8eb4a41b-7c53-5abe-a4b0-a7c53b84b258'::uuid,'phone:01021180495',119,'2026-07-15'::date,600000,'계좌이체','일반',1,'','입금원장'),
  ('97b81b18-cded-54f5-87bc-28a88dc0df9e'::uuid,'phone:01084512789',123,'2026-07-15'::date,858000,'계좌이체','일반',1,'','입금원장'),
  ('37d8679a-7057-5613-853d-64ae0f0fc0c4'::uuid,'phone:01038342293',9012,'2026-07-15'::date,110000,'계좌이체','일반',1,'수임인 리스트 누적 입금액 보정','수임인보정'),
  ('a4b84961-8efd-5ae8-a4fd-31fed0163a70'::uuid,'phone:01057009405',9014,'2026-07-15'::date,72600,'계좌이체','일반',1,'수임인 리스트 누적 입금액 보정','수임인보정'),
  ('8963dec4-b6f5-5d3e-beda-9b8bf0d2acdc'::uuid,'phone:01099547952',9009,'2026-07-17'::date,220000,'계좌이체','일반',1,'수임인 리스트 누적 입금액 보정','수임인보정'),
  ('e043fa5c-f89e-5896-95a4-f66e62684823'::uuid,'phone:01058348435',120,'2026-07-19'::date,110000,'로피결제','일반',1,'','입금원장'),
  ('32bf03a7-7c5c-5493-9ab1-7fa088397685'::uuid,'phone:01047196953',121,'2026-07-20'::date,9130000,'계좌이체','일반',1,'','입금원장'),
  ('5285f3d2-a454-5f62-a511-fbec1aff18b7'::uuid,'phone:01043044262',9005,'2026-07-20'::date,700000,'계좌이체','일반',1,'수임인 리스트 계약금/입금액 보정','수임인보정'),
  ('12514549-ee95-5351-8874-c98531c4119f'::uuid,'phone:01026167073',125,'2026-07-24'::date,300000,'로피결제','일반',1,'','입금원장'),
  ('46d2d486-2369-586b-b544-55b4de6d1e05'::uuid,'phone:01080373246',126,'2026-07-25'::date,99000,'로피결제','일반',1,'','입금원장'),
  ('16f4f9f5-dce1-57ce-ac25-16dcae9661d6'::uuid,'phone:01080687102',127,'2026-07-25'::date,99000,'로피결제','일반',1,'','입금원장'),
  ('f008c5b5-0787-5746-a16f-99b0dea6a80c'::uuid,'phone:01058348435',128,'2026-07-26'::date,110000,'로피결제','일반',1,'','입금원장'),
  ('254b3777-4908-5110-8335-1c416a8816bf'::uuid,'phone:01080373246',129,'2026-07-27'::date,66000,'로피결제','일반',1,'','입금원장'),
  ('a3f7c14a-40ca-555d-9659-463a66441500'::uuid,'phone:01099498219',130,'2026-07-27'::date,110000,'로피결제','일반',1,'','입금원장'),
  ('89a9761d-7047-596f-8f05-14b36e2c9cd8'::uuid,'phone:01080942553',131,'2026-07-27'::date,110000,'로피결제','일반',1,'','입금원장'),
  ('7d20e92b-76c6-5e95-8b3f-21a9160d541a'::uuid,'phone:01039916233',132,'2026-07-27'::date,1320000,'계좌이체','일반',1,'','입금원장'),
  ('d66136fd-4f04-5c08-b74a-bb346da5a3c2'::uuid,'phone:01021180495',133,'2026-07-28'::date,500000,'계좌이체','일반',1,'','입금원장'),
  ('f012a9ce-96fd-58f4-9b0e-6f194eb3896f'::uuid,'phone:01047987224',134,'2026-07-29'::date,499500,'계좌이체','환수',1,'성공보수','입금원장'),
  ('dd4b8c6b-780f-5b97-8980-166184ee1159'::uuid,'phone:01030375843',135,'2026-07-29'::date,220000,'로피결제','일반',1,'','입금원장'),
  ('273ffa1e-52d5-50f4-ad8d-ef8a67237d25'::uuid,'phone:01050785684',136,'2026-07-29'::date,385000,'로피결제','일반',1,'','입금원장'),
  ('41ca361f-65d7-5c49-afc6-b3e85603f824'::uuid,'phone:01099570750',137,'2026-07-31'::date,250000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('91968d81-6eef-56ed-a5a8-07e24555e61b'::uuid,'phone:01080807216',138,'2026-07-31'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('84f5b98f-f3d3-5737-b34d-8c88a59466a4'::uuid,'phone:01058348435',139,'2026-07-31'::date,110000,'로피결제','일반',1,'','입금원장'),
  ('a35e6dd0-a754-5dd3-bb12-d2752f6f60bd'::uuid,'phone:01087172713',140,'2026-07-31'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('9e004314-eb0d-5505-887d-b515ffec83f4'::uuid,'phone:01064439477',141,'2026-08-01'::date,165000,'로피결제','일반',1,'','입금원장'),
  ('8caada96-6bdb-5cd2-b367-67b33cd3e7ca'::uuid,'phone:01072055177',142,'2026-08-02'::date,440000,'계좌이체','일반',1,'','입금원장'),
  ('25503fab-9f35-5228-9d1a-75fd29254401'::uuid,'phone:01022474464',143,'2026-08-03'::date,220000,'로피결제','일반',1,'','입금원장'),
  ('8d85ecca-bfbc-5748-bce3-135c0b792f3e'::uuid,'phone:01030788522',144,'2026-08-05'::date,220000,'로피결제','환수',1,'성공보수','입금원장'),
  ('635fb056-3cf1-574d-b7c2-f7ab523f3db9'::uuid,'phone:01026609464',145,'2026-08-07'::date,320000,'계좌이체','일반',1,'','입금원장'),
  ('2f2ed23a-e3f4-5c47-b342-713721f3a143'::uuid,'phone:01068640068',146,'2026-08-10'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('f361799d-8a86-56e3-9a4d-bb9c270431a2'::uuid,'phone:01058348435',147,'2026-08-10'::date,150000,'로피결제','일반',1,'','입금원장'),
  ('6da19535-24d5-59d3-8bff-95562fda86b0'::uuid,'phone:01054149287',148,'2026-08-11'::date,120000,'로피결제','일반',1,'','입금원장'),
  ('7003c9da-acc5-50c2-a6f8-b7e59fbd5df2'::uuid,'phone:01076706256',149,'2026-08-11'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('046319b6-e771-5c6b-aa81-69518d5caa10'::uuid,'phone:01094936362',150,'2026-08-12'::date,400000,'로피결제','일반',1,'','입금원장'),
  ('d24ed86b-27eb-5f22-a76a-01d2c7af3b35'::uuid,'phone:01081104589',151,'2026-08-12'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('b94daec4-9ef1-527c-8974-0d78803caba1'::uuid,'phone:01082044280',152,'2026-08-12'::date,132000,'계좌이체','일반',1,'','입금원장'),
  ('bc1dbe5a-769e-526d-b1c5-bfdd56ef2240'::uuid,'phone:01099547270',153,'2026-08-13'::date,385000,'계좌이체','일반',1,'','입금원장'),
  ('5fab367f-d6c7-58b0-a854-aed976ac7594'::uuid,'phone:01068640068',154,'2026-08-13'::date,275000,'계좌이체','일반',1,'','입금원장'),
  ('ec7f7ecf-8a03-56c8-a09d-0ee730b6d1c8'::uuid,'phone:01054412603',155,'2026-08-14'::date,198000,'계좌이체','일반',1,'','입금원장'),
  ('fa9cb1a1-835f-53fe-913e-6d43d7a155b4'::uuid,'phone:01072061173',156,'2026-08-14'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('5035297b-9882-5b90-afd3-a2ce92e13fa2'::uuid,'phone:01027958846',157,'2026-08-14'::date,50000,'계좌이체','일반',1,'','입금원장'),
  ('e18077dc-82e0-5219-ba77-5cb55fe80000'::uuid,'phone:01081104589',158,'2026-08-14'::date,550000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('288b9017-191c-5063-90e0-dab02aa65d66'::uuid,'phone:01082044280',159,'2026-08-14'::date,66000,'계좌이체','일반',1,'','입금원장'),
  ('f8c3e8c0-2496-55fe-acec-98290780ac2a'::uuid,'phone:01099498219',160,'2026-08-14'::date,440000,'로피결제','일반',1,'','입금원장'),
  ('7cae8573-01f9-56f5-91c1-9870ad917a2f'::uuid,'phone:01099570750',161,'2026-08-15'::date,275000,'계좌이체','일반',1,'','입금원장'),
  ('07c9644c-6714-5c99-8fc6-3fc867a8a0cf'::uuid,'phone:01058621359',162,'2026-08-18'::date,200000,'계좌이체','일반',1,'','입금원장'),
  ('dc297f1c-7ae3-5008-8c6b-bc1d89a417a6'::uuid,'phone:01095283851',163,'2026-08-18'::date,275000,'계좌이체','일반',1,'','입금원장'),
  ('477026b8-fbb1-5940-b90f-cd3b1abc06c7'::uuid,'phone:01076784693',9007,'2026-08-20'::date,550000,'계좌이체','일반',1,'수임인 리스트 계약금 입금완료 보정','수임인보정'),
  ('853f4ef7-e852-5b72-a165-f843546d5123'::uuid,'phone:01050785684',164,'2026-08-21'::date,55000,'로피결제','일반',1,'','입금원장'),
  ('911cd812-9b99-5b78-a89d-3f52c87b63bc'::uuid,'phone:01056618126',165,'2026-08-22'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('b9f0e463-cfc8-5c2a-9912-6bd81131d840'::uuid,'phone:01035803498',166,'2026-08-24'::date,132000,'계좌이체','일반',1,'','입금원장'),
  ('0b4b1be2-de2d-568e-ab1f-2eccc6d69fbb'::uuid,'phone:01030788522',167,'2026-08-25'::date,220000,'로피결제','환수',1,'성공보수','입금원장'),
  ('d96a9ad8-8ac6-56d2-96f3-60f1f23d2cd3'::uuid,'phone:01058503299',168,'2026-08-25'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('34adb781-7c6d-5e6a-9c35-a7564eee3f4c'::uuid,'phone:01087742886',169,'2026-08-25'::date,297000,'계좌이체','일반',1,'','입금원장'),
  ('ecf12a35-8dd4-5c89-aac6-06e4af05babe'::uuid,'phone:01077694474',170,'2026-08-26'::date,200000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('9234d227-6c6c-581e-8d64-77c983ae7ae2'::uuid,'phone:01054412603',171,'2026-08-26'::date,66000,'계좌이체','일반',1,'','입금원장'),
  ('904a175c-366f-5a29-9206-c11d45ba531e'::uuid,'phone:01046596318',172,'2026-08-26'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('5470b0e2-41ce-529a-86b1-0a9334bf24ec'::uuid,'phone:01057000594',173,'2026-08-28'::date,700000,'로피결제','일반',1,'','입금원장'),
  ('7ecf8b3b-2de4-57dc-abdb-f008676ebb59'::uuid,'phone:01047987224',174,'2026-08-29'::date,500000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('12546c36-73bf-50a1-b6c9-1edd9274f2ba'::uuid,'phone:01059018544',175,'2026-08-30'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('d9832e95-99e2-5226-91c6-f985b2b1d998'::uuid,'phone:01077694474',176,'2026-08-31'::date,100000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('c2e33089-1499-5a34-a3ac-e81b6382fc31'::uuid,'phone:01096859806',177,'2026-08-31'::date,200000,'계좌이체','일반',1,'','입금원장'),
  ('33c63266-1262-5e86-b0bf-cd7d78720c08'::uuid,'phone:01080807216',178,'2026-08-31'::date,220000,'로피결제','일반',1,'','입금원장'),
  ('9fb19c44-b979-5b30-82f3-ecf91e3d25d7'::uuid,'phone:01052128531',179,'2026-08-31'::date,500000,'계좌이체','일반',1,'','입금원장'),
  ('45f19033-1dda-524c-92ad-7971d5b8e383'::uuid,'phone:01068680494',180,'2026-08-31'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('6f360d93-9459-5cf8-89c2-5f0234c73389'::uuid,'phone:01029394119',181,'2026-08-31'::date,400000,'계좌이체','일반',1,'','입금원장'),
  ('18685ed8-1522-5886-8f3b-1abb86609acd'::uuid,'phone:01076784693',182,'2026-09-01'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('2831d8d5-a6d9-58a9-a76a-6583aabd831b'::uuid,'phone:01062785563',183,'2026-09-01'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('784af42a-38f2-5c65-9968-e78ea9bd4a51'::uuid,'phone:01052128531',184,'2026-09-01'::date,500000,'계좌이체','일반',1,'','입금원장'),
  ('2d14798c-5266-565c-b2a1-1aa15c5b37b8'::uuid,'phone:01087172713',185,'2026-09-01'::date,200000,'계좌이체','일반',1,'','입금원장'),
  ('0c9346f1-7847-5bb4-9adf-45da63fc24e7'::uuid,'phone:01026167073',186,'2026-09-01'::date,150000,'로피결제','일반',1,'','입금원장'),
  ('fdcb0006-9612-574a-8b05-c34fe9ef763c'::uuid,'phone:01099775135',187,'2026-09-01'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('397c1b24-e470-5ce1-9ba6-0c105b75f7ba'::uuid,'phone:01083902225',188,'2026-09-02'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('c027c625-79fc-5b36-a338-44757a3f1b44'::uuid,'phone:01035803498',189,'2026-09-02'::date,70000,'계좌이체','일반',1,'','입금원장'),
  ('e926be7d-d235-5658-a845-0d639963c614'::uuid,'phone:01052128531',190,'2026-09-02'::date,500000,'계좌이체','일반',1,'','입금원장'),
  ('3f4150e3-be3f-53ee-95f2-6498511e0235'::uuid,'phone:01054412603',191,'2026-09-03'::date,275000,'계좌이체','일반',1,'','입금원장'),
  ('65ffdd67-948b-5e63-b8d1-7f8f10165645'::uuid,'phone:01052229841',192,'2026-09-04'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('c1b43a88-2a6d-53ed-84de-a37a51667857'::uuid,'phone:01025235003',193,'2026-09-04'::date,400000,'계좌이체','일반',1,'','입금원장'),
  ('f44f1374-95d6-50e5-a9eb-feb3231cab91'::uuid,'phone:01051912863',194,'2026-09-04'::date,165000,'계좌이체','일반',1,'','입금원장'),
  ('271fe0fb-97c2-568e-9d51-f3c57806da4a'::uuid,'phone:01025235003',195,'2026-09-04'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('7648d4a3-98f3-59a4-8911-986d82bf8444'::uuid,'phone:01099547270',196,'2026-09-05'::date,385000,'계좌이체','일반',1,'','입금원장'),
  ('50a3a730-f575-5e47-9ecb-83302c44bbc1'::uuid,'phone:01035903975',197,'2026-09-06'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('cb0142d6-231b-5a24-9dbb-abdbb524b44c'::uuid,'phone:01057000594',198,'2026-09-07'::date,400000,'계좌이체','일반',1,'','입금원장'),
  ('53b04155-cb7d-5e45-99ba-34183131dcdf'::uuid,'phone:01052128531',199,'2026-09-07'::date,535000,'계좌이체','일반',1,'','입금원장'),
  ('70b3a9c7-2fdf-545a-84af-c964d4c880c7'::uuid,'phone:01080177526',200,'2026-09-07'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('12030d7d-a939-543c-8faf-e8428e12837c'::uuid,'phone:01035903975',201,'2026-09-08'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('823ae988-ad79-5eff-a63e-c19b50420db0'::uuid,'phone:01051024229',202,'2026-09-08'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('44e6a640-a790-523f-9431-feb329224c5a'::uuid,'phone:01099684261',203,'2026-09-08'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('22d7e0fb-fc64-5284-8012-264309ee622b'::uuid,'phone:01035803498',204,'2026-09-09'::date,70000,'계좌이체','일반',1,'','입금원장'),
  ('8999423f-975f-5d96-9cd4-e0054a9c4a65'::uuid,'phone:01051024229',205,'2026-09-09'::date,55000,'계좌이체','일반',1,'','입금원장'),
  ('ec204a49-4ef4-5518-a7ff-e7b9c5da565d'::uuid,'phone:01055160139',206,'2026-09-09'::date,275000,'계좌이체','일반',1,'','입금원장'),
  ('61cbd0c8-cc10-56e3-ac3e-93d8e18f3325'::uuid,'phone:01052128531',207,'2026-09-10'::date,750000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('483bb678-0952-5143-9be3-5f777494fda4'::uuid,'phone:01050785684',208,'2026-09-10'::date,385000,'로피결제','일반',1,'','입금원장'),
  ('6771d916-7c97-5af7-b00f-727d52b0b81a'::uuid,'phone:01098599087',209,'2026-09-10'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('7ea3b0ca-3bb5-53b9-b35b-cbdc83b9f748'::uuid,'phone:01058555680',210,'2026-09-11'::date,320000,'계좌이체','일반',1,'','입금원장'),
  ('09d600fd-9497-5a31-aae6-f7f70c4e2b5b'::uuid,'phone:01022474464',211,'2026-09-12'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('4c8c78aa-34c7-586e-96bf-ebcea57d069c'::uuid,'phone:01025571482',212,'2026-09-12'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('37e3c86f-7c3f-5106-886e-309ee11c80b5'::uuid,'phone:01072061173',213,'2026-09-14'::date,200000,'계좌이체','일반',1,'','입금원장'),
  ('2ca4698c-f51b-541c-92a4-e5e87c795bfb'::uuid,'phone:01027958846',214,'2026-09-14'::date,350000,'계좌이체','일반',1,'','입금원장'),
  ('db35f65e-67da-5223-9a96-58d58bd02816'::uuid,'phone:01025571482',215,'2026-09-15'::date,165000,'계좌이체','일반',1,'','입금원장'),
  ('f2b19ecf-880b-51c8-b008-df221bf4e61c'::uuid,'phone:01055955376',216,'2026-09-15'::date,2000000,'계좌이체','일반',1,'','입금원장'),
  ('67d5b7e8-aecc-5ff0-82d1-5f08f849c9aa'::uuid,'phone:01050785684',217,'2026-09-15'::date,55000,'로피결제','일반',1,'','입금원장'),
  ('56633322-e539-5ebd-8c6e-219eaa08bc28'::uuid,'phone:01072061173',218,'2026-09-16'::date,130000,'계좌이체','일반',1,'','입금원장'),
  ('d1a52bfe-8a75-5054-82d8-9149a5f7eeb7'::uuid,'phone:01035803498',219,'2026-09-16'::date,70000,'계좌이체','일반',1,'','입금원장'),
  ('904256a8-cfd9-52a8-b881-07a419fa69f1'::uuid,'phone:01097491875',220,'2026-09-16'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('fa3caed2-a616-5cfd-836b-466482e7cab1'::uuid,'phone:01024831802',222,'2026-09-17'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('bdf667fd-a3db-5a9a-8d7c-d0036a0548dd'::uuid,'phone:01077694474',223,'2026-09-17'::date,200000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('323d1566-ebb1-584b-aaa6-18fb648e178e'::uuid,'phone:01099776806',9006,'2026-09-17'::date,550000,'계좌이체','일반',1,'수임인 리스트 계약금 입금완료 보정','수임인보정'),
  ('69db352b-b7ec-507d-bda8-e7b285caacee'::uuid,'phone:01089605636',224,'2026-09-18'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('c44baa84-57d2-55c8-bc8d-e5dcbe61e5e3'::uuid,'phone:01074198963',225,'2026-09-18'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('8d73cbbb-7d88-51fd-8d94-e86a62ed9b20'::uuid,'phone:01034452014',226,'2026-09-18'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('71085760-3d55-5f86-a187-c8650df71f6d'::uuid,'phone:01057438069',227,'2026-09-19'::date,200000,'계좌이체','일반',1,'','입금원장'),
  ('362162ca-d6ed-5f80-8656-2e78a726c83e'::uuid,'phone:01054029233',228,'2026-09-20'::date,605000,'계좌이체','일반',1,'','입금원장'),
  ('caf78d79-80d3-5ac7-ba5a-f36f228dd1a9'::uuid,'phone:01081104589',229,'2026-09-21'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('ab858ad0-156a-5b8f-97d4-3ea6ae9ac169'::uuid,'phone:01081104589',230,'2026-09-21'::date,550000,'계좌이체','환수',1,'성공보수','입금원장'),
  ('64a32128-fe62-5452-a68f-96b16421eb05'::uuid,'phone:01064489330',231,'2026-09-21'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('e35bd014-6738-5002-9f63-8031addb50e4'::uuid,'phone:01058348435',232,'2026-09-21'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('57a9d5f0-1fa2-5784-8e99-a37fc63ae796'::uuid,'phone:01022474464',233,'2026-09-21'::date,220000,'계좌이체','일반',1,'','입금원장'),
  ('934496d0-d739-5d65-8232-ed3e7e7740e6'::uuid,'phone:01057289547',234,'2026-09-21'::date,200000,'계좌이체','일반',1,'','입금원장'),
  ('45eb74d7-c6a8-58f1-ac4c-379a81510448'::uuid,'phone:01022474464',235,'2026-09-22'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('8791e0b6-076c-540e-8856-e859ccbdbced'::uuid,'phone:01089605636',236,'2026-09-22'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('e159dcda-83e0-50fa-9117-31d9e4465920'::uuid,'phone:01085419159',237,'2026-09-23'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('9feef46c-b6f5-5381-b7e6-472b5fe7193b'::uuid,'phone:01058052428',239,'2026-09-23'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('359240d9-448a-57ee-a5da-5ab923a07164'::uuid,'phone:01066554394',240,'2026-09-23'::date,330000,'계좌이체','일반',1,'','입금원장'),
  ('4eda8c4b-df33-5a8a-8800-bfd586687501'::uuid,'phone:01057289547',241,'2026-09-23'::date,300000,'계좌이체','일반',1,'','입금원장'),
  ('3a196742-933b-56e7-809d-1f107782acab'::uuid,'phone:01030788522',242,'2026-09-23'::date,220000,'로피결제','환수',1,'성공보수','입금원장'),
  ('2b838afa-6da7-577c-b8e4-e7764eadfd9a'::uuid,'phone:01080373246',254,'2026-09-23'::date,200000,'계좌이체','일반',1,'','입금원장'),
  ('4ced8c89-5a63-5fd1-9a0a-8c4ee122e9cd'::uuid,'phone:01073190700',243,'2026-09-27'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('80889771-09d8-579c-83c9-72ccc3627cab'::uuid,'phone:01056239694',245,'2026-09-27'::date,440000,'계좌이체','일반',1,'','입금원장'),
  ('d03d713f-948a-5315-a2f5-7a810b920e88'::uuid,'phone:01031273213',9001,'2026-09-27'::date,220000,'계좌이체','일반',1,'수임인 리스트 계약금 22만원 · 입금원장 금액 공란 보정','수임인보정'),
  ('0d29ee37-c29a-5808-852b-fce2c85b0738'::uuid,'phone:01062785563',246,'2026-09-28'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('b3550a79-d7d2-537d-923b-36d0e9023b01'::uuid,'phone:01056415221',247,'2026-09-28'::date,100000,'계좌이체','일반',1,'','입금원장'),
  ('28d3f2d7-43d3-574d-a7d7-9afeabd0baad'::uuid,'phone:01040482629',251,'2026-09-28'::date,440000,'계좌이체','일반',1,'','입금원장'),
  ('648e1837-d0f1-5180-8b86-8d62e3dfc7ed'::uuid,'phone:01091991108',252,'2026-09-28'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('4942f42d-2376-5155-a27d-73fd1e1a48b4'::uuid,'phone:01058503299',253,'2026-09-28'::date,110000,'계좌이체','일반',1,'','입금원장'),
  ('e8281613-18dc-5b13-8c45-d55d72f3f386'::uuid,'phone:01031273213',9002,'2026-09-28'::date,1000000,'계좌이체','일반',1,'수임인 리스트 누적 입금액 기준 · 입금원장 금액 공란 보정','수임인보정'),
  ('95391b1b-f619-596e-a3f1-c730356b5649'::uuid,'phone:01058052428',255,'2026-09-29'::date,110000,'계좌이체','일반',1,'','입금원장')
), resolved as (
  select p.*, public.ropower_v74_resolve_customer(p.stage_key) as customer_id
  from p
)
insert into public.payment_schedules(
  id,customer_id,due_date,expected_amount,paid_date,paid_amount,status,payment_method,memo,
  schedule_type,reschedule_sequence,admin_created_at,deleted_at,
  legacy_imported,legacy_source_row,legacy_source_kind,legacy_reconcile_note
)
select
  p.id,p.customer_id,p.paid_date,p.paid_amount,p.paid_date,p.paid_amount,'완료',p.payment_method,p.memo,
  p.schedule_type,0,
  (p.paid_date::timestamp + interval '12 hours' + (p.source_row % 1000) * interval '1 second') at time zone 'Asia/Seoul',
  null,true,p.source_row,p.source_kind,
  case when p.source_kind='수임인보정' then '수임인 리스트 누적 입금액과 실입금 원장 대조 보정' else '' end
from resolved p
where p.customer_id is not null
  and (
    select count(*)
    from public.payment_schedules x
    where x.customer_id=p.customer_id
      and x.deleted_at is null
      and x.status='완료'
      and x.paid_date=p.paid_date
      and coalesce(x.paid_amount,0)=p.paid_amount
      and coalesce(nullif(x.payment_method,''),'계좌이체')=p.payment_method
      and coalesce(nullif(x.schedule_type,''),'일반')=p.schedule_type
      and coalesce(x.legacy_imported,false)=false
  ) < p.duplicate_rank
on conflict(id) do update set
  customer_id=excluded.customer_id,
  due_date=excluded.due_date,
  expected_amount=excluded.expected_amount,
  paid_date=excluded.paid_date,
  paid_amount=excluded.paid_amount,
  status='완료',
  payment_method=excluded.payment_method,
  memo=excluded.memo,
  schedule_type=excluded.schedule_type,
  reschedule_sequence=0,
  deleted_at=null,
  legacy_imported=true,
  legacy_source_row=excluded.legacy_source_row,
  legacy_source_kind=excluded.legacy_source_kind,
  legacy_reconcile_note=excluded.legacy_reconcile_note;

-- 7) 수임인 리스트와 직접 매칭되지 않는 입금 및 사채 수임료 외 입금은 정산표 '기타'로 분리
with o(id,stage_key,source_row,payment_date,amount,payment_method,client_name,memo) as (
  values
  ('f9828ae3-0771-5761-905c-b5e263d6987b'::uuid,'paymentonly:엄정호',31,'2026-05-27'::date,100000,'계좌이체','엄정호','수임인 리스트 대조 불가 · 입금원장 실입금'),
  ('3fd67494-b32f-5ea5-b46e-2895484709de'::uuid,'paymentonly:박시하',39,'2026-05-29'::date,200000,'계좌이체','박시하','수임인 리스트 대조 불가 · 입금원장 실입금'),
  ('d7c0c4f9-b951-5382-9601-765311ca9a1e'::uuid,'phone:01047196953',115,'2026-07-14'::date,550000,'계좌이체','노아라','사채 수임료 외 입금으로 분리'),
  ('91cd5b97-2ed0-5b0a-9e0c-df9ce96a90ce'::uuid,'paymentonly:김윤태',221,'2026-09-17'::date,550000,'계좌이체','김윤태','수임인 리스트 대조 불가 · 입금원장 실입금'),
  ('c0a6721a-0828-51f4-b58d-b24f7927252d'::uuid,'paymentonly:최정환',250,'2026-09-28'::date,385000,'계좌이체','최정환','수임인 리스트 대조 불가 · 입금원장 실입금')
), resolved as (
  select o.*, public.ropower_v74_resolve_customer(o.stage_key) as customer_id
  from o
)
insert into public.settlement_entries(
  id,payment_date,client_name,amount,payment_method,memo,
  customer_id,source_payment_schedule_id,entry_source,entry_type,deleted_at,
  legacy_imported,legacy_source_row,legacy_source_kind
)
select
  o.id,o.payment_date,o.client_name,o.amount,o.payment_method,o.memo,
  o.customer_id,null,'manual','기타',null,
  true,o.source_row,'기타실입금'
from resolved o
on conflict(id) do update set
  payment_date=excluded.payment_date,
  client_name=excluded.client_name,
  amount=excluded.amount,
  payment_method=excluded.payment_method,
  memo=excluded.memo,
  customer_id=excluded.customer_id,
  entry_source='manual',
  entry_type='기타',
  deleted_at=null,
  legacy_imported=true,
  legacy_source_row=excluded.legacy_source_row,
  legacy_source_kind='기타실입금';

-- 8) 기술용 이관 문자열 제거
update public.payment_schedules
set memo=btrim(
  regexp_replace(
    regexp_replace(coalesce(memo,''),'^\[입금/분납 자동연동\][^·\n]*(·\s*)?','','i'),
    '^\[ROPOWER_LEGACY_IMPORT_V[0-9.]+\][^\n]*?(·\s*)?','','i'
  )
)
where deleted_at is null;

update public.settlement_entries
set memo=btrim(
  regexp_replace(
    regexp_replace(coalesce(memo,''),'^\[입금/분납 자동연동\][^·\n]*(·\s*)?','','i'),
    '^\[ROPOWER_LEGACY_IMPORT_V[0-9.]+\][^\n]*?(·\s*)?','','i'
  )
)
where deleted_at is null;

-- 9) 헬퍼 제거
drop function if exists public.ropower_v74_resolve_customer(text);

-- 10) 트리거 복구
do $$
begin
  if exists(select 1 from pg_trigger where tgrelid='public.payment_schedules'::regclass and tgname='trg_prevent_staff_soft_delete' and not tgisinternal) then
    execute 'alter table public.payment_schedules enable trigger trg_prevent_staff_soft_delete';
  end if;
  if exists(select 1 from pg_trigger where tgrelid='public.payment_schedules'::regclass and tgname='trg_change_history_payments' and not tgisinternal) then
    execute 'alter table public.payment_schedules enable trigger trg_change_history_payments';
  end if;
  if exists(select 1 from pg_trigger where tgrelid='public.settlement_entries'::regclass and tgname='trg_change_history_settlements' and not tgisinternal) then
    execute 'alter table public.settlement_entries enable trigger trg_change_history_settlements';
  end if;
  if exists(select 1 from pg_trigger where tgrelid='public.customers'::regclass and tgname='trg_change_history_customers' and not tgisinternal) then
    execute 'alter table public.customers enable trigger trg_change_history_customers';
  end if;
end $$;

commit;

-- ===== 검증용 =====
-- 1) V7.4가 만든 완료 분납/입금 일정
select
  count(*) as legacy_payment_rows,
  coalesce(sum(paid_amount),0) as payment_total,
  coalesce(sum(paid_amount) filter (where schedule_type='환수'),0) as recovery_paid,
  coalesce(sum(paid_amount) filter (where schedule_type<>'환수'),0) as contract_paid
from public.payment_schedules
where deleted_at is null and legacy_imported=true and legacy_source_kind in ('입금원장','수임인보정');

-- 예상: payment_total 99,976,600 / recovery_paid 11,648,000 / contract_paid 88,328,600

-- 2) 정산표 기타 실입금
select count(*) as other_rows, coalesce(sum(amount),0) as other_total
from public.settlement_entries
where deleted_at is null and legacy_imported=true and legacy_source_kind='기타실입금';
-- 예상: 5건 / 1,785,000원

-- 3) 레거시 계약 총액 / 계약 실입금 / 미수금
with paid as (
  select customer_id,coalesce(sum(paid_amount),0) paid
  from public.payment_schedules
  where deleted_at is null and status<>'환불' and coalesce(schedule_type,'일반')<>'환수'
  group by customer_id
), extras as (
  select customer_id,coalesce(sum(contract_amount),0) extra_contract
  from public.additional_contracts
  where deleted_at is null
  group by customer_id
)
select
  coalesce(sum(coalesce(c.contract_amount,0)+coalesce(e.extra_contract,0)),0) as total_contract,
  coalesce(sum(coalesce(p.paid,0)),0) as total_contract_paid,
  coalesce(sum(greatest(0,coalesce(c.contract_amount,0)+coalesce(e.extra_contract,0)-coalesce(p.paid,0))),0) as total_receivable
from public.customers c
left join paid p on p.customer_id=c.id
left join extras e on e.customer_id=c.id
where c.deleted_at is null and coalesce(c.legacy_imported,false)=true;

-- 원본 수임인 총 선임료 304,870,000원 + 선임료 X였으나 실입금 확인된 이선구 550,000원 = 보정 계약총액 305,420,000원
-- V7.4 계약 실입금 88,328,600원 기준 단순 총차액은 217,091,400원이며,
-- 실제 화면 미수금은 고객별 초과입금을 0 아래로 차감하지 않는 방식으로 계산됩니다.
