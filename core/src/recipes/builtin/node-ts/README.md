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
- The emitted module is restricted to the
  `LandofileService` TS-loader sandbox: no forbidden node builtins
  (`fs`, `child_process`, networking, ...), no URL-scheme imports
  (`https:`/`http:`/...), no relative imports that resolve outside
  the app root, no top-level side effects (top-level `await`,
  `console.log`, ...). Violations surface as
  `LandofileSandboxError`.
- Function-form default exports must finish inside the configured
  TS-load timeout (`LANDO_LANDOFILE_TS_TIMEOUT_MS`, default 5000ms).

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
