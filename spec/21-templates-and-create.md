# Lando v4: Templates and `lando create`

> **Part 21 of 21** · [Index](./README.md)
> **Read next:** *(end of spec)*

**Templates** generate projects and add to existing ones. A template asks questions, writes files, runs steps in containers, and writes Lando configuration. `lando create` applies one. It composes recipes (§8.8), the `lando` template engine (§7.3), source acquisition (§12.8), scratch apps (§21), and execution sessions (§22). It is authored design, not a shipped feature.

---

## 23. Templates and `lando create`

### 23.1 What templates are

A template is a directory with a `template.yml` manifest, a file tree, and optional scripts. It is a different artifact from a recipe:

| | Recipe (§8.8) | Template |
|---|---|---|
| Produces | A Landofile and the support files it mounts | Project files, Lando configuration, and the effects of its steps |
| Answers | Persisted in `recipe.options` and read on every load | Used once; nothing about the template is stored in the project |
| Runs code | Never | Steps, in containers only |
| Applied by | `apps:init`, provider-free | `apps:create`, which needs a runtime only when a step does |

A template MAY wrap a recipe for its Lando part (§23.9), and MAY have no Lando part at all. `apps:init` remains the way to add Lando to code that already exists without running anything.

Rules that hold for every template, whatever its source:

- Nothing a template ships executes on the host. Scripts and commands run in containers (§23.8). Host effects happen only through Lando's own commands (§23.7) and through plugin code the user has trusted (§23.14).
- Lando never overwrites a file that existed before the run (§23.6).
- Every question is answerable without a terminal (§23.5), and the plan is computable without running anything (§23.12).
- A failed step is undone, and the run can be resumed or rolled back whole (§23.12).

The private `@lando/scaffold` package owns the pure parts shared by recipes and templates: manifest compilation, question resolution, file planning, and rendering plans. `@lando/sdk` owns the published schemas, errors, and events. The engine owns the operation that runs a plan. Core owns the CLI. Recipe code moves out of core into that package; core keeps no second copy.

### 23.2 Commands

| Canonical id | Alias | Contract |
|---|---|---|
| `apps:create` | `create` | Apply a template: `[<template>] [<destination>]` |
| `meta:templates:list` | `templates`, `templates:list` | List bundled, plugin, and reviewed-index templates; JSON is the canonical machine form |
| `meta:templates:describe` | `templates:describe` | Print a template's questions, values, steps, environments, requirements, and consent items without running anything |
| `meta:templates:validate` | `templates:validate` | Resolve, compile, and plan a template read-only and report issues |
| `meta:templates:trust` | `templates:trust` | List and revoke stored template consents (§23.11) |

`apps:create` creates a new project by default. `--add` applies the template to the project that contains the current directory: the nearest ancestor holding a Landofile, else the current directory. In `--add` mode `<destination>` is a path inside that project.

`apps:create` flags: `--add`, `--name`, repeated `--answer key=value`, `--answers <file>`, one flag per question (§23.5), `--yes`/`-y`, `--trust`, `--no-interactive`, `--interactive`, `--describe`, `--dry-run`, `--no-start`, `--abort`, `--keep-failed`, `--checksum`, and `--index-url`.

- With no `<template>`, an interactive invocation presents a picker over `meta:templates:list`. A non-interactive invocation fails with `InteractionRequiredError` naming `lando templates`.
- `--describe` prints the `meta:templates:describe` result for the resolved template and exits. `--dry-run` resolves answers and prints the plan (§23.12) and writes nothing.
- `--no-start` skips every step from the first `app:start` command step onward and reports them as skipped.
- `init` and `create` are reserved tooling names (§8.1.2). There is no `add` command.
- `apps:create` declares bootstrap `plugins`. Resolution, questions, planning, and consent MUST NOT contact a provider. Execution builds the scratch or app tier only when the plan contains a step that needs one, so a files-only template works before `lando setup`. A plan that needs a runtime MUST verify one is available before anything is written.

### 23.3 Sources and locators

One locator grammar, `SourceLocator`, names every remote or local source: `apps:create <template>`, `apps:init --recipe`, `apps:scratch:start --from`, `extends:` in recipes and templates, and template references inside a manifest. There are no per-scheme flags.

