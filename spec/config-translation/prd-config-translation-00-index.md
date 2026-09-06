# Config translation implementation order

Priorities are global across the three coordinated PRDs. A dependency must have a lower priority. Story ids may use an alphanumeric suffix after the numeric family.

Run `bun run spec/config-translation/check-coordinated-plan.mjs --initial` before execution. During implementation, omit `--initial` to validate progress: a completed story requires completed prerequisites. The three queues are one graph, not independently runnable branches.

Recipe rollout is one staged cutover, not a dual shipping path. US-609E0 builds the private replacement pipeline against an isolated test recipe. US-609E1 through US-609E6 implement and test grouped replacements while the existing CLI still uses the existing registry. Their instruction to replace a renderer means preparing its replacement, not removing the still-bound entry early. US-609E switches the single registry once, deletes obsolete render bindings and the expander, and publishes the prepared user examples. No runtime flag or fallback selects old versus new behavior. Every intermediate story keeps existing public guides green. README.mdx files in the recipe criteria are authored source; scaffold README outputs are generated from them, never hand-edited.

## Standard gates

| Class | Required gates |
|---|---|
| spec | prose/reference scan; `bun run check:boundaries` |
| sdk | focused contracts with positive counts; SDK compatibility; schema snapshots; typecheck; tests; lint; codegen check; boundaries |
| core | focused unit/contract tests with positive counts; typecheck; tests; lint; codegen check; boundaries |
| transaction | focused failure-injection and recovery tests with positive counts; typecheck; tests; lint; boundaries |
| recipe | focused default/nondefault/auxiliary/provider-free tests with positive counts; executable README; guide drift; public transcripts; typecheck; tests; lint; codegen check; boundaries |
| user | focused CLI/library tests with positive counts; executable guide; guide coverage/drift; public transcripts; typecheck; tests; lint; codegen check; boundaries |
| aggregate | every named child gate with positive counts plus typecheck; tests; lint; codegen check; boundaries |

## Stories

| Priority | Story | Scope | Class | Depends on |
|---:|---|---|---|---|
| 1 | US-607 | durable contract | spec | none |
| 2 | US-608A | authoring and set translation schemas | sdk | US-607 |
| 3 | US-608B | translator registration | core | US-608A |
| 4 | US-608C | transaction coordinator | transaction | US-607 |
| 5 | US-608D | transaction recovery guard | transaction | US-608C |
| 6 | US-609A | expression-aware v4 codec | sdk | US-608A |
| 7 | US-609B | recipe provenance and migration contracts | sdk | US-608A, US-609A |
| 8 | US-609C | core conversion orchestration | user | US-608B, US-608D, US-609A |
| 9 | US-609E0 | private init integration | core | US-608D, US-609B, US-609C |
| 10 | US-609E1 | lamp, lemp, wordpress, laravel, symfony | recipe | US-609E0 |
| 11 | US-609E2 | drupal, drupal-cms, backdrop, joomla | recipe | US-609E0 |
| 12 | US-609E3 | node-postgres, node-api, mean, node-ts | recipe | US-609E0 |
| 13 | US-609E4 | astro, sveltekit, nextjs | recipe | US-609E0 |
| 14 | US-609E5 | django, fastapi, rails | recipe | US-609E0 |
| 15 | US-609E6 | jekyll, hugo, eleventy, empty, toolbox | recipe | US-609E0 |
| 16 | US-609E | recipe milestone verification | aggregate | US-609E1, US-609E2, US-609E3, US-609E4, US-609E5, US-609E6 |
| 17 | US-610 | explain | user | US-609B, US-609E |
| 18 | US-611B | migration analysis and commit | user | US-608D, US-609B, US-610 |
