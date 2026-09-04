"""Build Peppy's Gecko codes for Super Smash Bros. Melee (NTSC 1.02 / GALE01r2).

These are the game-side patches that let Peppy set a match up without the
player touching a menu. They are original work; the addresses and structure
offsets were established from Slippi's open-source game patches
(github.com/project-slippi/slippi-ssbm-asm, GPL-3.0) and the Melee
decompilation (github.com/doldecomp/melee).

    $AutoBoot   hook 0x80229624  skip the online mode-select, land on Direct CSS
    $AutoDirect hook 0x80260314  auto code-entry + search, game-1 stage locked in
    $CharPick   hook 0x802602A0  park the CSS cursor on the chosen character
    $CharPress  hook 0x801A3A74  pulse A once per frame so the game selects it

Two hard-won details, both of which cost hours:

1. The CSS reads HSD_PadCopyStatus (0x804C20BC), not HSD_PadMasterStatus. The
   press must therefore be written where the copy stage cannot overwrite it.
2. mnCharSel_CursorThink runs once per CURSOR object, not once per frame, so a
   pulse counted there lands on one cursor's turn only. $CharPress lives in
   gm_EvaluateAllControllerInputs, which runs exactly once per frame, after the
   pad copy and before any cursor logic.

Never synthesize input in-game: Slippi transmits the raw pad upstream of these
buffers, so a fake press would desync. The character select screen is safe
because nothing there is transmitted except the lock-in message.

Usage:  python tools/export_geckos.py     (writes resources/geckos.json)
Requires: pip install keystone-engine
"""
import struct

import keystone

# --- vanilla Melee functions we call -----------------------------------------
EXI = 0x800055F0          # FN_EXITransferBuffer
MEMCPY = 0x800031F4
ALLOC = 0x8037F1E4        # HSD_MemAlloc
FREE = 0x8037F1B0         # HSD_Free
ZERO = 0x8000C160         # Zero_AreaLength
STORE_PORT = 0x801677E8   # CSS_StoreSinglePlayerPortNumber
SFX = 0x80024030          # SFX_Menu_CommonSound
STORE_SCENE = 0x80229860  # Event_StoreSceneNumber

# --- hooks (all verified free of Slippi's own injections) --------------------
HOOK_ADDR = 0x80260314          # inside CSS per-frame func
ORIG_INSTR = 0xB01F0008         # sth r0, 8(r31)
BOOT_HOOK_ADDR = 0x80229624     # MainMenu_GetAllControllerInstantButtons
BOOT_ORIG_INSTR = 0x7C0802A6    # mflr r0
CHARPICK_HOOK_ADDR = 0x802602A0  # mnCharSel_CursorThink entry
CHARPICK_ORIG_INSTR = 0x7C0802A6
CHARPRESS_HOOK_ADDR = 0x801A3A74  # gm_EvaluateAllControllerInputs entry
CHARPRESS_ORIG_INSTR = 0x7C0802A6

# CSS icon centres expressed as cursor positions, plus the CKIND the game
# stores once the character is chosen.
CHAR_TABLE = {
    "DOC": (0x16, -29.9, 18.5), "MARIO": (0x08, -23.6, 18.5),
    "LUIGI": (0x07, -16.6, 18.5), "BOWSER": (0x05, -9.6, 18.5),
    "PEACH": (0x0C, -2.6, 18.5), "YOSHI": (0x11, 4.4, 18.5),
    "DK": (0x01, 11.4, 18.5), "CPTFALCON": (0x00, 18.3, 18.5),
    "GANONDORF": (0x19, 24.6, 18.5),
    "FALCO": (0x14, -29.9, 11.5), "FOX": (0x02, -23.6, 11.5),
    "NESS": (0x0B, -16.6, 11.5), "POPO": (0x0E, -9.6, 11.5),
    "KIRBY": (0x04, -2.6, 11.5), "SAMUS": (0x10, 4.4, 11.5),
    "ZELDA": (0x12, 11.4, 11.5), "LINK": (0x06, 18.3, 11.5),
    "YLINK": (0x15, 24.6, 11.5),
    "PICHU": (0x18, -23.1, 4.5), "PIKACHU": (0x0D, -16.6, 4.5),
    "JIGGLYPUFF": (0x0F, -9.6, 4.5), "MEWTWO": (0x0A, -2.6, 4.5),
    "GAMEANDWATCH": (0x03, 4.4, 4.5), "MARTH": (0x09, 11.4, 4.5),
    "ROY": (0x17, 17.9, 4.5),
}


