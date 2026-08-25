---
name: lando-write-docs
description: >
  Write and edit Lando 4 docs, executable guide MDX, recipe READMEs,
  and user-facing prose. Owns voice, page shape, and prose-first executable guides.
  Use when editing docs/**, recipes/**/README.mdx, INDEX coverage, guide fixtures,
  or doc wording. Do not use for changelogs or marketing.
---

# Write Lando docs

Single source of truth for how to write docs in this monorepo. Load this skill before drafting. Do not invent a parallel style guide.

Voice: slightly irreverent and concrete. Command-first, little ceremony. Sound like someone who ships Lando, not a blog. Do not copy Lando 3 product facts.

## Fail if

Any of these fails the page. Rewrite that item. Do not ship.

- Em dash (`—`) anywhere. Allowed only here (the ban) and in the one Bad specimen below
- Throat-clearing: "In this guide we will", "In this document we will", "It's important to note", "Let's explore"
- Marketing adjectives: robust, seamless, leverage, comprehensive, utilize, empower, unlock, cutting-edge, "Simply just easily"
- First-person-plural lecture ("we will now")
- Invented CLI output, `...`, "output omitted", or empty `<Inspect output />` sold as a transcript
- Harness placeholders shown as captured output: `expected exit 0`, `event "…" observed`, `command output`
- User told to start Traefik by hand
- Feature stubbed as unavailable when the product does the thing
- Default provider implied as Docker. Default is `lando` (managed Podman)
- User page leaks CI/NDJSON/`LANDO_TEST_*`/job names
- More than one Diátaxis type on one page (tutorial / how-to / reference / explanation)
- On how-to and tutorial pages only: essay or architecture before the first runnable step
- On how-to and tutorial pages only: numbered list that is not a sequence you can run
- On how-to and tutorial pages only: heading that does not name the action or the command
- Install, start, or config with no verify command (how-to / tutorial)
- Copied Lando 3 product facts (recipes-as-the-product, Drupal 9 first-app, Docker-as-default, start Traefik)

## Before you write

1. Name the page type. Write only that type.
2. Name the reader: user, contributor, or CI. User pages get the Lando voice. CI pages stay dry and stay out of the user path.
3. If you show a command: run it with an isolated `LANDO` home and paste the real transcript, or show the command only (prose + fences). Do not invent stdout. Do not write `TODO: capture` on a user page.
4. If a path is not up yet, say what *does* work. Do not stub.

## Voice

You, not we. Imperative steps. Short sentences. Contractions in guides.

H1 is the goal. First body sentence is the command or the outcome. Theory after the runnable path.

Humor is one line next to a real command. Then get out of the way.

Brand shows up in the writing, not as slogans: easy path, full stack when you need it, plugins without starting over, app-level DX.

| Do | Don't |
| --- | --- |
| Second person (`you`) | Third institutional voice |
| Direct and concrete | Marketing fluff |
| One earned aside | Forced jokes or meme spam |
| Honest about limits | Fake perfection |
| Confident recommendation | Endless hedging |

### Jargon

Use consistently: Landofile, app, service, recipe, tooling, plugin, proxy / routing, provider.

| Prefer | Instead of |
| --- | --- |
| config file / Landofile | "orchestration manifest" |
| start the app | "bootstrap the runtime" |
| run inside the service | "exec into the containerized environment" |
| rebuild | image/layer essays unless that is the topic |

Default reader: git + terminal. Wants the app running. Does not want a Docker course. If the page is advanced, say so in one line, then proceed.

## Page shape

How-to: one-line prereq, then a numbered recipe (each step a command), then a verify command, then callouts.

1. What it is (one or two sentences)
2. Do the thing (command or minimal config)
3. Options (only what people change)
4. Warnings (data loss, rebuild, host gotchas)
5. Next (one or two links)

Headings name the action or the command (`Start an app`, `lando start`). Not "Understanding local environments."

When a knob has a flag, show YAML and CLI in one glance.

### Frontmatter

Outcome-oriented descriptions.

- Good: `Start an app and open its local URL.`
- Bad: `This document provides comprehensive information regarding...`

Guide MDX frontmatter is `GuideFrontmatter`: `id`, `provider` / layer, `timeout`, `tags`, optional `platforms`, `defaultLayer`.

## Product truths

- Default provider is `lando` (managed Podman). Do not change it to make a screenshot easier.
- The committed runtime-bundle manifest pins real published release assets, so default `lando setup` completes end-to-end. Do not tell readers it fails against placeholder bundles; `LANDO_RUNTIME_BUNDLE_MANIFEST` exists only for testing unpublished local bundles.
- Supported Linux fallback after default setup fails: `lando setup --provider=docker` (working system Docker) or `LANDO_PROVIDER=docker`. Not "advanced users who prefer Docker."
- Lando starts the proxy. Do not tell users to launch Traefik.
- Installers, `get.lando.dev`, and signed multi-platform releases that are not up stay not up. Do not un-stub them.
- Recipe READMEs (`recipes/<id>/README.mdx`) are executable-guide-valid and feed scaffold README generation. Drupal's e2e smoke is richer than drupal-cms. Do not flatten it.