| Form | Resolution |
|---|---|
| bare id (`[a-z0-9][a-z0-9-]*`) | Bundled, then installed plugins, then the reviewed index, in that order |
| `./`, `../`, `/`, `~/`, or an absolute path | Local directory |
| `owner/name[/subdir][@ref]` | Shorthand for the `github:` form |
| `github:owner/repo[/subdir][@ref]` | Git source on GitHub |
| git URL (`https://`, `git+https://`, `ssh://`, `git@host:`) with optional `@ref` and `#subdir` | Git source |
| `npm:name[@version][#subdir]` | npm package |
| `archive:<https-url>[#subdir]` | Archive; `--checksum` is the expected SHA-256 |
| `plugin:<plugin>/<id>` | Template or recipe contributed by that plugin (§23.14) |
| `index:<name>` | Reviewed-index entry, never a fallback |

Acquisition goes through the source store (§12.8) with its integrity rules. A git `@ref` is a tag, branch, or full commit. A reference from one remote source to another (`extends`, `requires`, a `template` step) MUST pin a full commit or an exact npm version; an unpinned nested reference fails compilation.

A bundled id shadows a plugin id, and a plugin id shadows an index name; the shadowed claim is reported as a diagnostic, never silently dropped. When a locator resolves to a recipe directory and the command is `apps:create`, Lando applies the implicit template whose only content is that recipe as its Lando part.

**Reviewed index.** `SourceIndex` is one JSON document maintained in a public Lando repository, where a merged pull request is the review, and published as a static file at `DEFAULT_SOURCE_INDEX_URL`. An entry carries `name`, `kind` (`template` or `recipe`), `summary`, a pinned locator (full commit or exact npm version with integrity), and the runnable digest (§23.11). Lando fetches it through `HttpClient`, caches it (`source-index`, §12.1), and uses the cache when offline. `--index-url` and global `sources.indexUrl` override the address. Acquired content that does not match the entry's pin or digest fails with `TemplateSourceError` kind `index-mismatch`. An index entry is not consent. Unreviewed templates are reached by their full locator; the index is not a publishing service.

Bundled templates are authored under `templates/<id>/`, compiled at codegen into an embedded catalog (§17.2), and ship a `README.mdx` under §19.13. The bundled `drupal` and `drupal-cms` templates MUST generate a project whose `composer.json` sets `config.allow-plugins` entries `dealerdirect/phpcodesniffer-composer-installer` and `phpstan/extension-installer` to `true` before dependencies install, preserving other entries, requires `drupal/coder`, `phpstan/phpstan`, `mglaman/phpstan-drupal`, and `phpstan/extension-installer` as dev dependencies, and writes the default `phpcs.xml.dist` and `phpstan.neon.dist` that §8.8.10 describes, so the recipes' `phpcs`, `phpcbf`, and `phpstan` tasks work on the generated project and agree with CI and editors. `drupal` inherits the plugin approvals from `drupal/recommended-project`. Recipes and tasks MUST NOT change plugin trust in an existing checkout.

### 23.4 The manifest

`TemplateSource` is the only accepted author format, published from `@lando/sdk/schema` and as JSON Schema. `template.yml` decodes to it strictly; unknown keys fail with `TemplateManifestError`. Remote templates are YAML only. There is no programmatic template form.

| Key | Contract |
|---|---|
| `id`, `title`, `description`, `version` | Identity and required semver |
| `authors`, `tags`, `deprecated` | Catalog and evolution metadata |
| `target` | `new` (default), `existing`, or `either`: the modes the template supports |
| `requires` | `lando` version range, `plugins`, and `templates` (§23.10) |
| `conflicts`, `checks`, `detect` | Relationships to other templates and to the project (§23.10) |
| `extends` | Single template parent (§23.10) |
| `questions` | Ordered question list (§23.5) |
| `values` | Named values computed from answers by expression; never asked |
| `environments` | Named step environments (§23.8) |
| `rules`, `merges` | File rendering rules and declared merges (§23.6) |
| `lando` | The Lando part: `recipe` and `fragment` (§23.9) |
| `steps` | Ordered step list (§23.7) |

A template directory holds `template.yml` at its root and the project tree under `files/`. Everything else in the directory (scripts, partials, docs, tests) stays in the template and is never copied. One repository MAY hold many templates in subdirectories.

