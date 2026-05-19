# node-ts

Programmatic Landofile demonstration recipe. Emits a `.lando.ts`
(not `.lando.yml`) so an advanced recipe author can adapt the
Landofile at parse time using `process.env` and other documented
`LandofileContext` inputs (see spec §7.1.1).

The default Lando v4 recipe shape is YAML; ship YAML unless your
recipe needs the programmatic form. This recipe exists primarily as
a working reference for the `.lando.ts` path.

## Generated services

- `web` — `image: node:<LANDO_NODE_VERSION ?? "lts">`

The Node major version is resolved from `LANDO_NODE_VERSION` at
`LandofileService` load time, with `lts` as the default. `NODE_ENV`
defaults to `development` and can be overridden the same way.

## Alpha limitations

- No tooling/proxy/storage scaffolding — only the bare programmatic
  Landofile is emitted. Edit `.lando.ts` to add the rest of your
  stack.
- The emitted module is restricted by the `LandofileService`
  TS-loader's static scan: no forbidden node builtins (`fs`,
  `child_process`, networking, ...), no URL-scheme imports
  (`https:`/`http:`/...), and no relative imports that resolve
  outside the app root. Violations surface as
  `LandofileSandboxError`.
- The static scan is preflight only — it is NOT a security
  sandbox. Once a `.lando.ts` passes the scan it is imported
  in-process and has full access to host globals (`Bun.spawn`,
  `fetch`, `process.env`, `eval`, top-level side effects like
  `console.log` or top-level `await`, etc.). Treat any `.lando.ts`
  you run `lando` against as trusted author-code, identical to
  running a project's `bun run` script.
- Function-form default exports must finish inside the configured
  TS-load timeout (`LANDO_LANDOFILE_TS_TIMEOUT_MS`, default 5000ms).

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
