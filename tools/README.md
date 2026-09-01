# tools

`gen_gecko.py` is the PowerPC assembly source for Peppy's four game patches.
`export_geckos.py` assembles them into `../resources/geckos.json`, which is what
the app ships.

```
pip install keystone-engine
python tools/export_geckos.py    # regenerate
python tools/verify_geckos.py    # prove the JSON matches this source
```

`verify_geckos.py` compares every generated payload byte-for-byte against the
committed JSON. The committed JSON is the build that was actually tested
in-game, so a passing verify means the source here really is its source.

If a future Slippi release moves things, the addresses at the top of
`gen_gecko.py` are what to re-check.
