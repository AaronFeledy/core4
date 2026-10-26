# fastapi

Use this recipe for a FastAPI app with PostgreSQL and Redis. It configures the
services but does not create application files or install their dependencies.
Install dependencies through the generated tooling before serving the app.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.

## Install dependencies

Create your application files and `requirements.txt`, then run
`lando pip install -r requirements.txt`. Startup does not install requirements
or launch the application server; the default command keeps the service running
for setup. Add `.venv/` to `.gitignore` and commit `requirements.txt` so the
dependency list stays with your project.

The recipe's entrypoint initializes `/app/.venv` when its pip is missing, then
executes the original command. `VIRTUAL_ENV` and `PATH` select this virtual
environment for tooling and commands you run yourself. Installed packages stay
on the app mount and survive container recreation.

## Generated services

- `web`: `python:3.12`, `framework: fastapi`, persistent `/app/.venv`.
- `database`: `postgres`.
- `cache`: `redis`.

## Generated tooling

- `lando uvicorn …`: uvicorn inside the web service's venv.
- `lando pip …`: pip inside the web service's venv.

## Alpha limitations

- The recipe writes a Landofile only; create application files yourself and
  install dependencies through the generated tooling.
- Alembic migrations, ASGI lifespan tooling, and SSE/WebSocket-specific
  presets are deferred to Beta.
