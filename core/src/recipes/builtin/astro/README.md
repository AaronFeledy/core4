# astro

Use this recipe for an Astro frontend with an optional content-source database.
It uses a Node-based development or preview server; deployment adapters are not
installed or configured for you.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Generated services

- `web`: `node:lts` or `node:22` (prompt: `node`), exposes Astro's default
  port 4321.
- `database`: `postgres` or `mariadb` when prompt `database` is not `none`.

## Generated tooling

- `lando astro …`: Astro CLI through `npx`.
- `lando npm …`: npm inside the web service.

## Limitations

- There is no dedicated Astro service type; the recipe uses the bundled
  `node:<lts|22>` service type with no build presets.
- The recipe does not install or configure Astro adapters (Vercel, Netlify,
  Cloudflare). It assumes a Node-based dev/preview server; add an adapter
  through `lando npm` if your deployment needs one.
