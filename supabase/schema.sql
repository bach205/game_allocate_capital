create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  admin_id uuid references auth.users(id) on delete cascade,
  current_round integer default 0,
  status text default 'waiting' check (status in ('waiting', 'playing', 'revealing')),
  countdown_end timestamptz,
  is_draft boolean default false,
  created_at timestamptz default now()
);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references public.rooms(id) on delete cascade,
  name text not null,
  score integer default 0,
  session_token text unique not null,
  created_at timestamptz default now(),
  constraint max_teams_per_room check (true)
);

create table if not exists public.selections (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references public.rooms(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  round_number integer not null,
  resource text not null check (resource in ('gold', 'oil', 'labor')),
  is_default boolean default false,
  created_at timestamptz default now(),
  unique(team_id, round_number)
);

create index if not exists rooms_admin_id_idx on public.rooms(admin_id);
create index if not exists rooms_code_idx on public.rooms(code);
create index if not exists teams_room_id_idx on public.teams(room_id);
create index if not exists teams_session_token_idx on public.teams(session_token);
create index if not exists selections_room_round_idx on public.selections(room_id, round_number);

-- Admin is hardcoded in the frontend for this MVP, so admin actions are sent
-- with the public anon key rather than a Supabase Auth user.
alter table public.rooms disable row level security;
alter table public.teams disable row level security;
alter table public.selections disable row level security;

drop policy if exists "Admins can create rooms" on public.rooms;
drop policy if exists "Admins can read own rooms" on public.rooms;
drop policy if exists "Admins can update own rooms" on public.rooms;
drop policy if exists "Admins can delete own rooms" on public.rooms;
drop policy if exists "Public can read rooms for gameplay" on public.rooms;
drop policy if exists "Public can manage rooms" on public.rooms;

create policy "Public can manage rooms" on public.rooms
  for all
  using (true)
  with check (true);

drop policy if exists "Anyone can join" on public.teams;
drop policy if exists "Read teams in room" on public.teams;
drop policy if exists "Admins can update team scores" on public.teams;
drop policy if exists "Public can update team scores" on public.teams;

create policy "Anyone can join" on public.teams
  for insert
  with check (true);

create policy "Read teams in room" on public.teams
  for select
  using (true);

create policy "Public can update team scores" on public.teams
  for update
  using (true)
  with check (true);

drop policy if exists "Anyone can insert selection" on public.selections;
drop policy if exists "Read selections in room" on public.selections;
drop policy if exists "Admins can restart round selections" on public.selections;
drop policy if exists "Public can restart round selections" on public.selections;

create policy "Anyone can insert selection" on public.selections
  for insert
  with check (true);

create policy "Read selections in room" on public.selections
  for select
  using (true);

create policy "Public can restart round selections" on public.selections
  for delete
  using (true);

alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.teams;
alter publication supabase_realtime add table public.selections;