## Transcripts

Examples are the product. Copy-pasteable. Minimal first. Then one richer variant.

Public captured output must be a real isolated-home transcript, or the page must not claim captured output.

When `provider: test` cannot produce real stdout (it does not boot containers):

- Prose + fences **outside** `<Scenario>`, or
- An e2e public transcript, or
Do not invent stdout. Do not write `TODO: capture` on a user page.

Never empty `<Inspect output />`. Never hand-edit `dist/transcripts/**` or `test/scenarios/generated/**`. Site hide-logic (`is-placeholder.ts`) is a safety net, not a license to ship stubs.

## Surfaces

| Need | Put it here |
| --- | --- |
| User how-to | `docs/guides/<area>/<id>.mdx` |
| Recipe walkthrough + scaffold README | `recipes/<id>/README.mdx` |
| Flags, schemas, inventories | `docs/reference/**` (generated: do not hand-edit) |
| Durable authoring rules | This skill. Not planning notes. |

Guides are task-oriented and opinionated. Reference is inventory-oriented and dry.

## Executable guides are Markdown first

Prose carries meaning. Components only execute: `<Run>`, `<Verify>`, `<Cleanup>`, `<UseFixture>`, `<Inspect>`, `<Inline>`.

- Never pack sentences into `display` / `reason` / `value`.
- `<Variable>` only if `{{name}}` is consumed. Short display. Never a sentence.
- Illustrative commands are fences **outside** `<Scenario>`. Inside a scenario, shell goes through `<Run>` (lint: `guide.shell-fence`).
- A scenario must do something. Vars-only / documentation-only scenarios are banned.
- `render={false}` is for real hidden tests, `reason` at least 8 chars.
- Litmus: strip every JSX tag. What remains is still a guide.

Fixtures: `docs/guides/<guide-id>/fixtures/<name>/`. Every dir must be referenced by `<UseFixture>`.

Test provider does not boot real containers. Prefer `app:config`, lint, init, modeled events. `exec` needs stubbed exec or e2e. Zero-scenario guides are valid for host-bound topics.

Do not extend Variable-display trees. Rewrite them.

### Shape

~~~~mdx
---
id: kebab-guide-id
provider: test
timeout: 60000
tags: [beta, docs, <area>]
---

# Outcome-oriented title

Short intro. Working Landofile or command early.

```yaml
name: demo
services:
  app:
    type: "node:22"
    primary: true
```

## Non-executed detail

Tables, defaults, caveats. Illustrative commands:

```sh
lando info --json
```

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
~~~~

Prose may sit inside `<Guide>` between scenarios. Shell fences must not sit inside `<Scenario>`.

## Coverage

1. PRD `## Guide Coverage` when a PRD owns it.
2. `Shipped` row in `docs/guides/INDEX.md`.
3. `bun run check:guide-coverage`.

## Verification

```bash
bun run lint:guides
bun run dev:guides docs/guides/<path>.mdx --once
bun run check:guide-coverage
bun run check:public-transcripts
```

If static tests string-match guide phrases, update the test or restore the required phrase.

## Exemplars

- Shape, not voice: `docs/guides/services/postgres.mdx` and `docs/guides/tutorial/app-lifecycle.mdx`. Both still have em dashes and noun H1s. Copy the MDX shape. Do not copy the dashes or the titles.
- Recipe shape only (not voice): `recipes/wordpress/README.mdx`

## Good

Need a running app. Then:

```sh
lando start
lando info
```

Open the URL `lando info` prints. If nothing is listening, run `lando info` before you touch networking. You do not start Traefik by hand.

## Bad

In this comprehensive guide, we will leverage Lando's robust, seamless workflow — just start Traefik, then utilize the recipe like Lando 3 Drupal 9.

```
$ lando start
... started ...
```

This feature is not available yet.

## Ship only if

- [ ] One Diátaxis type; H1 is the goal
- [ ] Opens on a command or outcome, not a lede
- [ ] You + imperative; no robot voice
- [ ] Zero em dashes; no throat-clearing; no banned adjectives
- [ ] Transcripts are real isolated-home captures, or the page does not claim captured output
- [ ] No Traefik-by-hand; provider is `lando`; Docker is fallback, not default
- [ ] No leftover Lando 3 product facts; no CI leaks on user pages
- [ ] Humor at most one line, next to a command
- [ ] If executable: litmus passes; no vars-only; no empty Inspect; gates green
- [ ] Warnings before destructive actions

## Authority

This skill is the durable authoring contract. Planning notes may be deleted. Do not leave user-facing rules only in planning material.
