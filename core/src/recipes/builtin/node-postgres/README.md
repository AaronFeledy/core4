# node-postgres

Use this recipe for a Node.js app with PostgreSQL and a fixed server entrypoint
at `/app/server.js`. It is the minimal scaffold used by the Lando v4 Alpha
walking skeleton, rather than a framework-specific application starter.

## Host prerequisites

- Lando v4 alpha install (provider-lando or provider-docker).
- The host runtime selected by `lando setup` must be ready.

## Generated Landofile shape

- `web`: `node:lts`, binds the app root and uses `command: ["node", "/app/server.js"]`.
- `database`: `postgres`.

The scaffold closes its HTTP server on SIGTERM or SIGINT and exits within five seconds if connections linger.

## Alpha limitations

- Single fixed framework choice (Node + Postgres). For framework-specific
  scaffolds use the canonical recipes (`node-api`, `wordpress`, `laravel`,
  `symfony`, etc.).
- The recipe does not run `bun install` / `npm install` post-init.
- This scaffold declares the `./:/app` bind mount directly. It uses an
  ordinary bind mount rather than the automatic app mount and its accelerated
  file-sync path.
