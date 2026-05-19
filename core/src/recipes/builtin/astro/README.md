# astro

Astro frontend with an optional content-source database picker.

## Generated services

- `web` — `node:lts` or `node:22` (prompt: `node`), exposes Astro's default
  port 4321.
- `database` — `postgres` or `mariadb` when prompt `database` is not `none`.

## Generated tooling

- `lando astro …` — Astro CLI through `npx`.
- `lando npm …` — npm inside the web service.

## Alpha limitations

- The recipe uses the bundled `node:<lts|22>` service type. A dedicated Astro
  service type with first-class build presets is deferred to Beta.
- Astro adapters (Vercel, Netlify, Cloudflare) are deferred; the recipe
  assumes a Node-based dev/preview server.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
