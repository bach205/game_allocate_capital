alter table public.rooms
add column if not exists is_draft boolean default false;
