# Lando Docs Writing Style

Guidance for humans and agents writing Lando 4 documentation.

Lando 4 docs keep the Lando 3 brand voice, then tighten it: same personality, fewer words, less jargon.

## Brand in one line

Lando frees developers from fiddly local setup so they can ship real work.

Pillars that should show up in the writing, not as slogans:

- **Easy** — short path to a working app
- **Powerful** — full stack and workflow when you need it
- **Extensible** — plugins and overrides without starting over
- **Liberating** — app-level DX, not container plumbing homework

## Voice

Write like a sharp teammate who has set this up a hundred times.

| Do | Don't |
| --- | --- |
| Second person (`you`) | Passive institutional voice |
| Direct and concrete | Marketing fluff |
| Light humor when it earns its keep | Forced jokes or meme spam |
| Honest about limits and sharp edges | Fake perfection or hype |
| Confident recommendations | Endless hedging |

Tone traits that match Lando:

- Conversational, not corporate
- Slightly irreverent toward unnecessary complexity
- Encouraging without hand-holding forever
- Self-aware when something is awkward ("this command is rough; here's the useful path")
- Human emphasis is fine (`really`, bold, occasional caps) — sparingly

Humor is seasoning, not the meal. One good line beats three bits.

## Lando 4 differences from Lando 3

Keep the soul. Cut the bulk.

1. **More concise.** Prefer the shortest page that still gets someone unstuck.
2. **Less jargon.** Prefer plain words first; introduce Lando terms only when needed.
3. **Faster payoff.** Show a working snippet early. Explain after.
4. **Fewer tangents.** Link out instead of nesting every related concept inline.
5. **Less throat-clearing.** Skip long preambles, brand monologues, and "in this document we will..."

Lando 3 often warmed up with personality and multi-section setup. Lando 4 should get to the command or config sooner, then add color only where it helps.

### Concision rules

- One idea per section.
- Prefer one solid example over four near-duplicates.
- Delete throat-clearing: "It is important to note that", "As mentioned above", "In order to".
- If a paragraph restates the heading, cut the paragraph.
- Default max for a how-to body before examples: a few short paragraphs, not a essay.

### Jargon rules

Allowed brand/product terms (use consistently, define once on first use in a page when non-obvious):

- Landofile
- app
- service
- recipe
- tooling
- plugin
- proxy / routing
- provider

Avoid or translate on first use:

| Prefer | Instead of |
| --- | --- |
| config file / Landofile | "orchestration manifest", "compose abstraction" |
| start the app | "bootstrap the runtime", "bring up the stack" |
| run inside the service | "exec into the containerized environment" |
| rebuild | long explanations of image/layer invalidation unless the page is about that |
| defaults | "sane start-state-of-defaults" style piles |

Docker/Compose terms are fine when the user must touch them. Don't force infrastructure vocabulary into app-level guides.

## Audience

Default reader: a developer who knows git and the terminal, wants the app running, and does not want a Docker course.

Write so:

1. A new teammate can clone, start, and work.
2. A maintainer can encode the team's real workflow in the Landofile.
3. Power users can find overrides without drowning beginners.

If a page is advanced, say so up top in one line, then proceed.

## Page shape

Most pages should follow this arc:

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

\```bash
# ...
\```

## Configure

Minimal Landofile or flags.

## Common options

Only high-traffic knobs.

## Troubleshooting

Symptoms → fix. Keep short.
```

### Frontmatter

Match the repo's existing docs format for the page type (guide MDX, reference MDX, plain Markdown). Descriptions should be outcome-oriented:

- Good: `Start an app and open its local URL.`
- Bad: `This document provides comprehensive information regarding the process of...`

## Language

### Prefer

- Short sentences.
- Concrete verbs: start, stop, rebuild, import, install, expose, mount.
- Active voice.
- Contractions natural English (`you'll`, `don't`) in guides.
- Exact command and file names in backticks: `lando start`, `.lando.yml`.
- Kabob-case service names in examples: `appserver`, `db`, `cache`.

### Avoid