Compilation is pure: `compileTemplateSource` has no filesystem, process, provider, or network access, and core compilation observes script and file bytes to derive digests. Manifest expressions use the §7.3.1 language over these scopes only: `answers`, `values`, `instance`, `mode` (`new` or `add`), `destination` (`name`, `path`), `template` (`id`, `version`), `host` (`os`, `arch`), and `project`. `project` is a read-only view of the destination: `project.landofile` is the merged authoring view of an existing Landofile, and the file helpers `fs.exists`, `fs.isFile`, `fs.isDir`, `glob`, `load`, and `text` resolve inside the destination under the §7.3 containment and size bounds. `env`, `secrets`, and every planner or provider scope are unavailable. A template never reads the host environment.

### 23.5 Questions and answers

`questions` is an ordered list. Each entry has `name`, `type` (the eight §8.8.5 prompt types), `message`, and optional `default`, `validate`, `choices`, `choicesFrom`, `when`, and `flag`.

- `when` is an expression over earlier answers, values, and `project`. A question whose `when` is false is not asked and takes its default, or has no value. An answer supplied for it is ignored and reported as the warning `LANDO_TEMPLATE_ANSWER_IGNORED`.
- `default` MAY be an expression over earlier answers and `project`.
- `choices` is a static list. `choicesFrom` is an expression that yields a list, or `{ source, args }` naming a plugin choice source (§23.14). A question cannot run a command to obtain choices; this also holds for recipes (§8.10).
- A `secret` question declares no default. Its answer reaches steps as a named `secretEnv` entry or `stdin`, and files marked `secret: true` (§23.6). It MUST NOT enter the plan, the result, events, transcripts, telemetry, the journal, or Lando configuration.
- Options of a wrapped recipe that the template's `lando.recipe.options` does not map become questions with the recipe's types and defaults. A name collision with a template question is a `TemplateManifestError`.

Answer sources follow §8.10.3: explicit answers, then defaults under `--yes` or non-interactive mode, then prompts, then `InteractionRequiredError`. Explicit answers come from `--answer`, `--answers`, and per-question flags. Each root-template question is also a flag named for it (`--<name>`, or its `flag`); booleans accept `--name` and `--name=false`, and array answers accept a comma list or repetition. A question named like a dispatcher flag or an `apps:create` flag gets no flag and is answerable through `--answer` only; this is never an error. Questions of a nested template are addressed as `<step-id>.<name>` through `--answer` and `--answers`. `meta:templates:describe` reports every question's name, type, default, condition, flag, and address, so an agent can read them and supply every answer in one command.

### 23.6 Files, rendering, and merges

A `files` step (§23.7) writes a file set: a directory in the template, `files/` by default.

**Which files render.** A file is rendered only when its name ends in a template suffix. `.tmpl` selects the `lando` engine; other suffixes select the engine registered for them (§7.3.2). The suffix is dropped from the output name. Every other file is copied byte for byte. A `rules` entry `{ match, render }` overrides this for the paths its glob matches: `render: false` copies a suffixed file verbatim and keeps its name, and `render: <engine>` renders a file that has no template suffix. Rendering receives `TemplateRenderContext.vars` holding the manifest scopes of §23.4, without secrets unless the file is marked `secret: true`. A missing variable is an error.

**Paths.** A path segment MAY contain `{{ }}` expressions. A segment that renders empty removes that file or subtree, which is how a file is made conditional by name. `rules` entries MAY also carry `when`, `mode`, `replace`, and `secret`. Symlinks in a template tree are rejected. Every output path MUST stay inside the destination after traversal and symlink resolution.

**Never overwrite.** A path that existed before the run is a conflict, and the step fails with `TemplateConflictError` and is rolled back. A path created earlier in the same run MAY be replaced only by a file whose rule sets `replace: true`; an unmarked collision is a conflict. The run journal records which paths the run created.

**Refused outputs.** A file set MUST NOT write a Landofile basename, a `.lando/scripts/` path, or anything under `.git/`. These fail with `TemplatePolicyError` at planning.

**Merges.** `merges` declares additions to files that may already exist: `{ path, format, set }` for `json`, `yaml`, and `env`, and `{ path, format: text, block }` for a fenced managed block (§10.13) marked with the template and instance. A structured merge adds keys and appends array items that are not present. A merge that would change an existing value is a conflict. YAML merges preserve comments and formatting through source-offset splices (§8.2.1). A merge target that does not exist is created.

**Secret files.** A file or merge marked `secret: true` MAY render secret answers. Lando writes it owner-only and refuses it with `TemplatePolicyError` when the path is not git-ignored in the destination.

