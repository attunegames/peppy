# PEPPY

One-click Slippi Melee friendlies for your local scene. Named after the hare
(Slippi got the frog).

Peppy is a companion app for [Project Slippi](https://slippi.gg): a friends
list, a communal LFG queue, and one-click direct matches — no in-game menu
navigation, no typing connect codes. The game boots straight into a connected
match; you just pick your character and play.

## How it works (all proven, 2026-08-04 spike)

- Peppy keeps a **private sandbox copy** of your Slippi netplay Dolphin
  (`%APPDATA%\Peppy\netplay`). Your real Slippi install is never modified.
- Match setup is done through **config files + Gecko codes** (game patches the
  same way Slippi itself is built):
  - `$AutoBoot` — boots the game straight into the Direct-mode character screen
    (skips the online mode-select).
  - `$AutoDirect` — once your character is picked, auto-fills the opponent's
    code (from `direct-codes.json`, which Peppy writes) and starts the search —
    with your chosen game-1 stage locked in.
  - `Extract Menu Info` (Slippi's own optional code) — lets Peppy silently read
    game state for match tracking.
- Your controller is the **only** controller: no virtual pads, no input
  injection. Native GC adapter support untouched.
- Gameplay is 100% human, Direct mode only. Bots on public matchmaking are
  against Slippi's rules; Peppy never touches Ranked/Unranked.

## Status

- [x] Core launch pipeline (sandbox, configs, geckos, launch/kill)
- [x] UI shell (setup / direct challenge / queue / friends / recently played)
- [x] **App-side character selection** (`$CharPick` + `$CharPress`) — verified
      across all three CSS rows, ~2.4s, zero human input
- [x] Game-1 stage forced from the app (`$AutoDirect` lock-in)
- [x] Hidden launch + reveal at connect (watches Slippi's own log for
      "Connection success!" — no game-memory reading, stays pure Node)
- [x] Packaged Windows build (`npm run package` → `dist/`)
- [ ] Supabase backend (shared queue, friends, challenge handshake) — schema
      draft in `backend/migrate-peppy.sql`; UI runs offline until then
- [ ] .slp result tracking, best-of-N sets
- [ ] Real 2-client match against another person
- [ ] Discord bot (queue announcements, opt-in DMs)
- [ ] Tournaments (blind picks / counterpicks — unblocked by CharPick)

## Distributing a test build

```
npm install
npm run package
```

Produces `dist/Peppy-win32-x64/`. Zip it together with `READ-ME-FIRST.txt` and
send it; the recipient needs their own Slippi Launcher, login and Melee ISO.
Unsigned, so Windows SmartScreen will warn — the readme explains it.

## Verifying a change

`node smoke-test.mjs` checks the generated match setup end to end (patches
present, stage word patched, opponent code written full-width, no virtual
controller config, real Slippi install untouched).

## Dev

```
npm install
npm start
```

Requires the Slippi Launcher installed with a configured Melee ISO.

`resources/geckos.json` is generated from the assembly in `tools/` - see
`tools/README.md`. `python tools/verify_geckos.py` proves the shipped JSON
matches that source byte-for-byte.

## Credits and licensing

Peppy is licensed **GPL-3.0-or-later** (see `LICENSE`).

Peppy is an unofficial third-party app. It is **not** affiliated with, endorsed
by, or supported by the Slippi project or Nintendo. It ships no game code and
no Nintendo assets: you bring your own Slippi install and your own Melee copy.

Standing on other people's work:

- **[Project Slippi](https://slippi.gg)** - the rollback netplay this is built
  around. Peppy launches your existing Slippi Dolphin; it does not modify or
  redistribute it. Slippi's open-source game patches
  ([slippi-ssbm-asm](https://github.com/project-slippi/slippi-ssbm-asm),
  GPL-3.0) were the reference for how the online character-select screen and
  matchmaking messages work - which is why Peppy is GPL-3.0 too.
- **[libmelee](https://github.com/altf4/libmelee)** (altf4, LGPL-3.0) - used
  during development to read game state while testing. Its "Extract Menu Info"
  gecko code is deliberately **not** bundled with the app; Peppy watches
  Slippi's own log instead, so no third-party game code ships here.
- **[Melee decompilation](https://github.com/doldecomp/melee)** - the source of
  truth for the controller and character-select structures the patches touch.

The patches in `tools/gen_gecko.py` are original work. They only ever
synthesize input on the character-select screen, never during gameplay, and
Peppy never touches ranked or unranked matchmaking - bots on public matchmaking
are against Slippi's rules and Peppy has no business there.

## Privacy

No account, no telemetry, no network calls of its own in this build. Peppy
never asks for, reads, or transmits your slippi.gg credentials; your Slippi
login file is only used where Dolphin already expects to find it, on your own
machine.
