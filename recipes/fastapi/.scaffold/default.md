# FastAPI

Create the Lando services for FastAPI with Python, PostgreSQL, and Redis.
The recipe does not create application files or install dependencies. Start
the services first, then install dependencies and run your application.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe fastapi --name=my-fastapi --yes
cd my-fastapi
lando start
lando info
```

The named init creates `my-fastapi/`. Change into it before app commands. FastAPI declares no recipe options, so `--yes` gives you the whole stack and there is nothing to `--answer`. An undeclared `--answer` makes initialization fail.

The scaffold writes only `.lando.yml`. It declares a `web` service on `python:3.12` with the `fastapi` framework on port 8000, a `database` service on `postgres`, and a `cache` service on `redis`. The `web` service waits on both.

On startup, the recipe runs `python -m venv /app/.venv` if `/app/.venv/bin/pip` is not executable and puts `/app/.venv/bin` first on `PATH`. `lando pip`, `lando uvicorn`, and bare commands inside `web` use it. The venv is a service-owned overlay, not a host directory: restart and a plain `lando destroy` keep it, and `lando destroy --volumes` or `--purge` removes it. An empty overlay makes the next start recreate the venv. Add `.venv/` to `.gitignore` and commit `requirements.txt` for reproducible installs. Use `appMount.includes: [.venv]` if you want the host tree for IDE autocomplete.

The default process keeps `web` alive without serving an app. The recipe creates no application skeleton and never installs dependencies automatically, even when `requirements.txt` exists. `port:` sets the endpoint and `PORT` / `UVICORN_PORT` (default `8000`); the FastAPI preset sets `UVICORN_HOST=0.0.0.0`. Uvicorn CLI reads those variables, so it needs no bind flags. Authored port variables must equal the planned port or planning fails; host defaults remain overridable. Install dependencies first, then serve your app with the generated tooling:

```sh
lando pip install -r requirements.txt
lando uvicorn app.main:app --reload
```

Use an existing `requirements.txt`, or install FastAPI and uvicorn with `lando pip install fastapi 'uvicorn[standard]'`, then save the versions with `lando pip freeze > requirements.txt`.

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it. The URL answers only once your app is serving.

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

For day-to-day tooling, Postgres/Redis hosts, and serving on every start, see [Run the FastAPI recipe](/guides/recipes/fastapi-workflow/).

## 1. scaffold

```bash
lando init --recipe fastapi --name=my-fastapi --yes
```

## 2. start

```bash
lando start
```

## 3. info

```bash
lando info
```

## Cleanup

```bash
lando destroy -y
```
