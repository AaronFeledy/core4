---
name: lando-write-docs
description: Write and edit Lando v4 docs, executable guide MDX, recipe READMEs, and user-facing prose for this monorepo. Owns voice/style (formerly docs/STYLE.md) plus prose-first executable guides. Use for any docs/guides, recipe README.mdx, reference prose, INDEX coverage, guide fixtures, or doc wording changes.
---

# Lando write-docs

Single source of truth for **how to write** Lando documentation in this monorepo: brand voice, page shape, and executable-guide MDX rules.

Load this skill before drafting or editing docs. Do not invent a parallel style guide.

---

## Brand in one line

Lando frees developers from fiddly local setup so they can ship real work.

Pillars that should show up in the writing, not as slogans:

- **Easy** — short path to a working app
- **Powerful** — full stack and workflow when you need it
- **Extensible** — plugins and overrides without starting over
- **Liberating** — app-level DX, not container plumbing homework

---

## Voice

Write like a sharp teammate who has set this up a hundred times.

| Do | Don't |
| --- | --- |
| Second person (`you`) | Third institutional voice |
| Direct and concrete | Marketing fluff |
| Light humor when it earns its keep | Forced jokes or meme spam |
| Honest about limits and sharp edges | Fake perfection or hype |
| Confident recommendations | Endless hedging |

Tone traits:

- Conversational, not corporate
- Slightly irreverent toward unnecessary complexity
- Encouraging without hand-holding forever
- Self-aware when something is awkward ("this command is rough; here's the useful path")
- Human emphasis is fine (`really`, bold, occasional caps) — sparingly

Humor is seasoning, not the meal. One good line beats three bits.

---

## Defaults

1. **Be concise.** Prefer the shortest page that still gets someone unstuck.
2. **Prefer plain language.** Introduce Lando terms only when needed.
3. **Pay off fast.** Show a working snippet early. Explain after.
4. **Stay on the path.** Link out instead of nesting every related concept inline.
5. **Skip throat-clearing.** No long preambles, brand monologues, or "in this document we will..."

### Concision

- One idea per section.
- Prefer one solid example over four near-duplicates.
- Delete filler: "It is important to note that", "As mentioned above", "In order to".
- If a paragraph restates the heading, cut the paragraph.
- Default max for a how-to body before examples: a few short paragraphs, not an essay.

### Jargon

Allowed product terms. Use them consistently. Define once on first use when non-obvious:

- Landofile, app, service, recipe, tooling, plugin, proxy / routing, provider

| Prefer | Instead of |
| --- | --- |
| config file / Landofile | "orchestration manifest", "compose abstraction" |
| start the app | "bootstrap the runtime", "bring up the stack" |
| run inside the service | "exec into the containerized environment" |
| rebuild | long image/layer invalidation essays unless that is the topic |
| defaults | "sane start-state-of-defaults" style piles |

Docker/Compose terms are fine when the user must touch them. Don't force infrastructure vocabulary into app-level guides.

---

## Audience

Default reader: a developer who knows git and the terminal, wants the app running, and does not want a Docker course.

Write so:

1. A new teammate can clone, start, and work.
2. A maintainer can encode the team's real workflow in the Landofile.
3. Power users can find overrides without drowning beginners.

If a page is advanced, say so up top in one line, then proceed.

---

## Choose the doc surface

| Need | Put it here |
| --- | --- |
| User how-to / walkthrough (± CI proof) | `docs/guides/<area>/<id>.mdx` |
| Canonical recipe walkthrough (+ scaffold README) | `recipes/<id>/README.mdx` |
| Flags, schemas, inventories | `docs/reference/**` (or generated reference) |
| Guide machinery / planning | `spec/17-executable-tutorials.md` (not user-facing) |

Guides are task-oriented and opinionated. Reference is inventory-oriented and dry.

---

## Page shape

Most pages follow this arc:

1. **What it is** — one or two sentences
2. **Do the thing** — command or minimal config
3. **Options / variations** — only what people actually change
4. **Warnings** — data loss, rebuild needs, host-only gotchas
5. **Next** — one or two links, not a sitemap

### Good skeleton

```markdown
# Title

One-sentence description of the outcome.

## Quick start

\`\`\`bash
# ...
\`\`\`

## Configure

Minimal Landofile or flags.

## Common options

Only high-traffic knobs.

## Troubleshooting

Symptoms → fix. Keep short.
```

### Frontmatter

Match the existing format for the page type (guide MDX, reference MDX, plain Markdown). Descriptions are outcome-oriented:

- Good: `Start an app and open its local URL.`
- Bad: `This document provides comprehensive information regarding...`

