# nextjs

Next.js frontend with an optional database and Auth helper picker.

## Generated services

- `web`: `node:lts` or `node:22` (prompt: `node`), exposes Next.js's default
  port 3000. `NEXTAUTH_PROVIDER` env hint captures the picked Auth helper.
- `database`: `postgres` or `mariadb` (omitted when prompt `database` is
  `none`).

## Generated tooling

- `lando next ...`: Next.js CLI through `npx next`.
- `lando npm ...`: npm inside the web service.
- `lando nextjs-scaffold`: `create-next-app@16.4.0` inside the web service
  (empty TypeScript App Router template: ESLint, no Tailwind, no `src/`,
  `@/*` alias, Turbopack). Generates in a temp directory, copies into the app
  root without overwriting `.lando.yml` or existing files, then runs
  `npm install` in `/app`; dependencies land in the `node_modules` volume
  mounted at `/app/node_modules`. Refuses any existing `package.json`. A
  top-level collision aborts before copying and names the first conflicting
  path. If `npm install` fails, generated sources stay; fix the npm error and
  run `lando npm install`.

## Init contract

- `lando init --recipe nextjs` writes `.lando.yml` only and downloads no
  application code. The app comes from `lando nextjs-scaffold` after
  `lando start`, or from an existing project (`lando npm install`, then
  `lando next dev`).
- `lando start` does not launch Next. `lando next dev` runs in the foreground
  on port 3000.

## Alpha limitations

- Auth picker (`nextauth`, `clerk`, `none`) only sets the
  `NEXTAUTH_PROVIDER` env hint. Users install and configure the chosen helper
  through the generated tooling.
- A dedicated Next.js service type with first-class build presets is deferred
  to Beta.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
