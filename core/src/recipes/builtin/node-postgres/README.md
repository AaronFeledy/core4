# node-postgres

Minimal Node.js + Postgres scaffold used by the Lando v4 Alpha walking skeleton.

## Generated Landofile shape

- `web` — `node:lts`, binds the app root and runs `node /app/server.js`.
- `database` — `postgres`.

## Alpha limitations

- Single fixed framework choice (Node + Postgres). For framework-specific
  scaffolds use the canonical recipes (`node-api`, `wordpress`, `laravel`,
  `symfony`, etc.).
- The recipe does not run `bun install` / `npm install` post-init.
- Mutagen / file-sync is deferred; the bind mount uses native realization.

## Host prerequisites

- Lando v4 alpha install (provider-lando or provider-docker).
- The host runtime selected by `lando setup` must be ready.