Guide MDX frontmatter is `GuideFrontmatter`: `id`, `provider` / layer, `timeout`, `tags`, optional `platforms`, `defaultLayer`, etc.

---

## Language

### Prefer

- Short sentences; concrete verbs (start, stop, rebuild, import, install, expose, mount).
- Active voice; contractions in guides (`you'll`, `don't`).
- Exact commands and paths in backticks: `lando start`, `.lando.yml`.
- Realistic service names: `appserver`, `db`, `cache`.

### Avoid

- Empty intensifiers: "robust", "seamless", "leverage", "utilize".
- Fake friendliness: "Simply just easily..."
- Fear without a fix; inside baseball without a link.
- Walls of bold/caps; emoji decoration in reference docs.

### Emphasis

- **Bold** for a critical warning or the one key idea in a section.
- Caps only for rare hard requirements, not vibes.
- Blockquotes for rare principles, not ordinary tips.

---

## Examples

Examples are the product.

1. **Copy-pasteable.** Commands work when run in order.
2. **Minimal first.** Smallest Landofile or command that proves the point.
3. **Then one richer variant** if complexity is the point. Stop there unless it is a cookbook.
4. **Show both sides** when teaching config: YAML in, command out.
5. **Comment the why**, not the what, in shell blocks.
6. **Realistic names** (`my-app`, `web`, `db`) — not `foo`/`bar` unless truly generic.
7. **Prefer repo fixtures** when the docs system expects them.

Escalation: minimal → slightly real. Don't climb to a kitchen-sink Landofile unless the page is about advanced composition.

---

## Structure patterns

- **Progressive disclosure** — 80% path first; power features under "Customize" / "Advanced".
- **Recipe → services → tooling → events** when explaining how apps grow.
- **Symptom → fix** in help docs (error text first, then fix, then optional background).

| Guides | Reference |
| --- | --- |
| Task-oriented | Inventory-oriented |
| Narrative + examples | Flags, schemas, defaults |
| Opinionated happy path | Complete and precise |
| Can have voice | Voice stays dry and clear |

---

## Executable guides are Markdown first

An executable guide is a **Markdown document with a small executable core** — not a component tree with words stuffed into attributes. Prose around scenarios stays short, plain, outcome-first. Scenario machinery must not leak jargon into user sentences.

### Rules

1. **Prose carries meaning.** Headings, paragraphs, lists, tables, fenced code. Raw MDX must read top-to-bottom as a guide.
2. **Components only execute.** `<Run>`, `<Verify>`, `<Cleanup>`, `<UseFixture>`, `<Inspect>`, `<Inline>` only for what the harness runs or asserts.
3. **Never pack sentences into attributes.** `display`, `reason`, `value` are machine hints. Verb clauses belong in prose.
4. **`<Variable>` is a binding.** Only when `{{name}}` is consumed by `<Run>` / `<Verify>`. Short `display` (name/path), never a sentence.
5. **Illustrative commands are fences** in prose **outside** `<Scenario>`. Inside a scenario, shell goes through `<Run>` (lint: `guide.shell-fence`).
6. **A scenario must do something.** At least one `<Run>`, `<Verify>`, or `<Inspect>` (or `<UseFixture>` feeding those). Vars-only / documentation-only scenarios are banned.
7. **`render={false}` is for real hidden tests**, with `reason` (≥ 8 chars). Not for "we documented this."

**Litmus test:** strip every JSX tag. What remains should still be a coherent, slightly terse guide. Title + silence = wrong layer.

### Shape

```mdx
---
id: kebab-guide-id
provider: test
timeout: 60000
tags: [beta, docs, <area>]
---

# Outcome-oriented title

Short intro. Working Landofile or command early.

\`\`\`yaml
name: demo
services:
  app:
    type: "node:22"
    primary: true
\`\`\`

## Non-executed detail

Tables, defaults, caveats. Illustrative commands:

\`\`\`sh
lando info --json
\`\`\`

<Guide>
  <Scenario id="happy-path" render>
    <Step name="start">
      <UseFixture name="my-fixture" />
      <Run command="lando start" />
      <Verify event="post-start" />
    </Step>
    <Step name="cleanup">
      <Cleanup />
      <Run command="lando destroy -y" />
    </Step>
  </Scenario>

  <Scenario id="rejects-bad-input" render={false} reason="Regression for tagged validation error">
    <Step name="start-invalid">
      <UseFixture name="invalid-fixture" />
      <Run command="lando start" expectExit={1} />
      <Verify errorTag="LandofileValidationError" expect={{ regex: "…" }} />
    </Step>
  </Scenario>
</Guide>
```

