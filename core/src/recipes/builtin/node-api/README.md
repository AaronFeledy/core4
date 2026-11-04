# node-api

Use this recipe for a Node.js HTTP API with an Express, Fastify, or Hono
framework choice and an optional PostgreSQL database. It writes a Landofile;
scaffold the application through the generated tooling after starting the stack.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.

## Generated services

- `api`: `node:lts` or `node:22` (prompt: `node`), with `API_FRAMEWORK` env
  hint set to the picked framework.
- `database`: `postgres` (omitted when prompt `database` is `none`).

The `api` service receives `DATABASE_URL` when PostgreSQL is selected, alongside
its `API_FRAMEWORK` hint. Database credentials resolve from the database service
at plan time. With `database: none`, no `DATABASE_URL` is injected. This recipe
does not include Redis or inject `REDIS_URL`.

## Generated tooling

- `lando npm …`: npm inside the api service.
- `lando node …`: Node CLI inside the api service.

## Alpha limitations

- The database prompt offers only `postgres` or `none`. The `mongodb`
  service type is available, but this recipe does not offer it as a database
  choice. Configure that service separately if your app needs MongoDB.
- The recipe writes a Landofile only; framework scaffolding (e.g.
  `npm create fastify`) runs through the generated tooling after start.
