# Beta Feature Coverage Matrix

This matrix maps each user-facing Beta PRD feature to the executable guide(s) that
exercise it. It is the union of every PRD's `## Guide Coverage` section. Internal/infra
PRDs (09, 13) declare no guides and are intentionally absent.

`Status` is `Shipped` when the guide file exists on disk and `Planned` when the owning
story has not yet landed its guide. `bun run check:guide-coverage` validates that every
guide path declared in a PRD's `## Guide Coverage` section appears below and that every
`Shipped` row references a real `docs/guides/<path>.mdx` file.

| PRD | User Story | Feature | Guide Path | Status |
|---|---|---|---|---|
| PRD-01 | US-074 | provider-lando Windows VM lifecycle | `docs/guides/setup/provider-lando-windows.mdx` | Shipped |
| PRD-01 | US-077 | provider-docker on Windows (Docker Desktop) | `docs/guides/setup/provider-docker-windows.mdx` | Shipped |
| PRD-01 | US-078 | @lando/provider-podman opt-in on Linux | `docs/guides/setup/provider-podman-linux.mdx` | Shipped |
| PRD-01 | US-082 | provider selection precedence + conflict diagnostics | `docs/guides/setup/provider-selection.mdx` | Shipped |
| PRD-02 | US-084 | mongodb service type | `docs/guides/services/mongodb.mdx` | Shipped |
| PRD-02 | US-086 | valkey service type (dual-scheme emission) | `docs/guides/services/valkey.mdx` | Shipped |
| PRD-02 | US-088 | elasticsearch service type | `docs/guides/services/elasticsearch.mdx` | Shipped |
| PRD-02 | US-093 | static service type | `docs/guides/services/static.mdx` | Shipped |
| PRD-02 | US-094 | raw Compose passthrough service | `docs/guides/services/compose-passthrough.mdx` | Shipped |
| PRD-03 | US-097 | Mutagen host CLI + agent download via `lando setup` | `docs/guides/setup/file-sync-mutagen.mdx` | Shipped |
| PRD-03 | US-099 | exclude patterns (volume-shadow + Mutagen ignores) | `docs/guides/setup/file-sync-excludes.mdx` | Shipped |
| PRD-04 | US-101 | ProxyService + Traefik via global app | `docs/guides/subsystems/proxy-traefik.mdx` | Shipped |
| PRD-04 | US-102 | CertificateAuthority via @lando/ca-mkcert | `docs/guides/subsystems/certificates-mkcert.mdx` | Shipped |
| PRD-04 | US-103 | SshService sidecar (default) | `docs/guides/subsystems/ssh-sidecar.mdx` | Shipped |
| PRD-04 | US-108 | `lando doctor` subsystem walkthrough | `docs/guides/subsystems/doctor-walkthrough.mdx` | Shipped |
| PRD-05 | US-111 | GlobalAppService + reserved id `global` | `docs/guides/global/install-and-bundled-services.mdx` | Shipped |
| PRD-05 | US-116 | `meta:global:*` CLI namespace incl. uninstall | `docs/guides/global/uninstall-and-purge.mdx` | Shipped |
| PRD-05 | US-119 | global-app integration with `lando doctor` | `docs/guides/global/doctor-walkthrough.mdx` | Shipped |
| PRD-06 | US-122 | fork mode (`apps:scratch:start --fork=<app>`) | `docs/guides/scratch/fork-existing-app.mdx` | Shipped |
| PRD-06 | US-123 | scratch mode (`apps:scratch:start --recipe=<id>`) | `docs/guides/scratch/scratch-from-recipe.mdx` | Planned |
| PRD-06 | US-126 | scratch registry garbage collection (`apps:scratch:gc`) | `docs/guides/scratch/scratch-gc.mdx` | Shipped |
| PRD-06 | US-127 | `--mount-cwd` + `--share-global-storage` flags | `docs/guides/scratch/mount-and-share-flags.mdx` | Shipped |
| PRD-06 | US-128 | `apps:scratch:list` + `apps:scratch:info` | `docs/guides/scratch/list-and-info.mdx` | Shipped |
| PRD-07 | US-129 | remote recipe sources (git, tarball, npm, registry) | `docs/guides/recipes/remote-sources.mdx` | Shipped |
| PRD-07 | US-134 | `runs:` allowlist + ctx.run | `docs/guides/recipes/authoring-runs-allowlist.mdx` | Shipped |
| PRD-07 | US-135 | `fetchAllowlist:` + ctx.fetch | `docs/guides/recipes/authoring-fetch-allowlist.mdx` | Shipped |
| PRD-07 | US-136 | programmatic recipe.ts | `docs/guides/recipes/programmatic-recipe.mdx` | Shipped |
| PRD-08 | US-139 | `includes:` + .lando.lock.yml | `docs/guides/landofile/includes-and-lockfile.mdx` | Shipped |
| PRD-08 | US-142 | configuration expressions (parser + evaluator) | `docs/guides/landofile/expressions.mdx` | Planned |
| PRD-08 | US-144 | bundled template engines — Handlebars + Mustache | `docs/guides/landofile/template-engines.mdx` | Shipped |
| PRD-08 | US-145 | env overrides | `docs/guides/landofile/env-overrides.mdx` | Shipped |
| PRD-08 | US-148 | `app:config:translate` command | `docs/guides/landofile/config-translate.mdx` | Shipped |
| PRD-08 | US-195 | `app:config:lint` command (IDE / standalone) | `docs/guides/landofile/config-lint.mdx` | Shipped |
| PRD-10 | US-159 | tooling bootstrap level + cache-only app-plan read | `docs/guides/tooling/composer-php.mdx` | Shipped |
| PRD-10 | US-163 | service-mode `lando shell` | `docs/guides/tooling/lando-shell.mdx` | Planned |
| PRD-10 | US-164 | tooling output via renderer task tree | `docs/guides/tooling/output-streaming.mdx` | Planned |
| PRD-11 | US-165 | `meta:plugin:add` against npm | `docs/guides/plugins/install-from-npm.mdx` | Planned |
| PRD-11 | US-167 | postinstall trust gating (incl. wildcards) | `docs/guides/plugins/trust-and-wildcards.mdx` | Planned |
| PRD-11 | US-168 | system / user / app plugin discovery scopes | `docs/guides/plugins/discovery-scopes.mdx` | Planned |
| PRD-11 | US-173 | library-mode defaults | `docs/guides/library/embedding-defaults.mdx` | Planned |
