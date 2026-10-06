# mean

MEAN-style Node API with MongoDB and optional Redis. Express is the default
scaffold. There is no framework picker and no database picker; MongoDB is
always included.

## Generated services

- `api`: `node:lts` or `node:22` (prompt: `node`).
- `database`: `mongodb`.
- `cache`: `redis` (only when prompt `redis` answers `true`).

## Generated files

- `.lando.yml`
- `package.json` with Express
- `server.js` Express hello-world

The `api` startup command runs `npm install`, then serves the Express scaffold on port `3000`. Run `lando start`, then `lando info` and open its URL to see `Hello from Lando`. Use `lando npm` and `lando node` for tooling inside `api`.

The scaffold closes its HTTP server on SIGTERM or SIGINT and exits within five seconds if connections linger.
