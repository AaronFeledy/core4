# FastAPI

`lando init --recipe fastapi` scaffolds FastAPI on Python with PostgreSQL and Redis.

```sh
lando init --recipe fastapi --name=my-fastapi --yes
cd my-fastapi
lando start
lando info
```

The named init creates `my-fastapi/`. Change into it before app commands. FastAPI declares no recipe options, so `--yes` gives you the whole stack and there is nothing to `--answer`. Pass one anyway and init fails instead of quietly ignoring it.

The scaffold writes only `.lando.yml`. It declares a `web` service on `python:3.12` with the `fastapi` framework on port 8000, a `database` service on `postgres`, and a `cache` service on `redis`. The `web` service waits on both.

On startup, the recipe creates `/app/.venv` if it's missing and puts `/app/.venv/bin` first on `PATH`. `lando pip`, `lando uvicorn`, and bare commands inside `web` use it. Installed packages survive restarts, rebuilds, and container recreation because the venv lives on the app mount. Add `.venv/` to `.gitignore` and commit `requirements.txt` for reproducible installs.

The default process keeps `web` alive without serving an app. The recipe creates no application skeleton and never installs dependencies automatically, even when `requirements.txt` exists. Install dependencies first, then serve your app with the generated tooling:

```sh
lando pip install -r requirements.txt
lando uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Use an existing `requirements.txt`, or install FastAPI and uvicorn with `lando pip install fastapi 'uvicorn[standard]'`, then save the versions with `lando exec web -- pip freeze > requirements.txt`.

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it. The URL answers only once your app is serving.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

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
