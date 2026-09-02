-- PEPPY migration 4: who picks the stage, and faster cleanup of people who left.
--
-- Run this in the Supabase SQL editor after migrate-peppy-3.sql.

-- --------------------------------------------------------- the stage role ---
-- Melee's direct-mode handshake has exactly one stage picker, and Peppy was
-- telling BOTH clients they were it. Game 1 looked fine, but afterwards both
-- machines believed they had lost and both drove the stage select for game 2:
-- it landed on Princess Peach's Castle and froze both of them.
--
-- peppy_pair() inserts (player_a, player_b) as (king, challenger): the king is
-- whoever has held the setup - in practice the first one into the queue - and
-- the challenger is the one who came for them. So the challenger picks the
-- game-1 stage, which is the rule the scene asked for.
--
-- The return type gains a column, and Postgres will not change a function's
-- signature in place, so it has to be dropped first.
drop function if exists peppy_my_pairing();
create or replace function peppy_my_pairing()
returns table (pairing_id uuid, other_code text, other_name text,
               other_sweeps int, i_accepted boolean, they_accepted boolean,
               state text, expires_at timestamptz, i_pick_stage boolean)
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
           pr.created_at + peppy_accept_window(),
           pr.player_b = v_me          -- the challenger picks game 1's stage
      from peppy_pairings pr
      join peppy_players o
        on o.id = case when pr.player_a = v_me then pr.player_b else pr.player_a end
     where (pr.player_a = v_me or pr.player_b = v_me)
       and pr.state in ('pending', 'ready')
     order by pr.created_at desc
     limit 1;
end $$;

grant execute on function peppy_my_pairing() to authenticated;

-- ------------------------------------------------------- leaving the queue ---
-- Closing Peppy left you in the queue for three minutes. The app now says it is
-- leaving on the way out, but that cannot be relied on (crashes, power cuts,
-- laptops closing), so the sweep matches the presence window instead: if you
-- have not checked in within 90 seconds you are not in the queue. Peppy checks
-- in every 4 seconds, so this cannot drop anyone who is actually here.
create or replace function peppy_queue_sweep()
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from peppy_queue q
   using peppy_players p
   where p.id = q.player
     and p.last_seen < now() - peppy_online_window();

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
