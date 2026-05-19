# fastapi

FastAPI scaffold with PostgreSQL and Redis.

## Generated services

- `web` — `python:3.12`, `framework: fastapi`.
- `database` — `postgres`.
- `cache` — `redis`.

## Generated tooling

- `lando uvicorn …` — uvicorn inside the web service.
- `lando pip …` — pip inside the web service.

## Alpha limitations

- The recipe writes a Landofile only; project skeleton creation runs through
  the generated tooling.
- Alembic migrations, ASGI lifespan tooling, and SSE/WebSocket-specific
  presets are deferred to Beta.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
