# fastapi

Use this recipe for a FastAPI app with PostgreSQL and Redis. It configures the
services but does not create application files. Lando installs the dependencies
from `requirements.txt` when the service starts.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Install dependencies

Create your application files and `requirements.txt`, then run
`lando start` (or `lando restart` if `web` is running). The default command keeps the service running
for setup. Add `.venv/` to `.gitignore` and commit `requirements.txt` so the
dependency list stays with your project.

The stock Python service supplies the active `/app/.venv`. Packages installed
there stay in the service's volume across restarts and rebuilds. If your app
is in `app/main.py`, serve it with `lando uvicorn app.main:app`.

## Generated services

- `web`: `python:3.12`, `framework: fastapi`, `/app/.venv` overlay.
- `database`: `postgres`.
- `cache`: `redis`.

## Generated tooling

- `lando uvicorn …`: uvicorn inside the web service's venv.
- `lando pip …`: pip inside the web service's venv.

## Limitations

- The recipe writes a Landofile only; create application files yourself and
  install dependencies through the generated tooling.
- The recipe does not configure Alembic migrations, ASGI lifespan tooling, or
  SSE/WebSocket presets. Install and wire those through `lando pip` and your
  application code.
