-- PEPPY migration 3: one player, many PCs.
--
-- Identity now follows your Slippi login rather than the machine. Peppy reads
-- the connect code out of the Slippi user.json already on that PC, so every
-- machine where Slippi works is automatically yours - desktop, laptop, a
-- friend's setup you're logged into. Nobody types a code.
--
-- A player therefore has many devices (anonymous auth users), not one. The old
-- peppy_players.auth_id becomes just "the PC that first claimed this code".
--
-- Run AFTER migrate-peppy-2.sql.

create table if not exists peppy_devices (
  auth_id    uuid primary key references auth.users (id) on delete cascade,
  player     uuid not null references peppy_players (id) on delete cascade,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

create index if not exists peppy_devices_player on peppy_devices (player);

-- Existing single-device players keep working.
insert into peppy_devices (auth_id, player)
  select auth_id, id from peppy_players
  on conflict (auth_id) do nothing;

alter table peppy_devices enable row level security;

drop policy if exists devices_read on peppy_devices;
create policy devices_read on peppy_devices
  for select to authenticated using (auth_id = auth.uid());

-- Who am I? Now "which player does this PC belong to".
create or replace function peppy_me() returns uuid
  language sql stable security definer set search_path = public as $$
  select player from peppy_devices where auth_id = auth.uid()
$$;

-- Claim (or join) a connect code from this PC.
--
-- There is no ownership challenge here on purpose: the client only calls this
-- with the code from that machine's own Slippi login, so being able to play as
-- BIRD#704 in Slippi is what makes you BIRD#704 in Peppy. The server cannot
-- verify a play key (there is no public API for it, and Peppy will not handle
-- one), so this trusts the client the same way the scene trusts its members.
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

  if not found then
    insert into peppy_players (auth_id, connect_code, display_name)
    values (auth.uid(), v_code, v_name)
    returning * into v_row;
  else
    update peppy_players
       set display_name = v_name, last_seen = now()
     where id = v_row.id
    returning * into v_row;
  end if;

  -- attach this PC to that player (and move it if it was somebody else's)
  insert into peppy_devices (auth_id, player) values (auth.uid(), v_row.id)
  on conflict (auth_id) do update set player = excluded.player, last_seen = now();

  return v_row;
end $$;

-- Heartbeat now also stamps the device, so we can tell PCs apart later.
create or replace function peppy_heartbeat(p_char text default null,
                                           p_stage smallint default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update peppy_devices set last_seen = now() where auth_id = auth.uid();
  update peppy_players
     set last_seen  = now(),
         char_pref  = coalesce(p_char, char_pref),
         stage_pref = coalesce(p_stage, stage_pref)
   where id = peppy_me();
end $$;

-- The old policy keyed off peppy_players.auth_id, which is now just the first
-- PC. Any of your PCs may edit your row.
drop policy if exists players_update_self on peppy_players;
create policy players_update_self on peppy_players
  for update to authenticated
  using (id = peppy_me())
  with check (id = peppy_me());

grant select on peppy_devices to authenticated;
