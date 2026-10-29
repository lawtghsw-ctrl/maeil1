-- V37.11.21: 환수금 배분 / 의뢰인 반환의 현금 출금 장부
-- 필수 선행: V37_11_14_RECOVERY_ALLOCATIONS.sql 및 해당 후속 마이그레이션
-- 운영 적용 전 DB 백업 및 스테이징 테스트 필수
begin;
alter table public.recovery_fee_splits add column if not exists refund_due numeric(14,0) not null default 0 check(refund_due>=0);
create table if not exists public.recovery_refunds (
 id uuid primary key default gen_random_uuid(),
 recovery_id uuid not null references public.recoveries(id),
 customer_id uuid not null references public.customers(id),
 refund_date date not null,
 amount numeric(14,0) not null check(amount>0 and amount=trunc(amount)),
 recipient_name text not null check(length(btrim(recipient_name))>0),
 payment_method text not null default '계좌이체',
 memo text not null default '',
 created_at timestamptz not null default now(),
 request_key uuid not null unique
);
create index if not exists recovery_refunds_recovery_idx on public.recovery_refunds(recovery_id);
create index if not exists recovery_refunds_date_idx on public.recovery_refunds(refund_date);
alter table public.recovery_refunds enable row level security;
drop policy if exists recovery_refunds_read on public.recovery_refunds;
create policy recovery_refunds_read on public.recovery_refunds for select to authenticated using(true);
revoke insert,update,delete on public.recovery_refunds from public,anon,authenticated;
grant select on public.recovery_refunds to authenticated;
create or replace function public.dowon_apply_recovery_split(p_recovery_id uuid,p_success_fee numeric,p_allocations jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare v_r public.recoveries%rowtype; v_item jsonb;v_id uuid;v_amount numeric;v_total numeric:=0;v_current numeric;v_used numeric;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다';end if;
 select * into v_r from public.recoveries where id=p_recovery_id and deleted_at is null for update;
 if not found then raise exception '환수 내역을 찾을 수 없습니다'; end if;
 if exists(select 1 from public.recovery_fee_splits where recovery_id=p_recovery_id) then raise exception '이미 분배된 환수금입니다. 기존 분배는 변경할 수 없습니다';end if;
 if p_success_fee is null or p_success_fee<0 or p_success_fee<>trunc(p_success_fee) then raise exception '성공보수 금액 오류';end if;
 if jsonb_typeof(p_allocations) <> 'array' then raise exception '분납 충당 목록 형식 오류';end if;
 if jsonb_array_length(p_allocations)>100 then raise exception '충당 건수가 너무 많습니다';end if;
 if (select count(*) from jsonb_array_elements(p_allocations) x)<>(select count(distinct x->>'paymentId') from jsonb_array_elements(p_allocations) x) then raise exception '중복 분납 일정이 있습니다';end if;
 for v_item in select value from jsonb_array_elements(p_allocations) loop
  v_id:=(v_item->>'paymentId')::uuid;v_amount:=(v_item->>'amount')::numeric;
  if v_amount is null or v_amount<=0 or v_amount<>trunc(v_amount) then raise exception '충당금액은 양의 정수여야 합니다';end if;
  select greatest(0,expected_amount-coalesce(paid_amount,0)) into v_current
   from public.payment_schedules where id=v_id and customer_id=v_r.customer_id and deleted_at is null
   and coalesce(schedule_type,'일반') not in ('환수','추가계약') and status <> '환불' for update;
  if not found then raise exception '선택한 분납 일정이 유효하지 않습니다';end if;
  -- 재약정 후속이 존재하는 원본은 이중 충당 방지를 위해 제외
  if exists(select 1 from public.payment_schedules where rescheduled_from_id=v_id and deleted_at is null) then raise exception '재약정 후속이 있는 원본은 충당할 수 없습니다';end if;
  select coalesce(sum(amount),0) into v_used from public.recovery_fee_allocations where payment_schedule_id=v_id;
  if v_amount>v_current-v_used then raise exception '해당 일정의 충당 가능 잔액을 초과했습니다';end if;
  v_total:=v_total+v_amount;
 end loop;
 if p_success_fee+v_total>v_r.amount then raise exception '성공보수와 분납 충당액이 환수금액을 초과했습니다';end if;
 insert into public.recovery_fee_splits(recovery_id,customer_id,success_fee,applied_fee,refund_due) values(p_recovery_id,v_r.customer_id,p_success_fee,v_total,v_r.amount-p_success_fee-v_total);
 for v_item in select value from jsonb_array_elements(p_allocations) loop
  insert into public.recovery_fee_allocations(recovery_id,customer_id,payment_schedule_id,amount)
  values(p_recovery_id,v_r.customer_id,(v_item->>'paymentId')::uuid,(v_item->>'amount')::numeric);
 end loop;
end;$$;
revoke all on function public.dowon_apply_recovery_split(uuid,numeric,jsonb) from public,anon;
grant execute on function public.dowon_apply_recovery_split(uuid,numeric,jsonb) to authenticated;

create or replace function public.dowon_record_recovery_refund(
 p_recovery_id uuid,p_date date,p_amount numeric,p_recipient text,p_method text,p_memo text,p_request_key uuid
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_recovery public.recoveries%rowtype;v_split public.recovery_fee_splits%rowtype;v_paid numeric;v_existing uuid;v_new uuid;
begin
 if auth.uid() is null then raise exception '로그인이 필요합니다';end if;
 if p_request_key is null then raise exception '중복 저장 방지 키가 필요합니다';end if;
 select id into v_existing from public.recovery_refunds where request_key=p_request_key;
 if found then return v_existing;end if;
 select * into v_recovery from public.recoveries where id=p_recovery_id and deleted_at is null for update;
 if not found then raise exception '환수 정보가 없습니다';end if;
 select * into v_split from public.recovery_fee_splits where recovery_id=p_recovery_id for update;
 if not found then raise exception '먼저 환수금 배분을 확정하세요';end if;
 if p_date is null or p_amount is null or p_amount<=0 or p_amount<>trunc(p_amount) or nullif(btrim(p_recipient),'') is null then
  raise exception '반환일·금액·실제 수취인을 확인하세요';end if;
 select coalesce(sum(amount),0) into v_paid from public.recovery_refunds where recovery_id=p_recovery_id;
 if p_amount>v_split.refund_due-v_paid then raise exception '반환 가능 잔액을 초과했습니다';end if;
 insert into public.recovery_refunds(recovery_id,customer_id,refund_date,amount,recipient_name,payment_method,memo,request_key)
 values(p_recovery_id,v_recovery.customer_id,p_date,p_amount,btrim(p_recipient),coalesce(nullif(p_method,''),'계좌이체'),coalesce(p_memo,''),p_request_key)
 returning id into v_new;
 return v_new;
end;$$;
revoke all on function public.dowon_record_recovery_refund(uuid,date,numeric,text,text,text,uuid) from public,anon;
grant execute on function public.dowon_record_recovery_refund(uuid,date,numeric,text,text,text,uuid) to authenticated;
commit;
