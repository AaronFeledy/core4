# FastAPI

`lando init --recipe fastapi` scaffolds FastAPI on Python with PostgreSQL and Redis.

```sh
lando init --recipe fastapi --name=my-fastapi --yes
lando start
lando info
```

FastAPI declares no recipe options, so `--yes` gives you the whole stack and there is nothing to `--answer`. Pass one anyway and init fails instead of quietly ignoring it.

The scaffold writes only `.lando.yml`. It declares a `web` service on `python:3.12` with the `fastapi` framework on port 8000, a `database` service on `postgres`, and a `cache` service on `redis`. The `web` service waits on both.

Two tooling commands ship with the Landofile, both running inside the `web` service:

```sh
lando uvicorn app.main:app --reload
lando pip install -r requirements.txt
```

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe fastapi --name=my-fastapi-stack --yes
```

## 2. start

```bash
lando start
```

## 3. info

```bash
lando info
```

## 4. init

```bash
lando init --recipe fastapi --name=my-fastapi-stack --yes
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