Recipe support files use the same renderer (§8.8.2).

### 23.7 Steps

`steps` is an ordered list. Every step has an optional `id`, `when`, and `group`, and exactly one kind key.

| Kind | Contract |
|---|---|
| `files` | Write a file set and the merges assigned to it (§23.6) |
| `lando` | Write the Lando part (§23.9) |
| `run` | Run a command or a template script in a named step environment (§23.8) |
| `exec` | Run a command in a service of the started app |
| `task` | Run one of the app's tooling tasks with named `flags` and `args` |
| `command` | Invoke a canonical Lando command from the template-step allowlist |
| `template` | Apply another template (§23.10) |
| `gitInit` | Create a repository in the destination |
| `message` | Emit expression text and record it in the result |
| `uses` | Run a plugin step kind (§23.14) |

- A template MAY have several `files` steps, each naming its own directory, so files can be written before and after a generator. When the list has no `files` step and the template has a `files/` directory, one is prepended.
- When the template has a Lando part and no `lando` step, one is inserted before the first `command`, `exec`, or `task` step, else appended before trailing `message` steps.
- An `exec` or `task` step MUST be preceded by an `app:start` command step; a manifest that violates this fails compilation. A `task` step MUST NOT name a task that targets the host.
- The `command` allowlist is generated from `templateStepAllowed` command metadata (§8.3). The built-in members are `app:start`, `app:stop`, `app:restart`, `app:rebuild`, `app:open`, `app:pull`, `app:agent:skills:install`, and `app:destroy`. Plugin commands opt in through their descriptor (§23.14). Flags and args are explicit; outer input is never forwarded. Plugin installation, setup, global configuration, and `meta:*` commands are never allowed.
- `gitInit` creates the repository through Lando's bundled git implementation (§12.8), with no container and no host git. It sets the default branch and makes no commit. It is skipped, and reported as skipped, when the destination is already inside a repository.
- `message` text MUST NOT contain secrets.

A step that wants the terminal declares `interactive: true` together with `fallback`: `fail`, or an alternate command built from answers. Without a terminal (non-interactive mode, machine output, or MCP) `fail` is refused before anything is written, and an alternate command runs in its place. Steps get no terminal and closed stdin by default, so passing answers as flags to an upstream generator is the normal form.

### 23.8 Step environments and execution

`run`, `exec`, `task`, and `command` steps execute through one execution session (§22) that `apps:create` opens for the run. The session policy sets `workspaceRoot` to the destination, admits the destination and the acquired template tree as source and mount roots, denies `host-argv` and `host-shell` for every template, and resolves only the secrets the plan binds. Template execution adds no second runner.

**Step environments.** `environments` maps a name to a closed description: `type` (a Lando service type and version, such as `php:8.3` or `node:22`), optional `packages`, optional literal `environment` values, and optional `sshAgent: true`. Any other key is a `TemplateManifestError`. Lando compiles each description into a configuration-backed scratch environment (§21.4.3) owned by the session. An environment starts on first use, is shared by the steps that name it, and is destroyed when the run ends.

Inside a `run` step:

- The destination is mounted read-write at the working directory. In `--add` mode the project's `.git` directory is read-only. Nothing else from the host is mounted.
- The template directory is mounted read-only, and `script:` names a file in it. Lando provisions Bun in every step environment, so `.bun.sh` and TypeScript scripts run everywhere; a script MAY use any other interpreter its environment provides.
- Answers and values arrive as `LANDO_ANSWER_<SUFFIX>` variables and one `LANDO_INPUT` JSON value, using the §8.5.9 suffix and encoding rules. Secrets arrive only as bound.
- No SSH or GPG agent socket and no host `known_hosts` are delivered unless the environment declares `sshAgent: true` (§23.11).
- The process runs as the project user (§6.2.3), so files it writes belong to the invoking host user on every provider.
- The network is available. Per-template network rules are not part of this contract.
- A script cannot invoke Lando, apart from the existing host-proxy allowlist (§10.10). Lifecycle work is a `command` step.

`exec` and `task` steps run in the started app under that app's own configuration.

### 23.9 Lando configuration

The `lando` manifest key has two members, both optional.

