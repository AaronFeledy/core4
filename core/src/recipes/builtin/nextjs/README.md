# nextjs

Next.js frontend with an optional database and Auth helper picker.

## Generated services

- `web` — `node:lts` or `node:22` (prompt: `node`), exposes Next.js's default
  port 3000. `NEXTAUTH_PROVIDER` env hint captures the picked Auth helper.
- `database` — `postgres` or `mariadb` (omitted when prompt `database` is
  `none`).

## Generated tooling

- `lando next …` — Next.js CLI through `npx next`.
- `lando npm …` — npm inside the web service.

## Alpha limitations

- Auth picker (`nextauth`, `clerk`, `none`) only sets the
  `NEXTAUTH_PROVIDER` env hint. Users install and configure the chosen helper
  through the generated tooling.
- A dedicated Next.js service type with first-class build presets is deferred
  to Beta.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
