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
tags: [docs, authoring]
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
- `<Cleanup />` marks a step to run once after the scenario's other steps, even
  on failure or interruption. Keep it in every scenario that creates an app.
  For `layer="e2e"`, put `lando destroy -y --volumes` or `lando destroy -y --purge`
  in the same step.
- Write `expect={{ ... }}` with literals, arrays, and plain objects only. The
  compiler evaluates the prop without running it, so a variable, a function
  call, or a template with `${}` fails the guide build. Either quote style works.

A scenario must exercise or assert product behavior. Keep prose outside the
scenario, and do not add a scenario solely to hold variables or setup.

### Override execution for one scenario

A scenario inherits the guide's timeout, platforms, and skip. Set a prop on
`<Scenario>` to change one of them for that scenario only.

- Set `timeout={300000}` on a slow scenario instead of raising the guide's
  timeout. The value is a positive whole number of milliseconds. A scenario
  without one uses the guide timeout, which defaults to `60000`.
- Set `platforms={["linux", "darwin"]}` to run only on the hosts you list.
  The accepted values are `darwin`, `linux`, `win32`, and `wsl`. A WSL host
  also matches `linux`. Use `platforms={[]}` to allow every host.
- Set `skip={{ reason: "Waiting for a provider fix", until: "Next release" }}`
  to skip the scenario's tests and omit its public transcript. `until` is
  optional. It notes when to revisit the skip and doesn't end it.

For `platforms` and `skip`, a value set on a frontmatter `variants` cell wins
over the scenario prop. When neither sets one, the guide's top-level
frontmatter value applies.

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
| `<Run>`, `<Verify>`, `<Fetch>`, `<Cleanup>`, `<Variable>`, `<UseFixture>`, `<Inspect>`, `<Inline>` | `<Step>` |

Wrappers do not nest: no `<Hidden>` inside a `<Tab>`, no `<Tabs>` inside
`<Skip>`. Write each component as block MDX, not inside a prose paragraph.
A component inside a paragraph, such as `Run <Verify command="lando start" />
first.`, is text to MDX, not an action, and fails the same way. Markdown
prose between components inside a wrapper is fine.

### Request a URL with `<Fetch>`

Put `<Fetch>` inside a `<Step>` in a `layer="e2e"` scenario, after starting
the fixture app. Include a cleanup step that destroys the app.

```mdx
<Fetch url="{{route:appserver}}/https-check.php" expect={{ status: 200, body: { regex: "HTTPS=on" } }} />
```

| Field | What it does |
| --- | --- |
| `url` | Absolute HTTP(S) URL without credentials, or a URL beginning with `{{route:<service>}}`. The token uses the first assigned HTTPS host route in `lando info --format=json`, or the first assigned HTTP route if there is no HTTPS route. Its URL retains the router's bound port and path prefix. Use an absolute URL to choose a different route. |
| `method` | `GET` by default, or `HEAD`. |
| `headers` | Optional request header names and string values. The request's `Host` comes from the URL. |
| `expect.status` | Required final response status, or a nonempty list of accepted statuses. |
| `expect.headers` | Optional map from response header names (case-insensitive) to matchers. A missing header is `null`. |
| `expect.body` | Optional matcher against the response body as text. |

The request connects directly to `127.0.0.1` at the URL's port without using
a proxy. HTTPS verifies the hostname and trusts the local CA from `lando setup`.
Redirects are not followed, so you can assert `302` and match `Location` in
the same step. The public transcript shows the request line without the query
or fragment, and the expected status. It does not publish headers, matchers,
or the response body. Do not put secrets in the URL path.

### What `expect` accepts

`<Verify>`'s `expect` and `<Fetch>`'s response header and body expectations use
the same matchers:

- A string, number, boolean, or `null` must equal the value exactly.
- An array must match an array of the same length, element by element.
- A plain object is partial: every key you list must match, and keys you
  leave out are ignored, so `{ stdout: { ... } }` says nothing about `stderr`.
- `{ regex: "..." }` tests the value as a string against the pattern.
- `{ schema: "AppPlan" }` checks that the value has the encoded (input) shape
  of a named public schema, such as the one on the
  [AppPlan schema reference](../reference/schemas/app-plan.mdx). This is a
  shape check only: it does not run the schema's transformations or the
  extra validation its decoder applies, so a value can pass this matcher and
  still be rejected when Lando decodes it. A name that is not published does
  not match, so the verification fails when the test runs.
- `{ anyOf: [...] }` passes when any listed matcher passes.
- `{ not: ... }` inverts one matcher.

