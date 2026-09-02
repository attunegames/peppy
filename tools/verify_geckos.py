"""Regenerate every payload and compare byte-for-byte with resources/geckos.json.

The committed JSON is the version that was actually tested in-game, so this is
the check that the source in this repo really is the source of that binary.
"""
import json, pathlib, sys
import gen_gecko as g

REF_PATH = pathlib.Path(__file__).resolve().parent.parent / "resources" / "geckos.json"
ref = json.loads(REF_PATH.read_text(encoding="utf-8"))
fails = []
def cmp(name, got, want):
    print(("PASS  " if got == want else "FAIL  ") + name)
    if got != want:
        fails.append(name)

cmp("autoBoot", g.assemble_boot(3), ref["autoBoot"])
cmp("autoDirect", g.assemble(stage_picker=True), ref["autoDirect"])
cmp("autoDirectRandom", g.assemble(stage_picker=True, random_stage=True),
    ref["autoDirectRandom"])
cmp("autoDirectFollow", g.assemble(stage_picker=False), ref["autoDirectFollow"])
cmp("charPress", g.assemble_charpress(), ref["charPress"])
for name in sorted(ref["charPick"]):
    cmp(f"charPick[{name}]", g.assemble_charpick(name), ref["charPick"][name])
print(f"\n{len(fails)} mismatch(es)" if fails else "\nall payloads reproduce exactly")
sys.exit(1 if fails else 0)
