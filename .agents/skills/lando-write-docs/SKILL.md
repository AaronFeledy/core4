---
name: lando-write-docs
description: >
  Write and edit reader-facing Lando documentation: tutorials, how-to guides,
  explanations, reference pages, recipe READMEs, and their executable-guide
  fixtures and coverage metadata. Use for documentation work under docs/**
  and recipes/**/README.mdx. Do not use for normative architecture or behavioral
  specifications, spec/**, RFCs, ADRs, implementation plans, issue/PR descriptions,
  changelogs, or marketing. Markdown format or the word "docs" alone does not
  make a task eligible. For mixed tasks, apply this skill only to the
  documentation portion.
---

# Write Lando docs

## Scope

Apply this skill to reader-facing documentation, including contributor documentation and architecture explanations, not normative specifications, design decisions, or implementation plans. Artifact purpose determines scope, not its audience, subject, or Markdown format.

Determine scope per artifact. In mixed tasks, do not carry these editorial rules into specification work. Reading a specification as source material does not make that specification subject to this skill.

If loaded for an excluded task, stop applying it and follow the artifact's existing conventions. For documentation within scope, this is the editorial source of truth; do not invent a parallel style guide.

This is an editorial acceptance contract, not a replacement for repository instructions or a second documentation system. [Examples and page patterns](examples.md) support this contract; use the [review checklist](review-checklist.md) for detailed acceptance review. [Supporting reading](references.md) is optional, not required reading for every task.

Help a capable developer who is new to this part of Lando succeed without guessing. Write as an experienced colleague explaining something clearly, not as a changelog, architecture inventory, marketing page, or compressed list of implementation facts.

Optimize for fewer unanswered reader questions, not fewer words. Preserve technical distinctions, caveats, prerequisites, and failure behavior. Plain language is not permission to make a stronger claim than the evidence supports.

Voice: concrete, command-first, little ceremony. Sound like someone who ships Lando, not a blog. Do not copy Lando 3 product facts.

## Fail if

Any of these fails the page. Rewrite that item. Do not ship.

- Em dash (`—`) anywhere in user-facing prose. The Bad specimen in [examples.md](examples.md#bad) illustrates the ban
- Throat-clearing: "In this guide we will", "In this document we will", "It's important to note", "Let's explore"
- Marketing adjectives: robust, seamless, leverage, comprehensive, utilize, empower, unlock, cutting-edge, "Simply just easily"
- First-person-plural lecture ("we will now")
- Invented CLI output, `...`, "output omitted", or empty `<Inspect output />` sold as a transcript
- Harness placeholders shown as captured output: `expected exit 0`, `event "…" observed`, `command output`
- User told to start Traefik by hand
- Feature stubbed as unavailable when the product does the thing
- Default provider implied as Docker. Default is `lando` (managed Podman)
- User page leaks CI/NDJSON/`LANDO_TEST_*`/job names
- More than one dominant Diátaxis type on a content page (tutorial / how-to / reference / explanation). A landing page or README may route to several forms
- On how-to and tutorial pages only: essay or architecture before the first runnable step
- On how-to and tutorial pages only: numbered list that is not a sequence you can run
- On how-to and tutorial pages only: heading that does not name the action or the command
- Install, start, or config with no verify command (how-to / tutorial)
- Copied Lando 3 product facts (recipes-as-the-product, Drupal 9 first-app, Docker-as-default, start Traefik)

## Before you write

Establish target page(s), mode (audit / revise existing / write new), reader, one concrete goal, assumed knowledge, and allowed files and changes. If these can be inferred reliably, state your assumptions and proceed. Ask only when an unresolved choice would materially change the result. Do not invent a persona, command, feature, default, or product guarantee.

1. Read applicable repository instructions, the target pages, their navigation context, and a few neighboring pages. Inspect implementation, tests, command metadata, or examples for behavioral claims you will change. Record the revision reviewed.
2. Identify generated pages. Do not hand-edit generated reference output as a durable fix; update its authoritative metadata/template and regenerate only if authorized. If that source is outside scope, report the needed change.
3. Keep a short working evidence list: claim, source, and status (verified / inferred / unverified). Do not paste this list into user documentation. Do not copy secrets or private environment details into examples.
4. Write a one-sentence editorial brief: "For [reader], this page helps them [goal], assuming [starting knowledge/state]." Choose the dominant page form using [page patterns](examples.md#page-patterns).
5. Name the reader: application developer, plugin author, contributor, or operator; distinguish user and CI material. User pages get the Lando voice. CI pages stay dry and stay out of the user path. Keep user onboarding, plugin development, contributor setup, and CI operations visibly separate.
6. Before line-editing, fix the order. List what belongs on this page, what should move or be linked, and what must remain because the next action depends on it. Do not delete useful content merely because it is advanced. Avoid changing URLs, anchors, public identifiers, or navigation without considering existing links.
7. If you show a command: run it safely with isolated Lando roots and paste the real transcript, or show the command only (prose + fences). Do not invent stdout. Do not write `TODO: capture` on a user page. Never run destructive, account-changing, costly, or production actions just to validate prose without authorization.
8. If a path is not up yet, say what *does* work. Do not stub.

## Voice

You, not we. Imperative steps. Contractions in guides.

H1 is the goal or question. First body sentence is the outcome or direct answer, then the minimum context needed to use it. Do not open with implementation machinery unless this is an implementation explanation.

Humor, if already appropriate, is at most one line next to a real command. Do not add decorative analogies, forced friendliness, jokes, or arbitrary banned-word lists. The goal is clarity, not a stylized voice.

Brand shows up in the writing, not as slogans: easy path, full stack when you need it, plugins without starting over, app-level DX.

| Do | Don't |
| --- | --- |
| Second person (`you`) | Third institutional voice |
| Direct and concrete | Marketing fluff |
| At most one earned aside | Forced jokes or meme spam |
| Honest about limits | Fake perfection |
| Confident recommendation | Endless hedging |

- Name the actor and action: "Lando saves…", "The command reads…", "You can…". Avoid noun piles and unexplained passive constructions.
- Prefer ordinary verbs: use, run, read, save, change. Keep exact technical terms where they carry necessary meaning.
- Introduce an unfamiliar term through its purpose before relying on it. Use one name for one concept; do not vary terminology for elegance.
- Keep most sentences focused on one main idea. Split overloaded sentences, not every sentence. Do not impose a rigid word count or reading-grade target.
- Give each paragraph one reader question to answer. Use causal connections: "Because…", "After…", "This means…" only when they explain a real relationship.
- Use prose for explanation, numbered steps for order, bullets for a genuine set, and tables for comparable fields. Do not turn all prose into bullet fragments.
- Remove empty introductions, repeated summaries, and sentences that only restate the heading.
- Avoid promotional adjectives and unsupported absolutes. Do not call a task "easy", "obvious", "just", or "simple". Explain it.

Preserve important distinctions such as host versus container, application user versus contributor, configured versus running, and successful command completion versus verified working behavior. Explain a distinction with a small controlled example when prose alone is unclear.

### Jargon

Use consistently: Landofile, app, service, recipe, tooling, plugin, proxy / routing, provider.

| Prefer | Instead of |
| --- | --- |
| config file / Landofile | "orchestration manifest" |
| start the app | "bootstrap the runtime" |
| run inside the service | "exec into the containerized environment" |
| rebuild | image/layer essays unless that is the topic |

When the task provides no narrower reader, assume git + terminal and a goal of getting the app running, without requiring a Docker course. If the page is advanced, say so in one line, then proceed.

## Page shape

Put the happy path near the top of task-oriented pages. After a short orientation and essential prerequisites, give the shortest complete recommended path to a working result and its success check. Do not make readers traverse an architecture overview, all available options, or troubleshooting before their first success. Put alternatives, deeper explanations, and uncommon failures afterward or behind useful links. Keep required platform/provider decisions and safety warnings before the action they affect; "happy path first" never means hiding a prerequisite or risk. For explanation and reference pages, put the direct answer or most useful lookup first instead of inventing a quickstart.

For a procedure, use this pattern when relevant: Goal → prerequisites → action → expected result → recovery → next useful step. This is a reasoning pattern, not six mandatory headings. A short task may need only a paragraph and a command.

For every meaningful action:

- State where it happens: host/container/VM, shell, directory, file, or UI.
- Tell the reader what to create, save, replace, or run. A code block alone is not an instruction.
- Define placeholders and distinguish example values from literal required values.
- Put branch conditions before the branch. Readers should not run a generic instruction before discovering that their platform is an exception.
- Put destructive effects, costs, permissions, or irreversible consequences before the action.
- Show a verified observable result, or describe the expected state when output varies.
- Explain what the result means and what it enables next.
- Address the most likely relevant failure with a symptom, diagnosis, and next action. Do not attach a giant troubleshooting catalogue to every step.

Prefer one complete, coherent example over several disconnected fragments. Keep names, paths, versions, and configuration consistent across steps. Show enough context to place a snippet correctly; do not pretend omitted required setup is optional.

Headings reveal the question or task. On task-oriented pages, name the action or command (`Start an app`, `lando start`). Avoid vague headings such as "Overview" when a specific heading would help navigation.

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
- An e2e public transcript.

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

See the illustrative [executable guide shape](examples.md#executable-guide-shape).

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

## Acceptance and delivery

Run a technical pass and an editorial pass separately using [review-checklist.md](review-checklist.md). Build/link/lint success does not prove usability or factual completeness. Record PASS / NEEDS REVISION / UNVERIFIED for purpose, starting state, sequence, actionability, observability, recovery, terminology, scope, prose, and truth, each with a concrete location or reason. Treat unverified as different from incorrect. Fix consequential issues before declaring completion.

For audit mode, return prioritized findings with exact locations, reader impact, and proposed correction; do not change files. For revision/new-page mode, return the finished content or authorized patch, reader-facing changes, content moved or preserved and why, sources and checks (passed, failed, not run), and remaining factual questions or scope blockers.

Do not claim repository-wide improvement from one page. Pilot this contract on a small set, inspect the before/after result, and expand only after the pattern works.

See [examples and page patterns](examples.md), including the [quick invocation](examples.md#quick-invocation), for reuse.

## Authority

This skill is the durable authoring contract. Planning notes may be deleted. Do not leave user-facing rules only in planning material.
