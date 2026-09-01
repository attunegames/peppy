-- PEPPY migration 2: the rotation engine.
--
-- House rules (from the Fort Wayne scene):
--   * Winner stays. They hold the setup and take on the next person in line.
--   * If the winner beats EVERYONE else in the pool, that is a SWEEP: they get
--     a sweep counted next to their name and go to the back of the line, so one
--     player cannot camp the setup forever.
--   * With exactly two people, they just play. Peppy does not interrupt with
--     prompts until a third person joins.
--   * With three or more, Peppy pairs people and both get a prompt: 5 minutes
--     to accept, and missing it drops you to spectating so the queue keeps
--     moving.
--
-- Run AFTER migrate-peppy.sql.

alter table peppy_players add column if not exists sweeps integer not null default 0;
alter table peppy_queue   add column if not exists last_played_with uuid;

-- One row per queue: who currently holds the setup and who they have beaten
-- during this reign.
create table if not exists peppy_room (
  queue_id    text primary key default 'fort-wayne',
  king        uuid references peppy_players (id) on delete set null,
  king_beaten uuid[] not null default '{}',
  updated_at  timestamptz not null default now()
);
insert into peppy_room (queue_id) values ('fort-wayne') on conflict do nothing;

-- A pairing Peppy proposed. Unlike a direct challenge, BOTH sides must accept
-- (nobody gets a game launched at them unasked).
create table if not exists peppy_pairings (
  id         uuid primary key default gen_random_uuid(),
  queue_id   text not null default 'fort-wayne',
  player_a   uuid not null references peppy_players (id) on delete cascade,
  player_b   uuid not null references peppy_players (id) on delete cascade,
  a_accepted boolean not null default false,
  b_accepted boolean not null default false,
  state      text not null default 'pending'
             check (state in ('pending', 'ready', 'declined', 'expired', 'done')),
  created_at timestamptz not null default now(),
  check (player_a <> player_b)
);

create index if not exists peppy_pairings_live
  on peppy_pairings (queue_id, state, created_at desc);

alter table peppy_room     enable row level security;
alter table peppy_pairings enable row level security;

drop policy if exists room_read on peppy_room;
create policy room_read on peppy_room for select to authenticated using (true);

drop policy if exists pairings_read on peppy_pairings;
create policy pairings_read on peppy_pairings
  for select to authenticated
  using (player_a = peppy_me() or player_b = peppy_me());

-- ------------------------------------------------------------ the engine ----

-- Who is actually available to be paired right now.
create or replace function peppy_pool()
returns table (player uuid, joined_at timestamptz)
language sql stable security definer set search_path = public as $$
  select q.player, q.joined_at
    from peppy_queue q
    join peppy_players p on p.id = q.player
   where q.queue_id = 'fort-wayne'
     and q.state in ('waiting', 'playing', 'challenged')
     and p.last_seen > now() - peppy_online_window()
   order by q.joined_at
$$;

-- Propose the next pairing if one is needed.
--
-- Deliberately does nothing when two people are mid-session: they keep playing
-- uninterrupted until somebody else joins.
create or replace function peppy_pair()
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_room    peppy_room;
  v_pool    uuid[];
  v_size    int;
  v_king    uuid;
  v_opp     uuid;
  v_live    int;
begin
  perform peppy_queue_sweep();

  -- a pairing is already in flight, or two people are actively playing
  select count(*) into v_live from peppy_pairings
   where queue_id = 'fort-wayne' and state in ('pending', 'ready');
  if v_live > 0 then return; end if;

  select array_agg(player order by joined_at) into v_pool from peppy_pool();
  v_size := coalesce(array_length(v_pool, 1), 0);
  if v_size < 2 then return; end if;

  -- Never interrupt a game in progress. If a third person joins mid-match,
  -- the rotation picks up when that match reports its result.
  if exists (select 1 from peppy_queue
              where player = any(v_pool) and state = 'playing') then
    return;
  end if;

  select * into v_room from peppy_room where queue_id = 'fort-wayne';

  -- Winner stays: the king keeps the setup if they are still around.
  v_king := v_room.king;
  if v_king is null or not (v_king = any(v_pool)) then
    v_king := v_pool[1];                      -- longest waiting
    update peppy_room set king = v_king, king_beaten = '{}', updated_at = now()
     where queue_id = 'fort-wayne';
  end if;

  -- Next in line: longest waiting who is not the king, preferring somebody the
  -- king has not already beaten this reign.
  select p.player into v_opp
    from peppy_pool() p
   where p.player <> v_king
     and not (p.player = any(coalesce(v_room.king_beaten, '{}')))
   order by p.joined_at
   limit 1;

  if v_opp is null then
    select p.player into v_opp from peppy_pool() p
     where p.player <> v_king order by p.joined_at limit 1;
  end if;
  if v_opp is null then return; end if;

  insert into peppy_pairings (player_a, player_b) values (v_king, v_opp);

  update peppy_queue set state = 'challenged', challenged_at = now()
   where player in (v_king, v_opp) and state = 'waiting';
