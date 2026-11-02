# Examples and page patterns

Use these with [SKILL.md](SKILL.md), the single source of truth. These are illustrative editorial examples and patterns, not live transcripts or a new product specification. Recheck behavior against the revision being edited before reusing an example.

## Task inputs

```text
Target page(s): [paths]
Mode: [audit / revise existing / write new]
Reader: [application developer / plugin author / contributor / operator]
Reader's goal: [one concrete outcome or question]
Assumed knowledge: [what the reader already knows]
Scope: [allowed files and changes]
```

Editorial brief: "For [reader], this page helps them [goal], assuming [starting knowledge/state]."

## Page patterns

Choose the dominant form. A landing page or README may route to several forms. Do not force it into a tutorial or dump every audience's material into it.

| Form | Job | Pattern |
| --- | --- | --- |
| Tutorial | Lead a learner through one reliable experience, explaining enough to learn from it. | One supported starting state, achievable result, sequential steps, explanations at the moment of need, visible checkpoints. Move optional architecture and recovery internals out of the main learning path. |
| How-to | Solve a specific problem for a reader who knows the basics. Include real choices where needed. | Name the problem, state prerequisites, give the recommended path, branch only for relevant differences, verify the result, link related reference or explanation. |
| Explanation | Answer why/how, build a mental model, and explain tradeoffs through concrete examples. | Start with the question; introduce a concrete scenario; explain the mechanism and why it matters; contrast a nearby concept or tradeoff; link to a task the reader can perform. Do not substitute an implementation inventory for a mental model. |
| Reference | Make exact facts easy to find through a predictable schema. | Use a stable schema appropriate to the item: purpose, syntax/type, accepted values, verified default, behavior, side effects, constraints, minimal example, related task. Use "not applicable" where appropriate; never fill missing facts with guesses. A flag's name repeated as its description is not a useful explanation. |
| README / landing page | Orient the reader and route audiences. | State readiness/support limits, provide the next action, and route audiences. Keep release evidence, internal exit criteria, and detailed architecture elsewhere. |

## Install wording

Illustrative before/after prose, not captured execution. Source reviewed at `dde7571c1cc6da30dd496d18f9addcbc4d7f2ef0`: [alpha install, lines 127–141](https://github.com/AaronFeledy/core4/blob/dde7571c1cc6da30dd496d18f9addcbc4d7f2ef0/docs/alpha-install-and-bug-reports.md#L127-L141). The example still matches that revision. Provider persistence is also described in [provider selection](../../../docs/guides/setup/provider-selection.mdx#what-persists).

### Before

On Intel Macs (`darwin-x64`), managed `lando` fail-closes. Docker is the live path. Install Docker Desktop, then:

### After

On an Intel Mac (`darwin-x64`), use Docker instead of the managed `lando` provider. Install Docker Desktop, then run:

```sh
lando setup --provider=docker
```

This command saves Docker as your provider. Setup does not install Docker for you.

## Runtime configuration wording

Illustrative before/after prose, not captured execution. Source reviewed at `dde7571c1cc6da30dd496d18f9addcbc4d7f2ef0`: [embedding, lines 49–59](https://github.com/AaronFeledy/core4/blob/dde7571c1cc6da30dd496d18f9addcbc4d7f2ef0/docs/embedding.md#L49-L59). The example still matches that revision; [the configuration service](../../../engine/src/services/config.ts) returns the captured snapshot and [the runtime layer](../../../core/src/runtime/layer.ts) supplies its configuration sources.

### Before

`makeLandoRuntime` resolves global config once while its layer builds and keeps that snapshot for the life of the runtime.

### After

Each runtime keeps its own configuration snapshot. `makeLandoRuntime` reads configuration when its layer builds; later file or environment changes do not update that runtime. Create a new runtime to load those changes.

## Executable guide shape

Illustrative MDX shape, not a verified transcript. Replace fixture names, behavior assertions, and values with evidence from the target guide. Keep execution and cleanup within the harness's isolated resources; scenarios must never run destructive commands on the host.

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

## Repository exemplars

- Shape, not voice: [Postgres](../../../docs/guides/services/postgres.mdx) and [app lifecycle](../../../docs/guides/tutorial/app-lifecycle.mdx). Both still have em dashes and noun H1s. Copy the MDX shape. Do not copy the dashes or the titles.
- Recipe shape only (not voice): [WordPress README](../../../recipes/wordpress/README.mdx).

## Good

Illustrative command-only example, not captured output:

Need a running app. Then:

```sh
lando start
lando info
```

Open the URL `lando info` prints. If nothing is listening, run `lando info` before you touch networking. You do not start Traefik by hand.

## Bad

Deliberately invalid specimen, not product guidance or a real transcript:

In this comprehensive guide, we will leverage Lando's robust, seamless workflow — just start Traefik, then utilize the recipe like Lando 3 Drupal 9.

```text
$ lando start
... started ...
```

This feature is not available yet.

## Quick invocation

Use the existing lando-write-docs skill to revise [path] for [reader] who wants to [goal]. First identify the three largest obstacles to that goal. Fix structure before prose. Preserve verified behavior and public links. Do not invent commands or output. Return the revision, technical verification, and the remaining reader questions.