Those are the only operators. `exact`, `allOf`, and `oneOf` are rejected,
and a partial object may not use any of those names as a key.

## How a command runs

Write `command` exactly as a reader would type it into a POSIX shell such as
bash or zsh. The scenario runs the argument list that shell would produce,
without starting a shell:

- Single quotes keep everything literal, double quotes allow `\"`, `\\`,
  `\$`, and `` \` `` escapes, and a backslash outside quotes escapes the next
  character. `''` passes an empty argument.
- Anything a shell would interpret must be quoted: `|`, `&`, `;`, `<`, `>`,
  `(`, `)`, `$`, backticks, `*`, `?`, `[`, `{`, `}`, `!`, and a `~` or `#` at
  the start of a word. Write `--jq '.result | keys'`, not `--jq .result|keys`.
- A command a shell cannot read the same way fails `bun run lint:guides`
  with `guide.command.syntax` at the component's line. Interpolated values
  count: `--name '{{appName}}'` keeps a value with spaces in one argument.

When an attribute needs both quote characters, use a template literal:

```mdx
<Run command={`lando config set serviceDefaults.environment '{"TEAM":"platform"}'`} />
```

### What a default scenario runs

A scenario without `layer="e2e"` runs the real `lando` command in process
against an in-memory provider. `lando start`, `stop`, `restart`, `poweroff`,
and `destroy` take their real code paths: start plans the app and records
its applied plan, later commands read that record, and destroy removes it.
No container runs, so command output from inside a service is the test
provider's echo of the command, and routes go to an in-memory router.
Use `layer="e2e"` for anything that needs a real container.

Each in-process invocation receives an explicit working directory, environment,
buffered renderer IO, and exit-status sink. Scenarios have separate Lando data,
cache, configuration, and system-plugin roots, so global-app state stays within
one scenario. Fixture paths resolve from the repository root captured by the
harness. Commands never change the host process directory or replace its streams.
For a static-site fetch, use an e2e scenario with `<Cleanup />` and
`lando destroy -y`.

For a command that needs real pipes, call `context.startCli(command, { stdin: "pipe" })`
from default-layer library code. Write a request, wait for its response with
`stdoutLine`, then call `closeInput` and await `result`. The scenario scope reaps
an unfinished child. The source child gets a scrubbed environment and isolated
Lando roots, but those roots isolate state, not access to the host. It does not
use the in-memory provider or record lifecycle events. Keep source dialogues
host-only and use the compiled e2e runner for provider-backed dialogues.

`<Verify event="post-start" />` passes when the most recent CLI command in
the scenario published that event, so put it right after the command:

```mdx
<Run command="lando stop --format=json" />
<Verify event="pre-stop" />
<Verify event="post-stop" />
```

e2e commands run in a separate process and publish no events to the
scenario, so assert their output instead.

### Exercise every app install you teach

An app-install command in a prose shell fence must also run in a live
`layer="e2e"` scenario somewhere under `docs/guides/**` or
`recipes/*/README.mdx`. `bun run lint:guides` checks this across files with
`guide.install.e2e-coverage`. It checks `sh`, `bash`, `shell`, and `console`
fences outside `<Guide>`, including commands split with backslash continuations
or prefixed with a `$ ` prompt.

Coverage matches `lando create-project` and `lando composer create-project`
by package name, ignoring quotes, versions, and flags. A version written
inline as `vendor/package:^2` matches the same package as a separate `^2`
argument or no version at all. Each
`lando <name>-scaffold` command has its own coverage key. The covering scenario
must execute a matching `<Run command>` or `<Verify command>`; variables use
their execution `value`, and skipped steps do not count.

Add the e2e scenario with `<Cleanup />` and `lando destroy -y`, or replace the
untested install instructions with a link to a guide whose e2e scenario runs
that install. Before calling the guide verified, run the covering scenario
on the default `lando` provider (managed Podman). A passing lint run proves
coverage is declared; a passing live run proves the install works. Use the
[e2e scenario instructions](../guides/authoring/e2e-smoke-scenarios.mdx#where-it-runs)
to enable live execution and confirm the scenario passed rather than skipped.

### Run every container command you show

When you show `lando exec`, `lando ssh`, `lando logs`, or Landofile tooling
such as `lando composer` in a prose shell fence, run it in an e2e scenario
on the **same page**. The rule applies to a built-in under its command ID and
its alias, so both `lando app:exec` and `lando exec` are in scope. Any name
that isn't a built-in counts as tooling, except `lando help`.

Cover the command with a `<Run command>` or `<Verify command>` that has the
same command name and the same arguments in the same order. Quoting can differ
as long as the argv is the same, and variables match by their execution
`value`. A `<Hidden>` step counts. A skipped step or scenario doesn't. The
scenario is e2e when it sets `layer="e2e"` or inherits it from the guide's
`defaultLayer`.

`bun run lint:guides` checks `sh`, `bash`, `shell`, `console`, and `zsh` fences
outside `<Guide>`. The rule reads each command in a shell list separately and
ignores host pipes and redirects after it. It skips a command that has a
placeholder argument: a bare `...`, or an angle-bracket name like `<service>`
used as an argument, option value, or path segment.

If the fence can't run in CI, put `{/* lando-lint: not-e2e <reason> */}` directly
above it with only whitespace in between. The reason needs at least eight
characters. A waiver covers the whole fence. Remove it once the fence no
longer shows a container command, or lint reports it as stale.

`scripts/guides/container-command-baseline.json` lists the uncovered commands
lint still allows, and it only shrinks. `check:guide-drift` compares it with
the base revision and rejects new entries. If you move a guide, carry its
entries to the new path once the old path is gone. When you cover, waive, or
remove a listed command, delete its entry or run
`bun run scripts/lint-guides.ts --prune-container-command-baseline`.

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
`displayCode`, `<Inline>` code, matcher values, `Run.answers` strings, and shell
payloads. Tokens inside `Run.command` are substituted, including tokens in
`--answer` arguments. A dotted token such as `{{ app.name }}` in a Landofile
template or foreign syntax is not a guide binding and is left as written.

`{{capture:name}}` is a different token: it is resolved at run time from a
`capture` on an earlier `<Run>` in a test-only scenario, and only a `<Run>` or
`<Verify>` `command` may use it, as one whole argument after the command name.
The compiler rejects a capture token used before its capture, an unknown
capture, and a capture in a rendered scenario. See
[E2E smoke scenarios](../guides/authoring/e2e-smoke-scenarios.mdx) for the reader-facing rules.

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

## Register a new fixture

A new directory under `docs/guides/<guide-id>/fixtures/<name>/` is checked
by four tests outside the guide tooling. `lint:guides`, `dev:guides`,
`check:guide-coverage`, and `check:public-transcripts` don't run them, so
finish these steps from the repository root before you push:

1. Record the fixture in the golden corpus, then commit the changed
   `landofile/test/fixtures/golden-corpus-digests.json`. The update stores a
   digest for an app that loads, or the error tag for one that fails to load.
   Only your fixture's entry should change.

   ```sh
   UPDATE_GOLDEN=1 bun test landofile/test/pipeline/golden-corpus.test.ts
   ```

2. If the fixture is deliberately invalid authoring input, put
   `# lando-lint: expect-invalid <reason>` on line 1 of its `.lando.yml`.
   `lint:guides` fails a marked fixture that decodes and an unmarked one that
   doesn't. Nothing else needs registering: the provenance test accepts a
   fixture that can't compose when it fails with the error tag step 1
   recorded, and the schema parity test reads the marker.

3. Run the four tests in one command. Require exit status 0 and a positive
   test count.

   ```sh
   bun test landofile/test/pipeline/golden-corpus.test.ts landofile/test/provenance-invariant.test.ts sdk/test/schema/landofile-parity.test.ts core/test/guides/fixture-lint-plan-parity.test.ts
   ```

## Put a feature's tests in its home guide

Every feature has one home guide, and that guide owns every test that drives
Lando through its CLI or library API for the feature. That includes edge
cases and regressions the page never mentions. Readers see the steps that
teach the feature; the rest run where readers don't see them:

- A `<Hidden reason="...">` block adds steps to a reader scenario, such as
  an edge case of the flow the page shows. A hidden step must not change what
  the visible steps show: a reader who runs only the visible steps gets the
  result the page describes.
- A test-only scenario, `<Scenario render={false} reason="...">`, holds a
  flow the page doesn't teach, such as a regression for a reported bug or a
  failure path. It never renders and produces no public transcript.

Other pages that teach the same feature link to its home guide instead of
repeating these tests. When you edit a guide, treat hidden steps and
test-only scenarios as tests, not as content to trim: deleting one removes
coverage.

Tests that call internal modules directly, such as a planner function or a
state-store transition, stay in the owning package's `test/` tree. A test
that drives the CLI but needs something the guide components can't express,
such as sending a signal to a running command, goes in a compiled-CLI live
suite under `core/test/live/`. Don't add a live suite that replays a flow a
guide already proves.

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
