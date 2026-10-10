# fastapi

FastAPI scaffold with PostgreSQL and Redis.

## Generated services

- `web`: `python:3.12`, `framework: fastapi`, persistent `/app/.venv`.
- `database`: `postgres`.
- `cache`: `redis`.

## Generated tooling

- `lando uvicorn …`: uvicorn inside the web service's venv.
- `lando pip …`: pip inside the web service's venv.

The recipe's entrypoint initializes `/app/.venv` when its pip is missing and executes the
original command. `VIRTUAL_ENV` and `PATH` select it for tooling and bare user
commands. Installed packages survive container recreation on the app mount.
Add `.venv/` to `.gitignore` and commit `requirements.txt` for reproducibility.
Run `lando pip install -r requirements.txt` before serving an app; startup never
installs requirements automatically. The default command stays keep-alive.

## Alpha limitations

- The recipe writes a Landofile only; create application files yourself and
  install dependencies through the generated tooling.
- Alembic migrations, ASGI lifespan tooling, and SSE/WebSocket-specific
  presets are deferred to Beta.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