def call(addr):
    return f"""
    lis 12, 0x{(addr >> 16) & 0xFFFF:X}
    ori 12, 12, 0x{addr & 0xFFFF:X}
    mtctr 12
    bctrl
"""


def _f32_bits(value):
    return struct.unpack(">I", struct.pack(">f", value))[0]


def _load_word(reg, word):
    hi, lo = (word >> 16) & 0xFFFF, word & 0xFFFF
    return f"lis {reg}, 0x{hi:X}\nori {reg}, {reg}, 0x{lo:X}\n"


def roles_block(stage_picker):
    """ISWINNER / CHOSESTAGE.

    Must be WON(1) or LOST(0): the connected-CSS path stalls forever (`b 0x0`)
    on any other value, which is why setting ISWINNER_NULL(-1) hung both
    clients during the two-client tests. The stage picker takes the LOST role
    so its chosen stage is the one sent.
    """
    return f"""
li 3, {0 if stage_picker else 1}
stb 3, -0x5037(13)
li 3, {1 if stage_picker else 0}
stb 3, -0x5036(13)
"""


def lockin_block(stage_id, random_stage=False, frozen_ps=0):
    """FN_TX_LOCK_IN equivalent: EXI 0xB5 with a 10-byte selections payload.

    The stage fields are a value plus an option byte: option 1 means "use this
    stage id", option 3 means "random" (and the id is ignored). That is the
    same pair the game itself sends, so random here is the game's own random
    legal stage, not a list Peppy invents.

    The last byte is frozen Pokemon Stadium. It was hardcoded to 1, which is
    what ranked plays on - the scene noticed, because their replays all came
    back isFrozenPS. Friendlies get the stage as the game normally plays it.
    """
    stage_value = 0 if random_stage else stage_id
    stage_opt = 3 if random_stage else 1
    frozen_ps = 1 if frozen_ps else 0
    return f"""
li 3, 10
{call(ALLOC)}
mr 31, 3
li 3, 0xB5
stb 3, 0(31)
li 3, 0
stb 3, 1(31)
lwz 4, -0x49F0(13)
lbz 3, -0x5108(13)
mulli 3, 3, 0x24
add 4, 4, 3
lbz 3, 0x70(4)
stb 3, 2(31)
lbz 3, 0x73(4)
stb 3, 3(31)
li 3, 1
stb 3, 4(31)
li 3, {stage_value}
sth 3, 5(31)
li 3, {stage_opt}
stb 3, 7(31)
lbz 3, -0x5060(13)
stb 3, 8(31)
li 3, {frozen_ps}
stb 3, 9(31)
mr 3, 31
li 4, 10
li 5, 1
{call(EXI)}
mr 3, 31
{call(FREE)}
"""


# Ask Dolphin for the top entry of direct-codes.json (EXI 0xBE) and drop it in
# the game's name-entry buffer, exactly as the code-entry screen would.
FETCH_CODE = f"""
li 3, 32
{call(ALLOC)}
mr 31, 3
mr 3, 31
li 4, 32
{call(ZERO)}
li 3, 0xBE
stb 3, 0(31)
li 3, 3
stb 3, 0x1E(31)
lbz 3, -0x5060(13)
stb 3, 0x1F(31)
mr 3, 31
li 4, 32
li 5, 1
{call(EXI)}
mr 3, 31
li 4, 30
li 5, 0
{call(EXI)}
lbz 3, 0(31)
cmpwi 3, 0
beq NO_CODE
lbz 3, 0x19(31)
cmpwi 3, 0
beq NO_CODE
lis 3, 0x804A
ori 3, 3, 0x0740
addi 4, 31, 1
li 5, 24
{call(MEMCPY)}
mr 3, 31
{call(FREE)}
"""