- `recipe`: a locator or an inline `RecipeSource`, plus `options` mapping recipe option names to expressions. In a new project it produces the root Landofile through the same preparation and publication as `apps:init` (§8.8.7), so recipe provenance, `app:config:explain`, and `app:config:migrate` work unchanged. `--name`, else the destination basename, is the app name.
- `fragment`: a Landofile fragment (§7.7.2). Lando writes it to `.lando/<instance>.yml` (§23.10) and adds one `includes:` entry to the root Landofile through the comment-preserving editor (§8.2.1).

A fragment cannot carry recipe options, so template values are written into it as plain values. An expression in a fragment that reads only template scopes is evaluated when the template is applied. An expression that reads none of the template scopes is written unchanged and follows the ordinary Landofile load and planning rules, including §7.3.1 deferral. One expression MUST NOT mix the two; that is a `TemplateManifestError`.

Rules:

- The layout is the same whenever a template is applied. A root Landofile comes from a recipe or from a generator; every template's own contribution is a fragment file. Nothing is merged into the root except the include line.
- In a new project with a `fragment` and no `recipe`, and in `--add` mode on a project with no Landofile, Lando writes a minimal root holding `name`, `runtime`, and the include.
- When a root Landofile already exists as the `lando` step runs in a new project, because a generator produced one, the template's `recipe` is skipped and reported, and its `fragment` is still applied.
- When the root Landofile is TypeScript or uses a template directive, Lando writes the fragment, prints the include line for the user to add, reports `included: false`, and skips the steps that need the app.
- The Lando part MUST NOT contain host code as defined by §7.9: `:host` execution sites, `.lando/scripts` files, or a TypeScript layer. This holds for every source and fails with `TemplatePolicyError` at planning. A template that needs host work depends on a plugin (§23.14).
- The Lando part MAY contain host exposure as defined by §7.9, such as a mount outside the project. Each such item is listed in the consent prompt, requires trust (§23.11), and is recorded as approved for the project when the user consents.
- Configuration that a step produced is not template-authored. Before `apps:create` starts an app, §7.9 applies to the whole project: an interactive run asks, and a non-interactive run without `--trust` stops before the start and names the command that approves and starts it.

### 23.10 Composition

**Inheritance.** `extends` names one parent template. Questions, values, environments, rules, and merges replace by name or path, and `{ drop: true }` removes an inherited entry. Steps replace by `id`; a child step MAY set `before` or `after` to position itself against a parent step id, and a parent step without an `id` cannot be replaced or targeted. Depth is bounded at three. A missing parent, a cycle, or an escape from the acquisition root fails with `TemplateManifestError`.

**Applying another template.** A `template` step names a locator, maps its questions through `answers`, and MAY set `path` and `instance`. The nested template's unmapped questions are asked under the step's id. Its steps run inside the parent's run, journal, and rollback.

**Relationships.** With no project record, a template describes its own presence:

- `detect` is an expression over `project` that is true when the template has already been applied.
- `requires.templates` lists templates that must be present. Each is skipped when its `detect` is true, and otherwise applied first in the same run.
- `conflicts` lists templates that must be absent, judged by their `detect` and by the templates selected in the same run.
- `checks` is a list of `{ assert, message }` over `project` and answers. A false assertion stops the run with `TemplateRequirementError` and its message before anything is written.

**Instances.** A template applied with `--add`, or through a `template` step, has an instance name: `--name` or the step's `instance`, else a question whose default is the destination basename. The name is the fragment file name and is available to expressions as `instance`, so one template can be applied to a project more than once. A name already in use is a `TemplateConflictError` before anything is written.

**Modes.** `target` is checked against the invocation. A new project requires a destination that is missing or empty. `--add` requires `existing` or `either`. A mismatch fails with `TemplateTargetError` naming the flag that selects the other mode.

**Requirements.** `requires.lando` is checked first. For each missing `requires.plugins` entry, an interactive run shows the plugin trust prompt (§9.6), installs, and continues; a non-interactive run stops with `TemplateRequirementError` and the exact install command.

### 23.11 Consent

A template from a source the user has not vouched for needs consent before any step runs.

- **Exempt sources.** Bundled templates, local paths, and templates contributed by a plugin in the `PluginTrustStore` need none.
- **What consent covers.** The runnable digest is a SHA-256 over the canonical compiled manifest, the bytes of every script a step names, the environment descriptions, the Lando part, and the runnable digests of every template it extends, requires, or applies. The file tree is not part of it, so a change to what executes asks again and a README change does not.
- **The prompt.** It shows the source identity (locator and resolved commit or version), each step with its kind and command or script, each environment's service type, each Lando command, and each trust reason. The default is no. Accepting stores a `TemplateConsent` for that source identity and digest.

