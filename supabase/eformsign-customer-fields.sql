alter table public.customers add column if not exists address text;
alter table public.customers add column if not exists birth_number text;
notify pgrst, 'reload schema';