- Empty intensifiers: "robust", "seamless", "powerful solution", "leverage".
- Fake friendliness: "Simply just easily..."
- Fear without a fix.
- Inside baseball without a link or definition.
- Walls of bold/caps.
- Emoji decoration in reference docs (fine rarely in bloggy/guide intros if it already fits the page type).

### Emphasis

- **Bold** for a critical warning or the one key idea in a section.
- Caps only for rare hard requirements (`MUST` style), not vibes.
- Blockquotes for the rare principle worth remembering, not ordinary tips.

## Examples

Examples are the product.

Rules:

1. **Copy-pasteable.** Commands should work when run in order.
2. **Minimal first.** Smallest Landofile or command that proves the point.
3. **Then one richer variant** if complexity is the point. Stop there unless the page is a cookbook.
4. **Show both sides** when teaching config: YAML in, command out.
5. **Comment the why**, not the what, in shell blocks.
6. **Use realistic names** (`my-app`, `web`, `db`) — not `foo`/`bar` unless truly generic.
7. **Prefer repo fixtures/examples** when the docs system expects them.

Escalation pattern (from Lando 3, still good when tightened):

```yaml
# minimal
name: my-app
recipe: drupal

# slightly real
name: my-app
recipe: drupal
config:
  php: "8.3"
```

Don't climb all the way to a kitchen-sink Landofile unless the page is explicitly about advanced composition.

## Structure patterns that work

### Progressive disclosure

Teach the 80% path first. Put power features behind a clear heading ("Customize", "Overrides", "Advanced").

### Recipe → services → tooling → events

When explaining how apps grow, keep that order. People should feel progress, not a concept dump.

### Symptom → fix in help docs

Lead with what the user sees (error text, bad behavior), then the fix, then optional deep background.

### Reference vs guide

| Guides | Reference |
| --- | --- |
| Task-oriented | Inventory-oriented |
| Narrative + examples | Flags, schemas, defaults |
| Opinionated happy path | Complete and precise |
| Can have voice | Voice stays dry and clear |

Executable guide MDX in this repo may be scenario-driven. Prose around scenarios should still follow this style: short, plain, outcome-first. Don't let scenario machinery leak jargon into user-facing sentences.

## Callouts

Use callouts sparingly.

- **Tip** — shortcut or best practice
- **Warning** — data loss, security, rebuild required, host-specific footgun
- **Note** — small clarifying aside

If everything is a warning, nothing is. Prefer one sharp warning over three mild ones.

## Linking

- Link to the canonical page for a concept instead of re-explaining it.
- Use descriptive link text: `Landofile services`, not `click here`.
- Don't build circular tour-guide chains.

## Honesty and edge cases

Lando docs are allowed to be blunt:

- Bad defaults or rough commands can be called out.
- Unsupported/EOL paths can say "YMMV; upgrade is the real fix."
- Prefer "run this" over "you may wish to consider potentially running".

Never hide a destructive default. If a command wipes a database, say that before the command.

## Words we like

These fit the brand when used naturally:

- free / free yourself (from setup pain, not political essays)
- start state / defaults
- rebuild when config changes
- ship / real work
- local URL / app URL
- team-shareable config

These are usually noise:

- paradigm, ecosystem synergy, next-generation, revolutionary
- "simply", "just", "easily" as filler
- "leverage", "utilize" (use `use`)

## Quick checklist

Before you merge a docs change:

- [ ] Can a skimming reader get the win from the first screen?
- [ ] Is there a working example near the top?
- [ ] Did you cut a paragraph that only repeated the heading?
- [ ] Are Lando terms necessary and consistent?
- [ ] Are warnings placed before destructive actions?
- [ ] Does it still sound like Lando — human, direct, a little spicy — without performing?

## Tiny before/after

**Before (Lando 3-ish, loose):**

> In order to leverage Lando's powerful tooling abstraction layer, you can define highly configurable command routing in your Landofile so that complex multi-service orchestration becomes a delightful developer experience.

**After (Lando 4):**

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

Same product. Fewer words. Clearer win.