Prose may sit inside `<Guide>` between scenarios. Shell fences must not sit inside `<Scenario>`.

### Component cheat sheet

| Component | Use for |
| --- | --- |
| `<Guide>` | Root wrapper |
| `<Scenario id render?>` | One flow; `render={false}` + `reason` for hidden tests |
| `<Step name>` | Ordered unit |
| `<Run command>` / library `code` | Harness invocation |
| `<Verify …>` | Assertion |
| `<UseFixture name>` | Copy fixture into temp dir |
| `<Cleanup>` | Destroy/finalizer |
| `<Variable name value display?>` | Only if interpolated; short display |
| `<Inspect>`, `<Inline>`, `<Hidden>`, `<Skip>`, `<Tabs>` | See `sdk/src/docs/components/props.ts` |

### Fixtures

- `docs/guides/<guide-id>/fixtures/<name>/` (often `.lando.yml`).
- Immutable; every fixture dir must be referenced by `<UseFixture>` or lint fails.

### Harness reality

- Codegen → `test/scenarios/generated/guides/**` (gitignored).
- Public transcripts → `dist/transcripts/public/guides/**` (gitignored).
- Test provider does not boot real containers. Prefer `app:config`, lint, init, modeled events.
- `exec` / in-container needs stubbed test-provider exec or e2e — never vars-only stand-ins.
- When the harness cannot run the claim: **prose + fences**, point at the real unit/CI proof. Zero-scenario guides are valid for host-bound topics (WSL install, signing, etc.).

### Exemplars

- Service: `docs/guides/services/postgres.mdx`
- Tutorial: `docs/guides/tutorial/app-lifecycle.mdx`
- Recipe README: `recipes/wordpress/README.mdx`

Do **not** extend guides that are mostly `<Variable display="…">` trees — rewrite them.

---

## Coverage index

For shipped user-facing guides:

1. PRD `## Guide Coverage` when a PRD owns it.
2. `Shipped` row in `docs/guides/INDEX.md`.
3. `bun run check:guide-coverage`.

---

## Recipe READMEs

`recipes/<id>/README.mdx` is executable-guide-valid and feeds scaffold README generation. Prose before `<Guide>` is encouraged.

---

## Callouts, linking, honesty

- Callouts sparingly: Tip, Warning (before destructive actions), Note.
- Link to canonical pages; descriptive link text; no circular tour chains.
- Blunt is allowed. Never hide a destructive default. Prefer "run this" over hedging.

### Words we like

free / free yourself (from setup pain), start state / defaults, rebuild when config changes, ship / real work, local URL / app URL, team-shareable config.

### Usually noise

paradigm, synergy, next-generation, revolutionary, filler "simply/just/easily", leverage/utilize.

---

## Anti-patterns (reject on sight)

- Sentence-length `display="…"` / vars-only scenarios
- Shell fences inside `<Scenario>`
- Guide with only a `<Guide>` tree and no `#` title/intro
- Restoring Variable scenarios "for coverage" (always-green empty tests)
- Hand-editing `dist/transcripts/**` or `test/scenarios/generated/**`
- User docs that exist only under `spec/**`

---

## Verification (before done)

```bash
bun run lint:guides
bun run dev:guides docs/guides/<path>.mdx --once   # success + ≥1 pass
bun run check:guide-coverage   # if INDEX/PRD touched
bun run check:public-transcripts   # if reader scenarios matter
```

Also run any root `AGENTS.md` gate you touched. If static tests string-match guide phrases, update the test or restore the required phrase in prose.

---

## Quick checklist

- [ ] Skimming reader gets the win from the first screen?
- [ ] Working example near the top?
- [ ] Cut paragraphs that only repeated the heading?
- [ ] Lando terms necessary and consistent?
- [ ] Warnings before destructive actions?
- [ ] Sounds like Lando — human, direct, a little spicy — without performing?
- [ ] If executable: litmus test passes; no vars-only scenarios; gates green?

## Tiny before/after

**Before:**

> In order to leverage Lando's powerful tooling abstraction layer, you can define highly configurable command routing in your Landofile so that complex multi-service orchestration becomes a delightful developer experience.

**After:**

> Add tooling when you want a host command that runs in a service.
>
> ```yaml
> tooling:
>   php:
>     service: appserver
> ```
>
> ```bash
> lando php -v
> ```

## Spec pointer

Planning detail for the guide engine lives in `spec/17-executable-tutorials.md` (§19). Durable authoring rules live **here**; do not send agents to STYLE.md.
