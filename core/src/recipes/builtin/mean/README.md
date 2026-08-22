# mean

MEAN-style Node API with MongoDB and optional Redis. Express is the default
scaffold. There is no framework picker and no database picker; MongoDB is
always included.

## Generated services

- `api` — `node:lts` or `node:22` (prompt: `node`).
- `database` — `mongodb`.
- `cache` — `redis` (only when prompt `redis` answers `true`).

## Generated files

- `.lando.yml`
- `package.json` with Express
- `server.js` Express hello-world

The recipe does not run `npm install`.
