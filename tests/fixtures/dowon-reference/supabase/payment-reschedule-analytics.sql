-- 연체 → 재약정 납부일정 연결 구조
-- 기존 입금/분납 데이터는 삭제하지 않습니다.
-- 기존 일정은 모두 '일반' 일정으로 유지되고, 이후 재약정 일정만 별도 연결됩니다.

begin;

alter table public.payment_schedules add column if not exists schedule_type text;
alter table public.payment_schedules add column if not exists root_schedule_id uuid;
alter table public.payment_schedules add column if not exists rescheduled_from_id uuid;
alter table public.payment_schedules add column if not exists reschedule_sequence integer;

-- 기존 데이터 보정이 기간별 변동내역에 대량의 수정 로그로 찍히지 않도록
-- 이 migration 동안에만 입금/분납 변경로그 trigger를 잠시 끕니다.
do $$
begin
  if exists (select 1 from pg_trigger where tgrelid='public.payment_schedules'::regclass and tgname='trg_change_history_payments' and not tgisinternal) then
    execute 'alter table public.payment_schedules disable trigger trg_change_history_payments';
  end if;
end $$;

update public.payment_schedules set schedule_type='일반' where schedule_type is null or schedule_type='';
update public.payment_schedules set root_schedule_id=id where root_schedule_id is null;
update public.payment_schedules set reschedule_sequence=0 where reschedule_sequence is null;

alter table public.payment_schedules alter column schedule_type set default '일반';
alter table public.payment_schedules alter column schedule_type set not null;
alter table public.payment_schedules alter column reschedule_sequence set default 0;
alter table public.payment_schedules alter column reschedule_sequence set not null;

alter table public.payment_schedules drop constraint if exists payment_schedules_schedule_type_check;
alter table public.payment_schedules add constraint payment_schedules_schedule_type_check
check (schedule_type in ('일반','재약정'));

-- 자기 자신을 원본 일정으로 자동 연결합니다. 재약정 일정은 Admin이 원본 root를 지정합니다.
create or replace function public.set_payment_schedule_root()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  if new.root_schedule_id is null then
    new.root_schedule_id := new.id;
  end if;
  if new.schedule_type is null or new.schedule_type = '' then
    new.schedule_type := '일반';
  end if;
  if new.reschedule_sequence is null then
    new.reschedule_sequence := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_payment_schedule_root on public.payment_schedules;
create trigger trg_set_payment_schedule_root
before insert on public.payment_schedules
for each row execute function public.set_payment_schedule_root();

-- 동일한 납부건에서 같은 단계의 재약정이 중복 생성되는 실수를 방지합니다.
create unique index if not exists payment_schedules_rescheduled_from_unique_idx
on public.payment_schedules(rescheduled_from_id)
where rescheduled_from_id is not null and deleted_at is null;

create index if not exists payment_schedules_root_schedule_idx
on public.payment_schedules(root_schedule_id,reschedule_sequence,admin_created_at desc);

create index if not exists payment_schedules_schedule_type_idx
on public.payment_schedules(schedule_type,admin_created_at desc);

-- 변경로그 trigger가 기존에 있었다면 즉시 다시 활성화합니다.
do $$
begin
  if exists (select 1 from pg_trigger where tgrelid='public.payment_schedules'::regclass and tgname='trg_change_history_payments' and not tgisinternal) then
    execute 'alter table public.payment_schedules enable trigger trg_change_history_payments';
  end if;
end $$;

commit;
