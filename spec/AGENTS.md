Important: editor tooling has known bugs around literal `$` in spec files. The bug bites hardest when `$` appears in code spans like `Bun.$`, in shell-parameter-expansion examples like `${VAR:-default}`, and in expression escape sequences like `$${`. Treat any change to a file that contains `$` as hazardous and verify byte-for-byte after the change lands.

Confirmed failure modes (verified 2026-05-08):

- The targeted-search-and-replace edit tool drops one `$` from any `$$` run inside the replacement text. So `$${` becomes `${` silently. Affects every escape example in §7.3.1, §7.3.2, §6.4, and §8.8.6.
- The targeted-search-and-replace edit tool can partially overwrite a file when the search anchor contains `Bun.$`. In one observed case the matched paragraph was replaced with the file's title plus a duplicated copy of the file body — a single Edit call expanded the file by ~100 lines and corrupted the section being edited. Recovery: `git restore <path>`.
- The full-file write tool preserves `$` correctly when the content is passed wholesale (verified by xxd round-trip).
- Bash heredocs with single-quoted delimiters (`<<'EOF'`) preserve `$` correctly.
- Python `open(p, 'w').write(content)` preserves `$` correctly.

Safe editing recipes (in order of preference):

1. **Surgical edit, no `$` in either old or new text:** the targeted edit tool is safe. Run the verifications below afterward anyway.
2. **Surgical edit where new text contains `$`:** use Python with literal strings, not the targeted edit tool. Example:
   ```bash
   python3 <<'PYEOF'
   p = 'spec/07-landofile-and-config.md'
   with open(p) as f: c = f.read()
   old = '...exact old text...'
   new = '...new text with $${ or ${VAR}...'
   assert c.count(old) == 1, 'anchor must be unique'
   c = c.replace(old, new)
   with open(p, 'w') as f: f.write(c)
   PYEOF
   ```
3. **Whole-file rewrite:** the full-file write tool is safe. Use this for new sections or large rewrites.
4. **Single-line patch fixing a known `$$` -> `$` corruption:** `sed -i 's|literal-broken|literal-fixed|' file` with single quotes around both sides.

After every edit to a file in `spec/`:

- `rg -n 'Bun\.#|# Lando v4|Part 8 of 15|Part 8 of 16|Part 8 of 17' spec/*.md` — should match nothing except legitimate `# Lando v4 — …` document titles and the `Part 8 of 17` header in 08-cli-and-tooling.md (the spec was extended from 16 to 17 parts when §19 “Executable Tutorials” was added; both old and new sentinels are listed so the check still flags any historical corruption that left the older string behind).
- `awk '/^```/{count++} END{print count; exit count % 2}' spec/<file>.md` — code-block parity must hold (even count, exit 0).
- `git diff` audit for `Bun.$` count parity against `HEAD`:
  ```bash
  for f in spec/*.md; do
    cur=$(grep -c 'Bun\.\$' "$f")
    orig=$(git show HEAD:"$f" 2>/dev/null | grep -c 'Bun\.\$' || echo 0)
    [ "$cur" = "$orig" ] || echo "DIFF $f: orig=$orig cur=$cur"
  done
  ```
- Specifically for `spec/08-cli-and-tooling.md`, confirm `Bun.$`, `ShellRunner`, `.bun.sh`, `app:shell`, and `host` engine references are still intact.
- If a `$$` literal escape appears in your change (e.g. `$${VAR}` or `$${`), grep for `\$\$` in the changed file and confirm every occurrence is correct.
