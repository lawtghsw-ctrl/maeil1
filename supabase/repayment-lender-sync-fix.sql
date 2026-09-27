-- 상환완료 상태 호환 + 사채업체 자동등록 중복 제한 해제
-- 기존 데이터는 삭제하지 않습니다.

-- 1) 구버전('완료')과 현재 UI('상환완료')를 모두 허용
alter table public.repayment_schedules
  drop constraint if exists repayment_schedules_status_check;

alter table public.repayment_schedules
  add constraint repayment_schedules_status_check
  check (status in ('예정','완료','상환완료','연체','보류'));

-- 2) lender_contacts에 연락처 중복을 막는 UNIQUE 제약조건이 있으면 모두 제거
do $$
declare r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.lender_contacts'::regclass
      and contype = 'u'
  loop
    execute format('alter table public.lender_contacts drop constraint if exists %I', r.conname);
  end loop;
end $$;

-- 3) 제약조건과 별개로 생성된 UNIQUE INDEX가 있으면 제거 (PK 인덱스 제외)
do $$
declare r record;
begin
  for r in
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'lender_contacts'
      and indexdef ilike 'create unique index%'
      and indexdef not ilike '%(id)%'
  loop
    execute format('drop index if exists public.%I', r.indexname);
  end loop;
end $$;
