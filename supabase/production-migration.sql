-- 기존에 만든 스키마에 운영 UI 필드를 맞추는 추가 마이그레이션
alter table public.customers add column if not exists contract_date date;
alter table public.customers add column if not exists address text;
alter table public.customers add column if not exists birth_number text;

-- 상환 상태를 현재 Admin UI와 통일
alter table public.repayment_schedules drop constraint if exists repayment_schedules_status_check;
alter table public.repayment_schedules add constraint repayment_schedules_status_check
check (status in ('예정','상환완료','연체','보류'));

-- 게시판 첨부파일용 비공개 Storage bucket
insert into storage.buckets (id,name,public,file_size_limit)
values ('board-files','board-files',false,null)
on conflict (id) do update set public=false, file_size_limit=null;

-- 인증 사용자만 내부 첨부파일 접근
drop policy if exists "board files authenticated select" on storage.objects;
drop policy if exists "board files authenticated insert" on storage.objects;
drop policy if exists "board files authenticated update" on storage.objects;
drop policy if exists "board files authenticated delete" on storage.objects;

create policy "board files authenticated select"
on storage.objects for select to authenticated
using (bucket_id='board-files');

create policy "board files authenticated insert"
on storage.objects for insert to authenticated
with check (bucket_id='board-files');

create policy "board files authenticated update"
on storage.objects for update to authenticated
using (bucket_id='board-files')
with check (bucket_id='board-files');

create policy "board files authenticated delete"
on storage.objects for delete to authenticated
using (bucket_id='board-files');
