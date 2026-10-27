---
title: Author an executable guide scenario
description: Write one validated guide scenario and know how its execution, public transcript, and scaffold README relate.
---

# Author an executable guide scenario

Write a guide scenario that runs as authored and shows the commands readers should use.
This page covers the MDX shape, how variables bind to display and execution,
and which outputs a scenario feeds. For the editorial rules that decide
whether a page reads well, read `.agents/skills/lando-write-docs/SKILL.md`
in your checkout. For CI job details, use the
[CI runbook](./ci.md#guide-e2e-smoke-subset).

## Run one guide

Install the [pinned Bun version](./repository.md#build-from-source), then prepare
the repository once from its root:

```sh
bun install --frozen-lockfile
bun run codegen
```

The example below uses the test provider and does not need a container runtime.
For real-provider e2e scenarios, complete the provider and helper setup in the
[source-build instructions](./repository.md#build-from-source).

Regenerate and run the scenarios of one existing guide:

```sh
bun run dev:guides recipes/django/README.mdx --once
```

Any guide path works in that slot: a recipe README under `recipes/<id>/`, or
a guide under `docs/guides/<area>/<id>.mdx`, where `<area>` is the directory
(`authoring`, `recipes`, and so on) and `<id>` is the frontmatter `id`. The
command accepts at most one guide path and the `--once` flag. Without
`--once` it watches guide and production sources and reruns affected
scenarios on change. Require both a zero exit and a positive test count. If
the path is misspelled, correct it rather than accepting an empty test run.

Before you push, run the structural and semantic lint:

```sh
bun run lint:guides
```

A guide under `docs/guides/**` also needs an index row; see
[coverage](#register-coverage).

## Write one complete scenario

Save this as `docs/guides/authoring/my-first-guide.mdx`. Every component
below is a real one, and the commands run against `provider: test`, which
models `init` and config inspection without starting containers.

~~~~mdx
---
id: my-first-guide
provider: test
timeout: 60000
tags: [beta, docs, authoring]
---

# Create an app from the empty recipe

Create a Landofile with no services, then confirm what the recipe wrote.
`--yes` accepts the defaults for prompts that `--name` does not answer.

```sh
lando init --recipe empty --name=my-app --yes
```

<Guide>
  <Scenario id="reader-path" render>
    <Step name="scaffold">
      <Variable name="appName" value="my-first-guide-demo" display="my-app" />
      <Run command="lando init --recipe empty --name={{appName}} --yes" />
    </Step>
    <Step name="inspect">
      <Run command="lando app:config --format=json" />
      <Verify command="lando app:config --format=json" expect={{ stdout: { regex: "\"recipe\":\\s*\\{\\s*\"id\":\\s*\"empty\"" } }} />
      <Verify command="lando app:config --format=json" expect={{ stdout: { regex: "\"runtime\":\\s*4" } }} />
    </Step>
    <Step name="cleanup">
      <Cleanup />
    </Step>
  </Scenario>
</Guide>
~~~~

Then run it:

```sh
bun run dev:guides docs/guides/authoring/my-first-guide.mdx --once
```

What each part does:

- The shell fence above `<Guide>` is illustrative. It never runs. Inside a
  scenario, shell goes through `<Run>`; a raw fence there fails lint.
- `<Variable>` binds `appName` once. Execution uses `value`
  (`my-first-guide-demo`), which must be safe to create in an isolated
  temporary directory. Readers see `display` (`my-app`). Both are plain
  literals: a name, a path, or a masked credential, never a sentence.
- `<Run>` runs the command and shows it. `<Verify command>` reruns the
  command and asserts on its output. Assert `--format=json` output, not boxed
  table output, because the table wraps at terminal width.
- `<Cleanup />` registers scenario cleanup. Keep it in every scenario that
  creates an app, and pair it with `lando destroy -y` on `layer="e2e"`.
- A regex inside `expect={{ ... }}` must contain no single quote. The prop is
  converted to JSON, and that conversion turns every `'` into `"`.

A scenario must exercise or assert product behavior. Keep prose outside the
scenario, and do not add a scenario solely to hold variables or setup.

### Where each component goes

The compiler checks placement and rejects anything out of place with the
guide path and line, so a misplaced component never silently drops out of
the test.

| Component | Direct parent |
| --- | --- |
| `<Guide>` | the page (one per guide) |
| `<Scenario>` | `<Guide>` |
| `<Step>`, `<Hidden>`, `<Skip>`, `<Tabs>` | `<Scenario>` |
| `<Tab>` | `<Tabs>` |
| `<Step>` | also `<Hidden>`, `<Skip>`, `<Tab>` |
| `<Run>`, `<Verify>`, `<Cleanup>`, `<Variable>`, `<UseFixture>`, `<Inspect>`, `<Inline>` | `<Step>` |

Wrappers do not nest: no `<Hidden>` inside a `<Tab>`, no `<Tabs>` inside
`<Skip>`. Write each component as block MDX, not inside a prose paragraph.
A component inside a paragraph, such as `Run <Verify command="lando start" />
first.`, is text to MDX, not an action, and fails the same way. Markdown
prose between components inside a wrapper is fine.

### What `expect` accepts

The `expect` prop of `<Verify>` is a matcher:

- A string, number, boolean, or `null` must equal the value exactly.
- An array must match an array of the same length, element by element.
- A plain object is partial: every key you list must match, and keys you
  leave out are ignored, so `{ stdout: { ... } }` says nothing about `stderr`.
- `{ regex: "..." }` tests the value as a string against the pattern.
- `{ schema: "AppPlan" }` decodes the value with a named public schema,
  such as the one on the
  [AppPlan schema reference](../reference/schemas/app-plan.mdx). A name that
  is not published does not match, so the verification fails when the test
  runs.
- `{ anyOf: [...] }` passes when any listed matcher passes.
- `{ not: ... }` inverts one matcher.

Those are the only operators. `exact`, `allOf`, and `oneOf` are rejected,
and a partial object may not use any of those names as a key.

## How variables bind

One compiler validates the guide and resolves each scenario for each variant.
Execution, public transcripts, scaffold READMEs, and `lint:guides` all read
that same resolved result. Execution gets the `value` side of every binding;
the public transcript and the scaffold README get the same `display`
projection, so a guide that passes lint shows one consistent public command
in both and runs one consistent command underneath.

Bindings are collected for the whole scenario before any reference is
resolved, so a step may reference a variable declared in a later step.
Bindings are immutable: declaring the same name twice in one scenario is an
error, whether the duplicates are visible, hidden, or a mix. Declaring the
same name in two scenarios is fine, and so is declaring it in two `<Tab>`
blocks of one `<Tabs>` group, because only one tab is selected per variant.
The LAMP README does the first, binding `appName` separately in its
`reader-path` and `non-default-options` scenarios.

Only these props interpolate `{{name}}`:

| Component | Props |
| --- | --- |
| `<Run>` | `command` |
| `<Verify>` | `command`, `file` |
| `<Inspect>` | `file`, `json` |

The token is a simple identifier in double braces, with optional whitespace
around the name: `{{appName}}` and `{{ appName }}` both reference `appName`.
A spaced token whose name has no binding fails like any other unknown
reference. Execution substitutes `value`; the public command, path, or
summary substitutes `display`, falling back to `value` when no display is
set. An empty string is a valid bound value. A reference to a name with no binding is an error,
and so is a binding that nothing references.

Everything else stays literal: `<Run runtime="library" code>` and
`displayCode`, `<Inline>` code, matcher values, `--answer` strings, and shell
payloads. A dotted token such as `{{ app.name }}` in a Landofile template or
foreign syntax is not a guide binding and is left as written.

Hidden steps can reference visible or hidden bindings. A visible component
cannot reference a binding declared only in a `<Hidden>` block, even when
that binding has a `display`, because a reader could not see where the value
came from. A `render={false}` scenario has no public components, so this
rule does not apply there.

Never put a real credential in `value`. The `display` prop masks what readers
see; it is not secret storage, and the MDX is committed source.

### Read a binding diagnostic

A failed binding names the guide path and line, the scenario and variant,
and a remediation. It never prints the bound values. Fix the declaration or
reference it points at, then rerun:

```sh
bun run dev:guides docs/guides/authoring/my-first-guide.mdx --once
```

## Order, modes, and skips

Steps execute in authored order, including steps inside a selected `<Tab>`.
Each scenario runs in one mode: CLI commands or `<Run runtime="library">`,
not both. An `e2e` scenario is CLI only. Different scenarios on one page may
use different modes, which is how the
[canonical fixture](../guides/recipes/canonical-public-transcript.mdx) pairs
a CLI walkthrough with a library example.

Steps inside `<Skip>` are not executed, and their variables and references
are not active. A variant whose execution is skipped still validates: its
bindings, references, and order are checked even when nothing runs.

## Where a scenario ends up

| Output | Produced by | Source of truth |
| --- | --- | --- |
| Generated test | `bun run codegen` (also `dev:guides`) | `test/scenarios/generated/guides/<guideId>/<scenarioId>.test.ts` |
| Public transcript | `bun run codegen` (also `dev:guides`) | `dist/transcripts/public/guides/<guideId>/<scenarioId>[.<variant>].json` |
| Internal transcript | scenario execution (`bun test`, `dev:guides`, e2e) | `dist/transcripts/guides/<guideId>/<scenarioId>.json` |
| Scaffold README | `bun run codegen:recipe-readmes` | `recipes/<id>/.scaffold/<cell>.md` |

Read the table with these limits in mind:

- A public transcript is a static inventory of the visible frames of a
  rendered scenario, generated from the compiled guide at codegen time.
  Hidden steps, `render={false}` scenarios, and fixture wiring are excluded.
  Skipped and test-only scenarios produce no public transcript. Its presence
  says the guide compiled, not that anything ran.
- Execution evidence is the internal transcript a scenario writes when it
  runs, or the passing generated test. E2e scenarios on a real provider
  capture real output there.
- A scaffold README exists for every declared legal variant cell, including
  cells whose execution is skipped on the current host. The README shows the
  displayed commands in order, so a command appearing there is not proof it
  ran. Only an internal transcript or a test result is; the generated public
  inventory does not count either.
- The scaffold's cleanup section hoists the ordered fences from the cleanup
  step and merges only adjacent fences of the same language. That is a
  rendering choice; it does not change what executes.
- Generated tests and both transcript kinds are gitignored. Scaffold READMEs are
  committed, so regenerate them in the same change as the recipe README.

See [public transcripts](../guides/authoring/public-transcripts.mdx) for
the reader-facing description of the public artifact and
[e2e smoke scenarios](../guides/authoring/e2e-smoke-scenarios.mdx) for the
real-provider layer.

## Register coverage

A guide under `docs/guides/**` needs a `Shipped` row in
[`docs/guides/INDEX.md`](../guides/INDEX.md), and the owning PRD's
`## Guide Coverage` section when one exists. Then run:

```sh
bun run check:guide-coverage
bun run check:public-transcripts
```

If you changed a source path that a guide covers without touching that
guide, `check:guide-drift` fails against `origin/main`. Update the guide or
record a `Guide-Coverage-Skip:` reason in the PR body, as described in the
[repository instructions](../../AGENTS.md#guides-and-docs-as-tests).