Trust reasons mark what reaches past a throwaway container holding a new directory:

| Reason | When |
|---|---|
| `existing-project` | `--add`, or a destination that already holds files |
| `app-step` | An `exec` or `task` step, which runs with the app's configuration, including its default agent |
| `ssh-agent` | An environment that declares `sshAgent: true` |
| `plugin-code` | A `uses` step or a plugin command step |
| `privileged-command` | `app:destroy` or `app:pull` |
| `host-exposure` | Host exposure in the Lando part (§23.9) |

Without a terminal, `--yes` is consent for a plan with no trust reasons. A plan with any trust reason requires `--trust`, or a stored consent; otherwise it fails with `TemplateConsentRequiredError` listing the reasons before anything is written. `--trust` stores the consent exactly as an accepted prompt does. Over MCP the equivalent inputs are `yes` and `trust`, and an accepted elicitation MAY stand in for `trust` (§10.14). Consents live in Lando's user configuration, never in the project, and `meta:templates:trust` lists and revokes them.

### 23.12 Run lifecycle

`apps:create` runs these phases in order. Phases one through seven are read-only and provider-free.

1. Resolve the locator and acquire the source in one source session.
2. Compile the manifest with its parent and required templates.
3. Check `requires`.
4. Resolve the mode, destination, and instance; take the run lock; detect an unfinished run.
5. Resolve answers and values.
6. Build the `TemplatePlan`: the resolved step list, file inventory with digests, merges, the Lando part preview, environments, and consent items. `--dry-run` and `--describe` stop here. Output that only an upstream generator can produce is reported as unknown.
7. Evaluate `detect`, `conflicts`, and `checks`, validate policy, and report statically known conflicts.
8. Obtain consent.
9. Verify the runtime when a step needs one.
10. Execute the steps.
11. Remove the journal and snapshot, release the lock, and return the result.

**Snapshots.** Steps work on the real destination. Before the first step and before each later step, Lando records a checkpoint of the destination in a private repository outside the project, using the bundled git implementation with the destination as its work tree. It MUST NOT read or write the project's own `.git`, index, or configuration, and it does not require the project to use git or to be clean. A checkpoint holds the files the project's ignore rules do not exclude, plus any ignored file Lando itself writes or merges into, stored privately with its mode. The journal records file modes and empty directories, which the repository does not. Nested repositories and ignored paths that steps change, such as dependency folders, are not captured; a rollback names them in `notRestored`.

**Failure.** When a step fails or the run is interrupted, Lando restores the destination to the checkpoint before that step, records the run as failed, and stops. Steps that share a `group` are undone together. `--keep-failed` leaves the failed state in place for inspection.

**Resume.** Running the same command again, with the same template digest, destination, and answers, continues at the failed step. Different inputs fail with `TemplateRunStateError` naming `--abort`.

**Rollback.** `--abort` rolls the whole unfinished run back to its first checkpoint. For a new project it also destroys the app and volumes the run created and removes a destination directory the run created. For an existing project it restores files only, states that service data is not undone, and names the command that rebuilds the app from the restored configuration.

One run at a time is allowed per destination, serialized by the app mutation lock on its canonical path. Snapshots exist only while a run is unfinished. After success, undoing a template is the user's own version control.

### 23.13 Results, events, and machine use

`CreateResult` reports the template identity and source kind, mode, destination, instance, app name, nonsecret answers, files created, replaced, and merged, the Lando root and fragments with their `included` state, each step's `id`, `kind`, and status (`completed`, `skipped`, `failed`, or `rolled-back`) with an exit code where one was observed, whether the app started and its URLs, messages, how consent was satisfied, and `notRestored`. It never contains secrets or file contents.

The Template lifecycle scope (§3.5) publishes `pre-template-acquire`, `post-template-acquire`, `pre-template-run`, `post-template-run`, `template-step-start`, `template-step-complete`, `template-step-fail`, `template-step-rollback`, `pre-template-rollback`, and `post-template-rollback`. Step output streams through the unified sink with canonical redaction (§3.7, §8.2), on stderr in human formats.

`apps:create` and the read-only `meta:templates:list`, `describe`, and `validate` are in the generated MCP allowlist (§10.14). An MCP call supplies the template, destination, `add`, an `answers` map, `yes`, and `trust`; there is never a terminal, so an interactive step takes its fallback.