# FN_TX_FIND_MATCH equivalent: EXI 0xB4, with the code converted from the
# game's 3-bytes-per-char buffer to the 2-bytes-per-char wire format.
FIND_MATCH = f"""
lis 3, 0x803D
ori 3, 3, 0xAD40
lwz 3, 0(3)
cmpwi 3, 0
beq SKIP_GPDO
lwz 12, 0x88(3)
cmpwi 12, 0
beq SKIP_GPDO
li 3, 0
sth 3, 1(12)
stb 3, 6(12)
SKIP_GPDO:
li 3, 20
{call(ALLOC)}
mr 31, 3
li 3, 0xB4
stb 3, 0(31)
lbz 3, -0x5060(13)
stb 3, 1(31)
lis 6, 0x804A
ori 6, 6, 0x0740
li 4, 0
li 5, 0
COPY_LOOP:
lhzx 3, 6, 4
addi 7, 31, 2
sthx 3, 7, 5
addi 4, 4, 3
addi 5, 5, 2
cmpwi 5, 18
blt COPY_LOOP
mr 3, 31
li 4, 20
li 5, 1
{call(EXI)}
mr 3, 31
{call(FREE)}
"""


def build_autodirect_asm(stage_id, stage_picker, random_stage=False):
    """Two phases, tracked in a flag word stored in the code's own body.

    phase 1 (matchmaking idle): fetch the code, take a role, lock in, search.
    phase 2 (connected): re-assert the lock-in on a few ticks. Melee wants a
    second START press once the opponent appears; without this both clients sit
    connected forever.

    After the last of those the code retires itself and clears CHOSESTAGE. That
    byte is how the game knows whether a stage was already picked, and leaving
    Peppy's game-1 answer standing meant game 2 never reached the stage select -
    the scene got a random stage instead of the loser picking.
    """
    return f"""
stwu 1, -0x90(1)
mflr 0
stw 0, 0x8C(1)
mfcr 0
stw 0, 0x40(1)
stmw 25, 0x20(1)

lis 3, 0x8048
lwz 3, -0x62D0(3)
rlwinm 3, 3, 8, 16, 31
cmpwi 3, 8
bne EXIT

bl AFTER_DATA
DATA:
nop
nop
AFTER_DATA:
mflr 30
lwz 29, 0(30)
cmpwi 29, 2
beq EXIT

lis 3, 0x8000
ori 3, 3, 0x5614
lwz 3, 0(3)
cmpwi 3, 0
beq EXIT
lwz 28, 0(3)
cmpwi 28, 0
beq EXIT

cmpwi 29, 1
beq PHASE2

lis 3, 0x8048
lwz 3, -0x62A0(3)
cmpwi 3, 30
blt EXIT

lbz 3, -0x5060(13)
cmpwi 3, 2
bne EXIT

lbz 3, -0x49A9(13)
cmpwi 3, 0
beq EXIT

lbz 3, 0(28)
cmpwi 3, 0
bne EXIT
{FETCH_CODE}
{roles_block(stage_picker)}
{lockin_block(stage_id, random_stage)}
{FIND_MATCH}
li 3, 1
stw 3, 0(30)
li 3, 0
stw 3, 4(30)
b EXIT

NO_CODE:
mr 3, 31
{call(FREE)}
li 3, 2
stw 3, 0(30)
b EXIT

PHASE2:
lbz 3, 0(28)
cmpwi 3, 4
bne EXIT
lwz 27, 4(30)
addi 27, 27, 1
stw 27, 4(30)
cmpwi 27, 30
beq DO_RELOCK
cmpwi 27, 120
beq DO_RELOCK
cmpwi 27, 240
beq DO_RELOCK
cmpwi 27, 420
beq DO_RELOCK
b EXIT
DO_RELOCK:
{roles_block(stage_picker)}
{lockin_block(stage_id, random_stage)}
cmpwi 27, 420
bne EXIT
li 3, 2
stw 3, 0(30)
li 3, 0
stb 3, -0x5036(13)

EXIT:
lmw 25, 0x20(1)
lwz 0, 0x40(1)
mtcrf 0xFF, 0
lwz 0, 0x8C(1)
mtlr 0
addi 1, 1, 0x90
"""


