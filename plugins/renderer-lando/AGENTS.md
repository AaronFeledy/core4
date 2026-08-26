# `@lando/renderer-lando` Instructions

Inherit root `AGENTS.md`. Keep only package-specific facts agents would miss.

## Design

- Read, follow, and update `DESIGN.md` before any renderer visual, design, color, layout, or motion work.
- `DESIGN.md` is the TTY rail contract. Do not invent tokens, glyphs, or motion outside it.
- plain, JSON, verbose, non-TTY, and CI stay undecorated. Do not leak rail chrome, glyphs, or colors into machine modes.

## Gotchas

- Pink (`csi.pink`, SGR 95) is rail chrome plus the active moving spinner glyph only. Running labels, static dot, wrap continuations, durations, and footers stay off pink.
- Paint segmented bodies through `styleBodyFrameSegments` and existing `csi` tokens. Do not add color tokens or raw ANSI literals.
