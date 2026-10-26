# mean

Use this recipe to start an Express API with MongoDB and optional Redis.
Express and MongoDB are fixed choices: there is no framework or database
picker. The generated app includes a hello-world server you can open after
starting the stack.

The `api` startup command runs `npm install`, then serves the Express scaffold on port `3000`. Run `lando start`, then `lando info` and open its URL to see `Hello from Lando`. Use `lando npm` and `lando node` for tooling inside `api`.

## Generated services

- `api`: `node:lts` or `node:22` (prompt: `node`).
- `database`: `mongodb`.
- `cache`: `redis` (only when prompt `redis` answers `true`).

## Generated files

- `.lando.yml`
- `package.json` with Express
- `server.js` Express hello-world

The scaffold closes its HTTP server on SIGTERM or SIGINT and exits within five seconds if connections linger.
