-- V37.11.13: 부분납부(연체 상태) 실제 입금분도 정산표에 반영.
-- 기존 sync_payment_schedule_to_settlement 트리거 뒤에 실행되는 보완 트리거.
-- 과거 기록을 강제로 재생성하지 않으며, 향후 해당 입금 일정이 저장될 때만 동기화.
-- 기존 완료 / 환수 / 추가계약 처리는 원 트리거가 담당.
create or replace function public.dowon_sync_partial_payment_settlement()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_name text;
begin
  if new.deleted_at is not null or new.status not in ('연체','미납')
     or new.paid_date is null or coalesce(new.paid_amount,0)<=0
     or new.schedule_type='환수' then
    return new;
  end if;
  select name into v_name from public.customers where id=new.customer_id;
  -- 기존 자동연동 행이 존재하면 금액 / 날짜를 갱신 (정산 중복 행 생성 방지)
  insert into public.settlement_entries
  (payment_date,client_name,amount,payment_method,memo,customer_id,
   source_payment_schedule_id,entry_source,entry_type,deleted_at)
  values(new.paid_date,coalesce(v_name,''),new.paid_amount,
         coalesce(nullif(new.payment_method,''),'계좌이체'),
         '[입금/분납 자동연동] 부분납부 실제입금 · '||coalesce(new.memo,''),
         new.customer_id,new.id,'payment','계약',null)
  on conflict (source_payment_schedule_id) where source_payment_schedule_id is not null
    do update set payment_date=excluded.payment_date,client_name=excluded.client_name,
      amount=excluded.amount,payment_method=excluded.payment_method,memo=excluded.memo,
      customer_id=excluded.customer_id,entry_source='payment',entry_type='계약',deleted_at=null;
  return new;
end;$$;
drop trigger if exists trg_zz_dowon_partial_payment_settlement on public.payment_schedules;
create trigger trg_zz_dowon_partial_payment_settlement
after insert or update on public.payment_schedules
for each row execute function public.dowon_sync_partial_payment_settlement();
