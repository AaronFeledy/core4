# node-api

Node.js HTTP API with an Express / Fastify / Hono framework picker and an
optional Postgres database.

## Generated services

- `api` — `node:lts` or `node:22` (prompt: `node`), with `API_FRAMEWORK` env
  hint set to the picked framework.
- `database` — `postgres` (omitted when prompt `database` is `none`).

## Generated tooling

- `lando npm …` — npm inside the api service.
- `lando node …` — Node CLI inside the api service.

## Alpha limitations

- MongoDB is deferred to Beta; only `postgres` or `none` are offered for the
  database prompt. Users that need MongoDB can author a `services.<name>` of
  `type: compose` until a first-class `mongodb` service type ships.
- The recipe writes a Landofile only; framework scaffolding (e.g.
  `npm create fastify`) runs through the generated tooling after start.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