BOOT_GUARDS = {
    "appstate": """
lbz 3, -0x505F(13)
cmpwi 3, 1
bne EXIT
""",
    "menu": """
lis 3, 0x804A
lbz 3, 0x04F0(3)
cmpwi 3, 8
bne EXIT
""",
    "major": """
lis 3, 0x8048
lbz 3, -0x62D0(3)
cmpwi 3, 1
bne EXIT
""",
    "frame": """
lis 3, 0x8048
lwz 3, -0x62A0(3)
cmpwi 3, 120
blt EXIT
""",
}


def build_autoboot_asm(guards):
    """Replicate the A-press on the 'Direct' row of the online submenu.

    The one-shot flag lives in a nop in the code body, so 'already fired' is
    flag == 1, not flag != 0 (a nop encodes as 0x60000000). Getting that wrong
    made this code appear never to run.
    """
    return f"""
stwu 1, -0x90(1)
mflr 0
stw 0, 0x8C(1)
mfcr 0
stw 0, 0x40(1)
stmw 25, 0x20(1)
stw 3, 0x50(1)

bl AFTER_DATA
DATA:
nop
AFTER_DATA:
mflr 30
lwz 3, 0(30)
cmpwi 3, 1
beq EXIT
{guards}
li 3, 1
stw 3, 0(30)

li 3, 5
sth 3, -0x4AD8(13)
lis 4, 0x804A
li 3, 2
sth 3, 0x04F2(4)
li 3, 0
{call(STORE_PORT)}
li 3, 2
stb 3, -0x5060(13)
li 3, 1
{call(SFX)}
li 3, 8
{call(STORE_SCENE)}

EXIT:
lwz 3, 0x50(1)
lmw 25, 0x20(1)
lwz 0, 0x40(1)
mtcrf 0xFF, 0
lwz 0, 0x8C(1)
mtlr 0
addi 1, 1, 0x90
"""


COLOR_TOKEN_VALUE = 0x5B   # placeholder byte the app rewrites per match


def standdown_block(tag):
    """Run the CURSOR automation for one character-select session only.

    Peppy is there to connect two players, not to run their set: once game 1
    starts, the cursor belongs to the player again, so they can counterpick
    like any other friendlies session. The costume is NOT part of this - see
    build_charpick_asm - because Slippi blocks the costume buttons online, so
    the only way a chosen colour survives into game 2 is for Peppy to keep
    writing it.

    The hook only fires on the character select, so "a game happened" is simply
    a gap in the frames we see: consecutive CSS frames differ by 0 or 1, while
    coming back after a game either jumps far ahead or restarts the counter.
    The two data words start life as `nop` (0x60000000), which is why the unset
    test is against that value and the done test is `== 1`.

    Uses r26-r28 and r31 only: r25/r29/r30 are live by the time CharPick calls
    this (port, cursor object, selection).
    """
    return f"""
bl {tag}_AFTER_DATA
nop
nop
{tag}_AFTER_DATA:
mflr 28
lwz 27, 4(28)
cmpwi 27, 1
beq {tag}_EXIT
lis 26, 0x8048
lwz 26, -0x62A0(26)
lwz 27, 0(28)
lis 31, 0x6000
cmpw 27, 31
beq {tag}_MARK
cmpw 26, 27
blt {tag}_STANDDOWN
subf 31, 27, 26
cmpwi 31, 120
bgt {tag}_STANDDOWN
{tag}_MARK:
stw 26, 0(28)
b {tag}_GO
{tag}_STANDDOWN:
li 31, 1
stw 31, 4(28)
b {tag}_EXIT
{tag}_GO:
"""


