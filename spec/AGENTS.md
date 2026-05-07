Important: a prior edit/write tool bug corrupted files containing literal `$`, especially `Bun.$` and shell/template examples. Do not use Write/Edit-style tools for changes that include `$`.
Safe editing rules:
- Prefer `apply_patch` for normal edits.
- If adding or changing text containing literal `$`, inspect the patch carefully before and after applying it.
- Never use an edit method that interpolates `$` through a shell, template, or unsafe writer.
- If using shell heredocs, use single-quoted delimiters, e.g. `<<'EOF'`.
- After editing, run:
  - `rg -n 'Bun\.#|# Lando v4|Part 8 of 15|Part 8 of 16' spec/*.md`
  - `awk '/^```/{count++} END{print count; exit count % 2}' spec/08-cli-and-tooling.md`
- If touching `spec/08-cli-and-tooling.md`, also verify `Bun.$`, `ShellRunner`, `.bun.sh`, `app:shell`, and `host` engine references are still intact.