Telemetry records the source kind (bundled, local, git, npm, archive, plugin, or index), the step kinds that ran, and the outcome. A template id is recorded only for bundled templates. Locators, paths, and answers are never sent.

### 23.14 Plugin extension points

| Manifest key | Contract |
|---|---|
| `provides.templates` | Template directories shipped as data: `{ id, path, summary }`. No plugin code runs to produce them. |
| `provides.recipes` | Recipe directories shipped as data under the same rule. This is a source of inert `RecipeSource` trees, not the removed `RecipeDefinition` runtime contribution (§8.8). |
| `provides.templateSteps` | Step kinds: `{ id, module, summary }` implementing `TemplateStepKind` with an input schema, a pure `plan` that returns the consent description, and `run`. |
| `provides.templateChoices` | Choice sources: `{ id, module, summary }` returning bounded choices for a question. |
| command `templateStepAllowed` | A plugin command descriptor MAY opt in to being called from a `command` step. |

Plugin step kinds and commands run as trusted host code, which is the only way a template causes host work. Every implementation MUST pass the template-step contract suite (§13.1). A step kind MUST report what it will do through `plan`, and MUST NOT run anything in `plan`.

### 23.15 Persistence

| Name | Location | Contract |
|---|---|---|
| `template-consents` | `<userConfRoot>/template-consents.json` | `StateStore` bucket of `TemplateConsent` records keyed by source identity and runnable digest |
| `template-run` | `<userDataRoot>/template-runs/<destination-key>/journal.json` | Owner-only `StateStore` bucket: plan digest, answer digest, step states, created paths, modes, and checkpoints, with a declared lifecycle (`planned`, `running`, `failed`, `completed`, `aborted`); removed on completion or abort |
| run snapshot | `<userDataRoot>/template-runs/<destination-key>/snapshot.git/` | Private checkpoint repository; removed with its journal |
| `source-index` | `<userCacheRoot>/source-index.json` | Cached reviewed index with its fetch time |

`<destination-key>` is `appIdentityKey("owner", <canonical destination>)`. Journals and consents carry digests, paths, and modes, never file bytes or secrets. An unfinished run found by `lando doctor` is reported with the commands that resume or abort it.

### 23.16 Errors

| `_tag` | Boundary |
|---|---|
| `TemplateSourceError` | Locator invalid, source acquisition failed, nested reference unpinned, or `index-mismatch`; `kind` names the cause |
| `TemplateManifestError` | Manifest missing, unparseable, or invalid, including inheritance and step-order violations; carries `issues` |
| `TemplateRequirementError` | `requires`, `conflicts`, or `checks` not satisfied |
| `TemplateTargetError` | Destination or mode does not match `target` |
| `TemplatePolicyError` | Host code in the Lando part, a refused output path, or an unsafe secret file |
| `TemplateConsentRequiredError` | Consent or trust missing; carries the trust reasons |
| `TemplateConflictError` | A path, merge value, or instance name already exists |
| `TemplateStepError` | A step failed; carries step `id`, `kind`, observed exit code, and `rolledBack` |
| `TemplateRunStateError` | An unfinished run blocks this invocation, or the run lock is held |

Interaction (§8.10), source-store (§12.8), recipe (§8.8), execution (§22.11), provider (§5.7), and host-approval (§7.9) errors pass through unchanged. Cancellation is Effect interruption and follows the failure rule in §23.12.

### 23.17 Non-goals

- Template updates. A project does not record the template it came from, and there is no command that re-applies a newer version.
- Host execution by a template, under any consent.
- Rendering every file. Only suffixed or ruled files render.
- A staging tree or overlay. Steps work in place and snapshots provide the undo.
- Undoing service data in an existing project.
- Multiple inheritance, and a programmatic `template.ts`.
- Per-template network rules.

### 23.18 Acceptance

Conformance is proved by the template contract suite in §13.1 and by executable guides for bundled templates (§19.13). The suite MUST cover: a files-only template without a runtime; conditional questions answered entirely by flags; suffix rendering beside verbatim files that contain `{{ }}`; a generator that needs an empty directory followed by a marked replacement; `--add` with a fragment, an include edit that preserves comments, and a second instance; a failed step rolled back and resumed; `--abort` in both modes; consent stored, reused, and invalidated by a script change; every trust reason refused under `--yes` alone; and refusal of host code in a Lando part.

---