def build_charpick_asm(char_name, with_color=True):
    """Park the CSS cursor on the target icon, every frame, until it is chosen.

    Writing the selection struct directly does NOT work: the screen stays on
    "Select your character" because the CSS state machine never ran. Moving the
    real cursor and letting the game's own hit-test see it does.

    Costume is different. Slippi disables the in-game costume buttons on the
    online CSS (PreventColorChange), so pressing X/Y the way we press A does
    nothing - the only way to set a costume is to write the byte the lock-in
    reads. That write therefore keeps running for the WHOLE session, which is
    what makes the colour stick into game 2 and beyond. It is deliberately
    limited to the character Peppy picked: the costume index was validated
    against that character's costume list, and stamping it onto whatever else
    the player switches to could name a costume that character does not have.
    The value is a sentinel so the app can set it per match without
    regenerating 25 x 6 payloads.

    The CURSOR is what stands down after game 1 - see standdown_block.
    """
    ckind, tx, ty = CHAR_TABLE[char_name.upper()]
    color_block = (
        f"li 31, {COLOR_TOKEN_VALUE}\nstb 31, 0x73(30)\n" if with_color else ""
    )
    return f"""
stwu 1, -0x60(1)
mflr 0
stw 0, 0x5C(1)
mfcr 0
stw 0, 0x20(1)
stmw 25, 0x24(1)

lis 31, 0x8048
lwz 31, -0x62D0(31)
rlwinm 31, 31, 8, 16, 31
cmpwi 31, 8
bne CP_EXIT

lbz 31, -0x49AA(13)
cmpwi 31, 0
bne CP_EXIT

lis 31, 0x8000
ori 31, 31, 0x5614
lwz 31, 0(31)
cmpwi 31, 0
beq CP_EXIT
lwz 31, 0(31)
cmpwi 31, 0
beq CP_EXIT
lbz 26, 1(31)
cmpwi 26, 0
bne CP_EXIT

lbz 27, -0x49B0(13)
cmpwi 27, 4
bge CP_EXIT
lis 29, 0x804A
ori 29, 29, 0x0BC0
rlwinm 26, 27, 2, 0, 29
lwzx 29, 29, 26
cmpwi 29, 0
beq CP_EXIT

lbz 25, 4(29)
cmpwi 25, 4
bge CP_EXIT

lwz 26, -0x49F0(13)
cmpwi 26, 0
beq CP_EXIT
mulli 31, 25, 0x24
add 26, 26, 31
mr 30, 26
lbz 26, 0x70(26)
cmpwi 26, {ckind}
bne CP_PICK
{color_block}b CP_EXIT
CP_PICK:
{standdown_block("CP")}

{_load_word(31, _f32_bits(tx))}stw 31, 0xC(29)
{_load_word(31, _f32_bits(ty))}stw 31, 0x10(29)

CP_EXIT:
lmw 25, 0x24(1)
lwz 0, 0x20(1)
mtcrf 0xFF, 0
lwz 0, 0x5C(1)
mtlr 0
addi 1, 1, 0x60
"""


