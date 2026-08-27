# Renderer-Lando Design System

Quiet TTY task trees for the bundled `lando` renderer. Extracted from the existing
left-rail painter and locked to the quiet grammar. Not a web surface.

## 0. Research Log

- Embedded refs: shortlisted Linear / Raycast / Claude CLI consoles. Picked
  existing Lando pink rail over a brand clone because the user locked the
  open-right left rail and the quiet grammar.
- Lazyweb: skipped. This is a terminal frame, not a product-screen clone.
- Imagen drafts: skipped. No imagegen path for ANSI frames.
- Perfection / React tooling: skipped. No DOM, no Lighthouse surface.

## 1. Atmosphere & Identity

A quiet operations rail. Identity at the top, one glyph per row, one verdict
at the bottom. The signature is the Lando-pink open-right left rail: `╭─` /
`│` / `╰─` with no right closure, no `LANDO OPS` banner, no status chips.

Personas: a developer watching `lando start`, a contributor reading goldens,
an agent consuming undecorated plain/JSON.

## 2. Color

ANSI SGR tokens from `csi` in `task-tree-frame.ts`. Terminal default background
and default foreground. Status colors are the standard 16-color palette only:
red 31, green 32, yellow 33, cyan 36, dim 2. No RGB or custom status palette.
`csi.amber` is the local name for standard yellow (33). Bright magenta 95 is
rail chrome and the active moving spinner glyph only, never a status color.

| Role | Token | SGR | Usage |
| --- | --- | --- | --- |
| Rail chrome | `--rail-pink` | `95` | `╭─` / `│` / `╰─` left rail, plus the active braille spinner glyph |
| Title text | `--text-bold` | `1` | Bold identity text in default foreground |
| Success | `--status-success` | `32` | `✓` rows |
| Failure | `--status-error` | `31` | `✗` rows |
| Live / cached | `--status-info` | `36` | Running labels, wrap continuations, static `·`, `cached` |
| Pending | `--status-warning` | `33` | `◌` rows (ANSI yellow) |
| Skipped | `--status-skipped` | `2` + `36` | `–` + `skipped` |
| Secondary | `--text-dim` | `2` | Details, remediation, footer copy |

Rules:

- Never introduce a color outside this table.
- Never communicate state by color alone. Glyph or compact word first.
- Title text is bold default, not pink. Footer copy is dim default, not pink.
- Pink is rail chrome plus the active moving spinner glyph. It is not a status
  color and must not paint labels, static `·`, wrap continuations, durations,
  or footers.
- Completed-row duration is `--text-dim` after the semantic glyph+label (and `cached` / `skipped` / exit). Duration does not inherit the row's status color, including on a duration-only wrap continuation.
- No chips, no telemetry ink, no raw fractional millisecond floats.

## 3. Typography

Host terminal font. No web type stack.

| Level | Shape | Usage |
| --- | --- | --- |
| Title | `╭─ {identity}` | Tree label while running; `summary ?? label` when done |
| Row | `│ {glyph} {label}{meta}` | One task |
| Detail | `│    {text}` | Live tail, remediation |
| Footer | `╰─ {verdict}` | Running ratio, `done`, or nonzero counts |

Rules:

- Titles show identity only. No status, count, or duration in the title.
- Metadata is optional and compact: `  cached`, `  skipped`, ` (exit N)`, duration.
- Duration: omit when undefined; `<1000` is two spaces + rounded ms; `>=1000`
  is two spaces + one-decimal seconds.

## 4. Spacing & Layout

Base unit is one terminal cell.

| Token | Value | Usage |
| --- | --- | --- |
| `--rail-prefix` | `╭─ ` / `│ ` / `╰─ ` | Open-right left rail |
| `--row-gap` | one space after glyph | Glyph to label |
| `--meta-gap` | two spaces | Label to `cached` / `skipped` / duration |
| `--detail-indent` | four spaces after `│` | Detail and remediation |
| `--min-width` | 40 cells | Proven ASCII and CJK |
| `--comfort-width` | 80 / 100 / 120 | Golden widths |
| `--resize-width` | 60 cells | Resize fixture |

Grid: one column, wrap by display width in `task-tree-frame.ts`. No right rail.
CJK orphan rebalancing stays in the framer, not the grammar.

Viewport: the live tree paints at the current cursor, immediately under the
typed command. It grows and shrinks in place. Logs commit above the tree, then
the tree is rewritten below. Do not pin the tree to the terminal footer.
Full-tail expand uses the alternate screen; leaving it returns to inline paint.

## 5. Components

### Task tree

- **Structure**: title, zero or more body rows, footer.
- **Variants**: running, all-green, mixed, all-fail, expanded tail.
- **States**:
  - pending: `│ ◌ {label}`
  - running: `│ {spinner|·} {label}` plus `│    {detail}`
  - success: `│ ✓ {label}{duration}`
  - cached: `│ ✓ {label}  cached{duration}`
  - skipped: `│ – {label}  skipped{duration}`
  - failed: `│ ✗ {label}{exitSuffix}{duration}` plus `│    ↳ {remediation}`
- **Footers**:
  - running: `╰─ {running}/{childCount} running`
  - all-green: `╰─ done{duration}`
  - all-fail: `╰─ {failed} failed{duration}`
  - mixed: `╰─ {succeeded} ok · {failed} failed{duration}`
- **Expanded**: `╭─ {task.label}`, one glyph row, `╰─ tail`.
- **Accessibility**: glyph plus word; 40-col wrap; no color-only state.
- **Motion**: braille spinner on the focused running row only. No decorative motion.
- **Layout**: open-right left rail. First paint is title, pending rows, footer.

### Machine modes

plain, JSON, verbose, non-TTY, and CI stay undecorated. They do not use this
rail, these glyphs, or these colors.

## 6. Motion & Interaction

| Type | Duration | Usage |
| --- | --- | --- |
| Spinner | 30fps live region | One running row; moving braille glyph is `--rail-pink`, label stays `--status-info` |
| Reduced motion | static `·` | Static `·` stays `--status-info`; no pink content glyph |

Rules:

- Animate only the running glyph. Never animate layout or color.
- Pink on the spinner is an active-motion exception, not a status color.
  Wrap continuations, static `·`, and settled rows keep their semantic tokens.
- Expand/collapse swaps the frame to the compact tail. No extra chrome.

## 7. Depth & Surface

Strategy: borders-only, and only the left rail.

| Type | Value | Usage |
| --- | --- | --- |
| Title | `╭─` | Identity |
| Body | `│` | Rows and details |
| Footer | `╰─` | Verdict |

No right `╮` / `╯`, no fill dashes, no boxed panels.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- State is a glyph or a compact word, never color alone.
- 40-column ASCII and CJK frames stay inside the cell budget.
- Screen-reader / CI consumers use plain or JSON, not the TTY rail.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
| --- | --- | --- | --- |
| Right-rail style helpers still exist | `styleBodyFrame` / `styleBottomFrame` | Framer still knows how to paint a closed box that this grammar never emits | Leave until a closed-frame surface returns |
| Summary panels keep their own chrome | summary goldens | Out of scope for the quiet task-tree grammar | Separate summary pass |
