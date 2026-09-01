-- PEPPY backend schema.
--
-- Identity model: "claim your connect code". Each install signs in
-- anonymously (Supabase anonymous auth -> a real row in auth.users, persisted
-- on the device), then claims a connect code. The code is unique, so the first
-- device to claim it owns it, and RLS keys off auth.uid() throughout. Adding
-- email or Discord login later just attaches an identity to the SAME auth user,
-- so nobody loses their profile.
--
-- The anon/publishable key is public (it ships in an open-source app), so every
-- table below is RLS-protected and all writes go through SECURITY DEFINER
-- functions that check ownership. Assume the client is hostile.
--
-- Run: Supabase dashboard -> SQL Editor -> paste -> Run.
-- Requires: Authentication -> Sign In / Providers -> Anonymous sign-ins ENABLED.

-- ---------------------------------------------------------------- tables ----

create table if not exists peppy_players (
  id            uuid primary key default gen_random_uuid(),
  auth_id       uuid not null unique references auth.users (id) on delete cascade,
  connect_code  text not null unique,           -- normalised upper case, "BIRD#704"
  display_name  text not null,
  char_pref     text,                           -- e.g. 'FOX'
  stage_pref    smallint not null default 31,   -- external stage id
  discord_id    text,
  discord_dm_ok boolean not null default false, -- opt-in, off by default
  last_seen     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create table if not exists peppy_friends (
  from_player uuid not null references peppy_players (id) on delete cascade,
  to_player   uuid not null references peppy_players (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (from_player, to_player),
  check (from_player <> to_player)
);

create table if not exists peppy_recent (
  player    uuid not null references peppy_players (id) on delete cascade,
  opponent  uuid not null references peppy_players (id) on delete cascade,
  played_at timestamptz not null default now(),
  primary key (player, opponent)
);

-- One communal queue for now ('fort-wayne'), but keyed so more can exist.
create table if not exists peppy_queue (
  queue_id      text not null default 'fort-wayne',
  player        uuid not null references peppy_players (id) on delete cascade,
  state         text not null default 'waiting'
                check (state in ('waiting', 'challenged', 'playing', 'spectating')),
  joined_at     timestamptz not null default now(),
  challenged_at timestamptz,                    -- start of the 5-minute window
  primary key (queue_id, player)
);

create table if not exists peppy_challenges (
  id          uuid primary key default gen_random_uuid(),
  challenger  uuid not null references peppy_players (id) on delete cascade,
  challenged  uuid not null references peppy_players (id) on delete cascade,
  stage_id    smallint not null default 31,
  state       text not null default 'pending'
              check (state in ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  check (challenger <> challenged)
);

create index if not exists peppy_challenges_inbox
  on peppy_challenges (challenged, state, created_at desc);

create table if not exists peppy_matches (
  id         uuid primary key default gen_random_uuid(),
  p1         uuid not null references peppy_players (id),
  p2         uuid not null references peppy_players (id),
  winner     uuid references peppy_players (id),
  games      jsonb not null default '[]',   -- [{stage, winner, stocks}, ...]
  set_format smallint not null default 1,   -- 1 = friendly, 3/5 = best-of
  played_at  timestamptz not null default now()
);

-- ------------------------------------------------------------- constants ----

-- How long a challenged player has to accept before they lose their spot.
create or replace function peppy_accept_window() returns interval
  language sql immutable as $$ select interval '5 minutes' $$;

-- Presence: how recently someone must have checked in to count as online.
create or replace function peppy_online_window() returns interval
  language sql immutable as $$ select interval '90 seconds' $$;

-- --------------------------------------------------------------- helpers ----

-- The calling device's player row, or null if they haven't claimed a code.
create or replace function peppy_me() returns uuid
  language sql stable security definer set search_path = public as $$
  select id from peppy_players where auth_id = auth.uid()
$$;

-- ------------------------------------------------------------------ RLS -----
-- Reads are open to signed-in devices (this is a local scene roster, and the
-- app has to show who is around). Writes go through functions below.

alter table peppy_players    enable row level security;
alter table peppy_friends    enable row level security;
alter table peppy_recent     enable row level security;
alter table peppy_queue      enable row level security;
alter table peppy_challenges enable row level security;
alter table peppy_matches    enable row level security;

drop policy if exists players_read on peppy_players;
create policy players_read on peppy_players
  for select to authenticated using (true);

-- A device may update only its own row, and may never move it to another
-- auth user or change the code it claimed.
drop policy if exists players_update_self on peppy_players;
create policy players_update_self on peppy_players
  for update to authenticated
  using (auth_id = auth.uid())
  with check (auth_id = auth.uid());

drop policy if exists friends_read on peppy_friends;
create policy friends_read on peppy_friends
  for select to authenticated
  using (from_player = peppy_me() or to_player = peppy_me());

drop policy if exists recent_read on peppy_recent;
create policy recent_read on peppy_recent
  for select to authenticated using (player = peppy_me());

drop policy if exists queue_read on peppy_queue;
create policy queue_read on peppy_queue
  for select to authenticated using (true);

drop policy if exists challenges_read on peppy_challenges;
create policy challenges_read on peppy_challenges
  for select to authenticated
  using (challenger = peppy_me() or challenged = peppy_me());

drop policy if exists matches_read on peppy_matches;
create policy matches_read on peppy_matches
  for select to authenticated
  using (p1 = peppy_me() or p2 = peppy_me());

-- No insert/update/delete policies: all writes happen in the functions below,
-- which run as definer and enforce ownership themselves.

-- ------------------------------------------------------------- functions ----

-- Claim a connect code for this device. Idempotent: calling it again renames
-- or re-points your own row. Fails if someone else already owns the code.
create or replace function peppy_claim_code(p_code text, p_name text default null)
returns peppy_players
language plpgsql security definer set search_path = public as $$
declare
  v_code text := upper(trim(p_code));
  v_name text := coalesce(nullif(trim(p_name), ''), split_part(upper(trim(p_code)), '#', 1));
  v_row  peppy_players;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if v_code !~ '^[A-Z]{1,7}#[0-9]{1,3}$' then
    raise exception 'that does not look like a connect code (ABCD#123)';
  end if;

  select * into v_row from peppy_players where connect_code = v_code;
  if found and v_row.auth_id <> auth.uid() then
    raise exception 'that code is already claimed on another device';
  end if;

  insert into peppy_players (auth_id, connect_code, display_name)
  values (auth.uid(), v_code, v_name)
  on conflict (auth_id) do update
    set connect_code = excluded.connect_code,
        display_name = excluded.display_name,
        last_seen    = now()
  returning * into v_row;

  return v_row;
end $$;

-- Presence heartbeat + preference save in one call.
create or replace function peppy_heartbeat(p_char text default null,
                                           p_stage smallint default null)
returns void
language sql security definer set search_path = public as $$
  update peppy_players
     set last_seen  = now(),
         char_pref  = coalesce(p_char, char_pref),
         stage_pref = coalesce(p_stage, stage_pref)
   where auth_id = auth.uid()
$$;

-- Anyone whose 5-minute accept window has lapsed loses their spot: they drop
-- to spectating and the person who challenged them keeps waiting. Called at
-- the start of every queue read, so no cron job is needed on the free tier.
create or replace function peppy_queue_sweep()
returns void
language plpgsql security definer set search_path = public as $$
begin
  update peppy_queue
     set state = 'spectating', challenged_at = null
   where state = 'challenged'
     and challenged_at is not null
     and challenged_at < now() - peppy_accept_window();

  update peppy_challenges
     set state = 'expired', resolved_at = now()
   where state = 'pending'
     and created_at < now() - peppy_accept_window();
end $$;

create or replace function peppy_queue_set(p_state text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := peppy_me();
begin
  if v_me is null then raise exception 'claim a connect code first'; end if;
  if p_state not in ('waiting', 'spectating') then
    raise exception 'state must be waiting or spectating';
  end if;

  insert into peppy_queue (player, state)
  values (v_me, p_state)
  on conflict (queue_id, player) do update
    set state = excluded.state, challenged_at = null,
        joined_at = case when peppy_queue.state = 'spectating'
                          and excluded.state = 'waiting'
                         then now() else peppy_queue.joined_at end;
end $$;

create or replace function peppy_queue_leave()
returns void
language sql security definer set search_path = public as $$
  delete from peppy_queue where player = peppy_me()
$$;

-- The queue as the app shows it: who is waiting, who is spectating, and
-- whether each person is actually at their computer right now.
create or replace function peppy_queue_list()
returns table (player_id uuid, connect_code text, display_name text,
               state text, online boolean, joined_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  perform peppy_queue_sweep();
  return query
    select p.id, p.connect_code, p.display_name, q.state,
           p.last_seen > now() - peppy_online_window(),
           q.joined_at
      from peppy_queue q
      join peppy_players p on p.id = q.player
     where q.queue_id = 'fort-wayne'
     order by q.joined_at;
end $$;

-- Challenge someone by connect code. Accepting counts as their ready, so
-- there is no second confirmation on their side (decided 2026-08-05).
create or replace function peppy_challenge_create(p_code text,
                                                  p_stage smallint default null)
returns peppy_challenges
language plpgsql security definer set search_path = public as $$
declare
  v_me     uuid := peppy_me();
  v_target uuid;
  v_row    peppy_challenges;
begin
  if v_me is null then raise exception 'claim a connect code first'; end if;
  select id into v_target from peppy_players where connect_code = upper(trim(p_code));
  if v_target is null then raise exception 'nobody here has that code yet'; end if;
  if v_target = v_me then raise exception 'you cannot challenge yourself'; end if;

  -- one live challenge per pair
  update peppy_challenges set state = 'cancelled', resolved_at = now()
   where challenger = v_me and challenged = v_target and state = 'pending';

  insert into peppy_challenges (challenger, challenged, stage_id)
  values (v_me, v_target,
          coalesce(p_stage, (select stage_pref from peppy_players where id = v_me)))
  returning * into v_row;

  update peppy_queue set state = 'challenged', challenged_at = now()
   where player = v_target and state = 'waiting';

  return v_row;
end $$;

create or replace function peppy_challenge_respond(p_id uuid, p_accept boolean)
returns peppy_challenges
language plpgsql security definer set search_path = public as $$
declare
  v_me  uuid := peppy_me();
  v_row peppy_challenges;
begin
  select * into v_row from peppy_challenges where id = p_id;
  if not found then raise exception 'no such challenge'; end if;
  if v_row.challenged <> v_me then raise exception 'that challenge is not yours'; end if;
  if v_row.state <> 'pending' then raise exception 'that challenge is already %', v_row.state; end if;
  if v_row.created_at < now() - peppy_accept_window() then
    update peppy_challenges set state = 'expired', resolved_at = now()
     where id = p_id returning * into v_row;
    return v_row;
  end if;

  update peppy_challenges
     set state = case when p_accept then 'accepted' else 'declined' end,
         resolved_at = now()
   where id = p_id
  returning * into v_row;

  update peppy_queue
     set state = case when p_accept then 'playing' else 'waiting' end,
         challenged_at = null
   where player in (v_row.challenger, v_row.challenged);

  return v_row;
end $$;

create or replace function peppy_challenge_cancel(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := peppy_me();
begin
  update peppy_challenges set state = 'cancelled', resolved_at = now()
   where id = p_id and challenger = v_me and state = 'pending';
  update peppy_queue set state = 'waiting', challenged_at = null
   where player = (select challenged from peppy_challenges where id = p_id)
     and state = 'challenged';
end $$;

-- Called after a match so both sides get a Recently Played entry.
create or replace function peppy_record_played(p_code text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid := peppy_me();
  v_other uuid;
begin
  if v_me is null then return; end if;
  select id into v_other from peppy_players where connect_code = upper(trim(p_code));
  if v_other is null or v_other = v_me then return; end if;

  insert into peppy_recent (player, opponent) values (v_me, v_other)
    on conflict (player, opponent) do update set played_at = now();
  insert into peppy_recent (player, opponent) values (v_other, v_me)
    on conflict (player, opponent) do update set played_at = now();

  update peppy_queue set state = 'waiting', challenged_at = null
   where player in (v_me, v_other) and state = 'playing';
end $$;

create or replace function peppy_friend_add(p_code text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me    uuid := peppy_me();
  v_other uuid;
begin
  if v_me is null then raise exception 'claim a connect code first'; end if;
  select id into v_other from peppy_players where connect_code = upper(trim(p_code));
  if v_other is null or v_other = v_me then return; end if;
  insert into peppy_friends (from_player, to_player) values (v_me, v_other)
    on conflict do nothing;
end $$;

create or replace function peppy_friend_list()
returns table (player_id uuid, connect_code text, display_name text,
               online boolean, mutual boolean)
language sql security definer set search_path = public as $$
  select p.id, p.connect_code, p.display_name,
         p.last_seen > now() - peppy_online_window(),
         exists (select 1 from peppy_friends b
                  where b.from_player = p.id and b.to_player = peppy_me())
    from peppy_friends f
    join peppy_players p on p.id = f.to_player
   where f.from_player = peppy_me()
   order by p.display_name
$$;

create or replace function peppy_recent_list()
returns table (player_id uuid, connect_code text, display_name text,
               played_at timestamptz, is_friend boolean)
language sql security definer set search_path = public as $$
  select p.id, p.connect_code, p.display_name, r.played_at,
         exists (select 1 from peppy_friends f
                  where f.from_player = peppy_me() and f.to_player = p.id)
    from peppy_recent r
    join peppy_players p on p.id = r.opponent
   where r.player = peppy_me()
   order by r.played_at desc
   limit 20
$$;

-- Your pending incoming challenge, if any (what makes the app blink).
create or replace function peppy_inbox()
returns table (challenge_id uuid, from_code text, from_name text,
               stage_id smallint, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  perform peppy_queue_sweep();
  return query
    select c.id, p.connect_code, p.display_name, c.stage_id, c.created_at,
           c.created_at + peppy_accept_window()
      from peppy_challenges c
      join peppy_players p on p.id = c.challenger
     where c.challenged = peppy_me() and c.state = 'pending'
     order by c.created_at desc
     limit 1;
end $$;

-- ----------------------------------------------------------------- grants ---
-- "Automatically expose new tables" is off, so access is opt-in and explicit.

grant usage on schema public to anon, authenticated;

grant select on peppy_players, peppy_queue, peppy_friends, peppy_recent,
                peppy_challenges, peppy_matches to authenticated;

grant execute on function
  peppy_me(), peppy_claim_code(text, text), peppy_heartbeat(text, smallint),
  peppy_queue_set(text), peppy_queue_leave(), peppy_queue_list(),
  peppy_queue_sweep(), peppy_challenge_create(text, smallint),
  peppy_challenge_respond(uuid, boolean), peppy_challenge_cancel(uuid),
  peppy_record_played(text), peppy_friend_add(text), peppy_friend_list(),
  peppy_recent_list(), peppy_inbox(), peppy_accept_window(), peppy_online_window()
  to authenticated;