end $$;

-- What Peppy is asking me to do right now, if anything.
create or replace function peppy_my_pairing()
returns table (pairing_id uuid, other_code text, other_name text,
               other_sweeps int, i_accepted boolean, they_accepted boolean,
               state text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v_me uuid := peppy_me();
begin
  perform peppy_pair();
  return query
    select pr.id,
           o.connect_code, o.display_name, o.sweeps,
           case when pr.player_a = v_me then pr.a_accepted else pr.b_accepted end,
           case when pr.player_a = v_me then pr.b_accepted else pr.a_accepted end,
           pr.state,
           pr.created_at + peppy_accept_window()
      from peppy_pairings pr
      join peppy_players o
        on o.id = case when pr.player_a = v_me then pr.player_b else pr.player_a end
     where (pr.player_a = v_me or pr.player_b = v_me)
       and pr.state in ('pending', 'ready')
     order by pr.created_at desc
     limit 1;
end $$;

create or replace function peppy_pairing_respond(p_id uuid, p_accept boolean)
returns peppy_pairings
language plpgsql security definer set search_path = public as $$
declare
  v_me  uuid := peppy_me();
  v_row peppy_pairings;
begin
  select * into v_row from peppy_pairings where id = p_id;
  if not found then raise exception 'no such pairing'; end if;
  if v_me not in (v_row.player_a, v_row.player_b) then
    raise exception 'that pairing is not yours';
  end if;

  if not p_accept then
    update peppy_pairings set state = 'declined' where id = p_id returning * into v_row;
    -- whoever said no steps out of the rotation; the other keeps their place
    update peppy_queue set state = 'spectating', challenged_at = null where player = v_me;
    update peppy_queue set state = 'waiting', challenged_at = null
     where player in (v_row.player_a, v_row.player_b) and player <> v_me;
    perform peppy_pair();
    return v_row;
  end if;

  update peppy_pairings
     set a_accepted = a_accepted or (player_a = v_me),
         b_accepted = b_accepted or (player_b = v_me)
   where id = p_id
  returning * into v_row;

  if v_row.a_accepted and v_row.b_accepted then
    update peppy_pairings set state = 'ready' where id = p_id returning * into v_row;
    update peppy_queue set state = 'playing', challenged_at = null
     where player in (v_row.player_a, v_row.player_b);
  end if;

  return v_row;
end $$;

-- Report a finished match. Peppy reads the winner from the replay file, so
-- this is called by whichever client parses it first; a second, agreeing
-- report is ignored.
create or replace function peppy_report_result(p_opponent_code text, p_i_won boolean)
returns table (swept boolean, sweeps integer)
language plpgsql security definer set search_path = public as $$
declare
  v_me     uuid := peppy_me();
  v_other  uuid;
  v_winner uuid;
  v_loser  uuid;
  v_room   peppy_room;
  v_others uuid[];
  v_swept  boolean := false;
  v_count  integer := 0;
begin
  if v_me is null then raise exception 'claim a connect code first'; end if;
  select id into v_other from peppy_players where connect_code = upper(trim(p_opponent_code));
  if v_other is null then raise exception 'unknown opponent'; end if;

  -- ignore a duplicate report of the same match from the other client
  if exists (select 1 from peppy_matches
              where played_at > now() - interval '2 minutes'
                and ((p1 = v_me and p2 = v_other) or (p1 = v_other and p2 = v_me))) then
    select p.sweeps into v_count from peppy_players p where p.id = v_me;
    return query select false, v_count;
    return;
  end if;

  v_winner := case when p_i_won then v_me else v_other end;
  v_loser  := case when p_i_won then v_other else v_me end;

  insert into peppy_matches (p1, p2, winner) values (v_me, v_other, v_winner);
  perform peppy_record_played(p_opponent_code);

  select * into v_room from peppy_room where queue_id = 'fort-wayne';

  if v_room.king is distinct from v_winner then
    -- new king: reign starts fresh with this win on the board
    update peppy_room set king = v_winner, king_beaten = array[v_loser], updated_at = now()
     where queue_id = 'fort-wayne';
  else
    update peppy_room
       set king_beaten = (select array(select distinct unnest(king_beaten || v_loser))),
           updated_at = now()
     where queue_id = 'fort-wayne'
    returning * into v_room;

    -- swept the room? (needs at least two other people, so beating one player
    -- twice in a row is not a sweep)
    select array_agg(player) into v_others from peppy_pool() where player <> v_winner;
    if coalesce(array_length(v_others, 1), 0) >= 2
       and v_others <@ v_room.king_beaten then
      -- qualify: the function's OUT column is also called "sweeps"
      update peppy_players set sweeps = peppy_players.sweeps + 1
       where id = v_winner
      returning peppy_players.sweeps into v_count;
      v_swept := true;
      -- back of the line, reign over
      update peppy_room set king = null, king_beaten = '{}', updated_at = now()
       where queue_id = 'fort-wayne';
      update peppy_queue set joined_at = now() where player = v_winner;
    end if;
  end if;

  update peppy_pairings set state = 'done'
   where state = 'ready'
     and ((player_a = v_me and player_b = v_other) or (player_a = v_other and player_b = v_me));

  -- With three or more waiting, a finished game hands the setup back to the
  -- rotation. With just the two of them, leave them 'playing' so they can run
  -- rematches in Melee without Peppy prompting between every game.
  if (select count(*) from peppy_pool()) >= 3 then
    update peppy_queue set state = 'waiting', challenged_at = null
     where player in (v_me, v_other) and state = 'playing';
  end if;

  perform peppy_pair();

  if v_count = 0 then
    select p.sweeps into v_count from peppy_players p where p.id = v_winner;
  end if;
  return query select v_swept, v_count;
end $$;

-- Queue list, now with sweeps and who holds the setup.
-- Postgres will not let a function change its return type in place, and this
-- one gains two columns, so it has to be dropped first.
drop function if exists peppy_queue_list();
create or replace function peppy_queue_list()
returns table (player_id uuid, connect_code text, display_name text,
               state text, online boolean, joined_at timestamptz,
               sweeps integer, is_king boolean)
language plpgsql security definer set search_path = public as $$
begin
  perform peppy_pair();
  return query
    select p.id, p.connect_code, p.display_name, q.state,
           p.last_seen > now() - peppy_online_window(),
           q.joined_at, p.sweeps,
           p.id = (select king from peppy_room where queue_id = 'fort-wayne')
      from peppy_queue q
      join peppy_players p on p.id = q.player
     where q.queue_id = 'fort-wayne'
     order by q.joined_at;
end $$;

-- Joining or leaving should immediately reconsider the rotation.
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

  if p_state = 'spectating' then
    update peppy_room set king = null, king_beaten = '{}'
     where queue_id = 'fort-wayne' and king = v_me;
    update peppy_pairings set state = 'declined'
     where state = 'pending' and (player_a = v_me or player_b = v_me);
  end if;

  perform peppy_pair();
end $$;

create or replace function peppy_queue_leave()
returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := peppy_me();
begin
  delete from peppy_queue where player = v_me;
  update peppy_room set king = null, king_beaten = '{}'
   where queue_id = 'fort-wayne' and king = v_me;
  update peppy_pairings set state = 'declined'
   where state = 'pending' and (player_a = v_me or player_b = v_me);
  perform peppy_pair();
end $$;

grant select on peppy_room, peppy_pairings to authenticated;
grant execute on function
  peppy_pool(), peppy_pair(), peppy_my_pairing(),
  peppy_pairing_respond(uuid, boolean), peppy_report_result(text, boolean)
  to authenticated;

-- ------------------------------------------------- fixes found by testing ---

-- peppy_record_played used to shove both players back to 'waiting'. That is
-- the rotation's business, not the recently-played list's, and it was
-- overriding the two-player "keep playing" rule from inside
-- peppy_report_result. It now only records the pairing.
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
end $$;

-- A pairing nobody answers must not block the whole queue forever.
create or replace function peppy_queue_sweep()
returns void
language plpgsql security definer set search_path = public as $$
begin
  update peppy_pairings
     set state = 'expired'
   where state = 'pending'
     and created_at < now() - peppy_accept_window();

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

-- A pairing that is never finished (both players quit, or one drops offline
-- mid-session) used to sit in 'pending'/'ready' forever, and peppy_pair()
-- refuses to propose anything while one is live - which silently wedged the
-- WHOLE queue for everybody. Clear them out as part of the sweep.
create or replace function peppy_queue_sweep()
returns void
language plpgsql security definer set search_path = public as $$
begin
  update peppy_pairings
     set state = 'expired'
   where state = 'pending'
     and created_at < now() - peppy_accept_window();

  update peppy_pairings pr
     set state = 'expired'
   where pr.state in ('pending', 'ready')
     and (pr.created_at < now() - interval '2 hours'
          or not exists (select 1 from peppy_pool() p where p.player = pr.player_a)
          or not exists (select 1 from peppy_pool() p where p.player = pr.player_b));

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

-- Anyone who has gone quiet (closed the app, machine asleep) should not hold a
-- spot in the rotation.
create or replace function peppy_pair()
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_room peppy_room;
  v_pool uuid[];
  v_size int;
  v_king uuid;
  v_opp  uuid;
  v_live int;
begin
  perform peppy_queue_sweep();

  select count(*) into v_live from peppy_pairings
   where queue_id = 'fort-wayne' and state in ('pending', 'ready');
  if v_live > 0 then return; end if;

  select array_agg(player order by joined_at) into v_pool from peppy_pool();
  v_size := coalesce(array_length(v_pool, 1), 0);
  if v_size < 2 then return; end if;

  -- never interrupt a game in progress
  if exists (select 1 from peppy_queue
              where player = any(v_pool) and state = 'playing') then
    return;
  end if;

  select * into v_room from peppy_room where queue_id = 'fort-wayne';

  v_king := v_room.king;
  if v_king is null or not (v_king = any(v_pool)) then
    v_king := v_pool[1];
    update peppy_room set king = v_king, king_beaten = '{}', updated_at = now()
     where queue_id = 'fort-wayne';
    select * into v_room from peppy_room where queue_id = 'fort-wayne';
  end if;

  select p.player into v_opp
    from peppy_pool() p
   where p.player <> v_king
     and not (p.player = any(coalesce(v_room.king_beaten, '{}')))
   order by p.joined_at
   limit 1;

  if v_opp is null then
    select p.player into v_opp from peppy_pool() p
     where p.player <> v_king order by p.joined_at limit 1;
  end if;
  if v_opp is null then return; end if;

  insert into peppy_pairings (player_a, player_b) values (v_king, v_opp);

  update peppy_queue set state = 'challenged', challenged_at = now()
   where player in (v_king, v_opp) and state = 'waiting';
end $$;

-- Duplicate results: both clients report the same match, so one has to be
-- ignored. The first attempt ignored ANY repeat from the same pair inside two
-- minutes, which also threw away real rematches - and this scene rematches
-- constantly. Clients now pass a match key (the replay file identifies the
-- game), so duplicates are exact rather than guessed.
alter table peppy_matches add column if not exists match_key text;
create unique index if not exists peppy_matches_key
  on peppy_matches (match_key) where match_key is not null;

create or replace function peppy_report_result(p_opponent_code text,
                                               p_i_won boolean,
                                               p_match_key text default null)
returns table (swept boolean, sweeps integer)
language plpgsql security definer set search_path = public as $$
declare
  v_me     uuid := peppy_me();
  v_other  uuid;
  v_winner uuid;
  v_loser  uuid;
  v_room   peppy_room;
  v_others uuid[];
  v_swept  boolean := false;
  v_count  integer := 0;
  v_dupe   boolean;
begin
  if v_me is null then raise exception 'claim a connect code first'; end if;
  select id into v_other from peppy_players where connect_code = upper(trim(p_opponent_code));
  if v_other is null then raise exception 'unknown opponent'; end if;

  if p_match_key is not null then
    v_dupe := exists (select 1 from peppy_matches where match_key = p_match_key);
  else
    -- no key: only treat a report seconds old as the other client echoing it
    v_dupe := exists (select 1 from peppy_matches
                       where played_at > now() - interval '10 seconds'
                         and ((p1 = v_me and p2 = v_other)
                           or (p1 = v_other and p2 = v_me)));
  end if;

  if v_dupe then
    select p.sweeps into v_count from peppy_players p where p.id = v_me;
    return query select false, v_count;
    return;
  end if;

  v_winner := case when p_i_won then v_me else v_other end;
  v_loser  := case when p_i_won then v_other else v_me end;

  insert into peppy_matches (p1, p2, winner, match_key)
  values (v_me, v_other, v_winner, p_match_key);
  perform peppy_record_played(p_opponent_code);

  select * into v_room from peppy_room where queue_id = 'fort-wayne';

  if v_room.king is distinct from v_winner then
    update peppy_room set king = v_winner, king_beaten = array[v_loser], updated_at = now()
     where queue_id = 'fort-wayne';
  else
    update peppy_room
       set king_beaten = (select array(select distinct unnest(king_beaten || v_loser))),
           updated_at = now()
     where queue_id = 'fort-wayne'
    returning * into v_room;

    select array_agg(player) into v_others from peppy_pool() where player <> v_winner;
    if coalesce(array_length(v_others, 1), 0) >= 2
       and v_others <@ v_room.king_beaten then
      -- qualify: the function's OUT column is also called "sweeps"
      update peppy_players set sweeps = peppy_players.sweeps + 1
       where id = v_winner
      returning peppy_players.sweeps into v_count;
      v_swept := true;
      update peppy_room set king = null, king_beaten = '{}', updated_at = now()
       where queue_id = 'fort-wayne';
      update peppy_queue set joined_at = now() where player = v_winner;
    end if;
  end if;

  update peppy_pairings set state = 'done'
   where state = 'ready'
     and ((player_a = v_me and player_b = v_other) or (player_a = v_other and player_b = v_me));

  if (select count(*) from peppy_pool()) >= 3 then
    update peppy_queue set state = 'waiting', challenged_at = null
     where player in (v_me, v_other) and state = 'playing';
  end if;

  perform peppy_pair();

  if v_count = 0 then
    select p.sweeps into v_count from peppy_players p where p.id = v_winner;
  end if;
  return query select v_swept, v_count;
end $$;

grant execute on function peppy_report_result(text, boolean, text) to authenticated;

-- Ghosts: closing the app (or a crash, or a sleeping laptop) used to leave you
-- in the queue forever, so the Fort Wayne list slowly filled with people who
-- were not there. Anyone who has not checked in for a few minutes is dropped
-- from the queue; they simply rejoin when they come back.
create or replace function peppy_queue_sweep()
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from peppy_queue q
   using peppy_players p
   where p.id = q.player
     and p.last_seen < now() - interval '3 minutes';

  update peppy_pairings
     set state = 'expired'
   where state = 'pending'
     and created_at < now() - peppy_accept_window();

  update peppy_pairings pr
     set state = 'expired'
   where pr.state in ('pending', 'ready')
     and (pr.created_at < now() - interval '2 hours'
          or not exists (select 1 from peppy_pool() p where p.player = pr.player_a)
          or not exists (select 1 from peppy_pool() p where p.player = pr.player_b));

  update peppy_queue
     set state = 'spectating', challenged_at = null
   where state = 'challenged'
     and challenged_at is not null
     and challenged_at < now() - peppy_accept_window();

  update peppy_challenges
     set state = 'expired', resolved_at = now()
   where state = 'pending'
     and created_at < now() - peppy_accept_window();

  -- a king who has gone home does not keep the setup
  update peppy_room
     set king = null, king_beaten = '{}'
   where king is not null
     and not exists (select 1 from peppy_pool() p where p.player = peppy_room.king);
end $$;
