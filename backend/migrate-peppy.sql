-- PEPPY backend schema (Supabase) — draft, not yet applied.
-- Model: Cinch's friends/challenge pipeline, simplified for v1.

-- Players: claimed connect codes.
create table if not exists peppy_players (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid references auth.users (id),
  name text not null,
  connect_code text not null unique,          -- "BIRD#704"
  discord_id text,                            -- optional, opt-in
  discord_dm_ok boolean not null default false,
  char_pref smallint,                         -- external char id (app-side pref)
  stage_pref smallint not null default 31,    -- external stage id, game 1
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Friends (directed request; mutual row pair = friends).
create table if not exists peppy_friends (
  from_player uuid not null references peppy_players (id) on delete cascade,
  to_player uuid not null references peppy_players (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_player, to_player)
);

-- Recently played (auto-populated after each arranged match).
create table if not exists peppy_recent (
  player uuid not null references peppy_players (id) on delete cascade,
  opponent uuid not null references peppy_players (id) on delete cascade,
  played_at timestamptz not null default now(),
  primary key (player, opponent)
);

-- THE communal queue (v1: exactly one, "fort-wayne").
create table if not exists peppy_queue (
  queue_id text not null default 'fort-wayne',
  player uuid not null references peppy_players (id) on delete cascade,
  state text not null default 'waiting',      -- waiting | challenged | playing | spectating
  joined_at timestamptz not null default now(),
  challenged_at timestamptz,                  -- start of the 5-minute accept window
  primary key (queue_id, player)
);

-- Challenges: the accept handshake that triggers both launches.
create table if not exists peppy_challenges (
  id uuid primary key default gen_random_uuid(),
  challenger uuid not null references peppy_players (id) on delete cascade,
  challenged uuid not null references peppy_players (id) on delete cascade,
  stage_id smallint not null default 31,
  state text not null default 'pending',      -- pending | accepted | declined | expired
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Match history (fed by .slp results read by the app).
create table if not exists peppy_matches (
  id uuid primary key default gen_random_uuid(),
  p1 uuid not null references peppy_players (id),
  p2 uuid not null references peppy_players (id),
  winner uuid references peppy_players (id),
  games jsonb not null default '[]',          -- [{stage, winner, stocks}, ...]
  set_format smallint not null default 1,     -- 1 = free play, 3/5 = best-of
  played_at timestamptz not null default now()
);

-- TODO: RLS policies (origin-lock model from Cinch), rpc: queue_join/leave,
-- challenge_create/accept (returns both connect codes atomically),
-- queue_timeout_sweep (5-min window -> spectate).