# Pulse A once per frame while the cursor holds its token. Port derivation
# mirrors the game: one door -> mnCharSel_804D6CF0, otherwise cursor->x4.
CHARPRESS_ASM = f"""
stwu 1, -0x60(1)
mflr 0
stw 0, 0x5C(1)
mfcr 0
stw 0, 0x20(1)
stmw 25, 0x24(1)

lis 31, 0x8048
lwz 31, -0x62D0(31)
rlwinm 31, 31, 8, 16, 31
cmpwi 31, 8
bne PR_EXIT

lbz 31, -0x49AA(13)
cmpwi 31, 0
bne PR_EXIT
{standdown_block("PR")}
lbz 30, -0x49B0(13)
cmpwi 30, 4
bge PR_EXIT
lis 29, 0x804A
ori 29, 29, 0x0BC0
rlwinm 31, 30, 2, 0, 29
lwzx 29, 29, 31
cmpwi 29, 0
beq PR_EXIT

lbz 31, 5(29)
cmpwi 31, 1
bne PR_EXIT

lbz 31, -0x49AB(13)
cmpwi 31, 1
bne PR_USE_X4
mr 28, 30
b PR_HAVE_PORT
PR_USE_X4:
lbz 28, 4(29)
PR_HAVE_PORT:
cmpwi 28, 4
bge PR_EXIT

lis 27, 0x804C
ori 27, 27, 0x20BC
mulli 31, 28, 0x44
add 27, 27, 31

lbz 31, 0x41(27)
extsb. 31, 31
bne PR_EXIT

lis 31, 0x8048
lwz 31, -0x62A0(31)
andi. 31, 31, 3
bne PR_CLEAR
lwz 26, 0(27)
ori 26, 26, 0x100
stw 26, 0(27)
lwz 26, 8(27)
ori 26, 26, 0x100
stw 26, 8(27)
b PR_EXIT
PR_CLEAR:
lwz 26, 0(27)
rlwinm 26, 26, 0, 24, 22
stw 26, 0(27)
lwz 26, 8(27)
rlwinm 26, 26, 0, 24, 22
stw 26, 8(27)

PR_EXIT:
lmw 25, 0x24(1)
lwz 0, 0x20(1)
mtcrf 0xFF, 0
lwz 0, 0x5C(1)
mtlr 0
addi 1, 1, 0x60
"""


def _emit_c2(asm_text, hook_addr, trailing_words):
    ks = keystone.Ks(keystone.KS_ARCH_PPC,
                     keystone.KS_MODE_PPC32 | keystone.KS_MODE_BIG_ENDIAN)
    # keystone only accepts ascii; the comments above are prose and may not be
    asm_text = asm_text.encode("ascii", "replace").decode("ascii")
    encoding, _ = ks.asm(asm_text)
    data = bytes(encoding)
    assert len(data) % 4 == 0
    words = list(struct.unpack(f">{len(data)//4}I", data))
    words += trailing_words
    if len(words) % 2 == 0:
        words.append(0x60000000)
    words.append(0x00000000)
    lines = len(words) // 2
    out = [f"C2{hook_addr & 0xFFFFFF:06X} {lines:08X}"]
    for i in range(0, len(words), 2):
        out.append(f"{words[i]:08X} {words[i+1]:08X}")
    return "\n".join(out)


def assemble(stage_id=0x1F, stage_picker=True, random_stage=False):
    # trailing: re-materialise `li r0,0` (the instruction before the hook), then
    # the instruction the hook replaced
    return _emit_c2(build_autodirect_asm(stage_id, stage_picker, random_stage),
                    HOOK_ADDR, [0x38000000, ORIG_INSTR])


def assemble_boot(guard_level=3):
    order = []
    if guard_level >= 3:
        order.append(BOOT_GUARDS["appstate"])
    if guard_level >= 2:
        order.append(BOOT_GUARDS["menu"])
    order.append(BOOT_GUARDS["major"] if guard_level >= 1 else BOOT_GUARDS["frame"])
    return _emit_c2(build_autoboot_asm("".join(order)), BOOT_HOOK_ADDR,
                    [BOOT_ORIG_INSTR])


def assemble_charpick(char_name, with_color=True):
    return _emit_c2(build_charpick_asm(char_name, with_color), CHARPICK_HOOK_ADDR,
                    [CHARPICK_ORIG_INSTR])


def assemble_charpress():
    return _emit_c2(CHARPRESS_ASM, CHARPRESS_HOOK_ADDR, [CHARPRESS_ORIG_INSTR])


if __name__ == "__main__":
    print("# $AutoBoot");   print(assemble_boot())
    print("# $AutoDirect"); print(assemble())
    print("# $CharPick FOX"); print(assemble_charpick("FOX"))
    print("# $CharPress"); print(assemble_charpress())
