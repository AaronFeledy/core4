# Django

`lando init --recipe django` scaffolds Django on Python with PostgreSQL, Redis, and an optional Celery worker.

```sh
lando init --recipe django --name=my-django --yes
lando start
lando info
```

`--yes` skips the Celery worker. Pass `--answer` to add it.

```sh
lando init --recipe django --name=my-django --yes \
  --answer=celery=true
```

| Option | Values | Default |
| --- | --- | --- |
| `celery` | `true`, `false` | `false` |

The scaffold writes only `.lando.yml`. It declares a `web` service on `python:3.12` with the `django` framework on port 8000, a `database` service on `postgres`, and a `cache` service on `redis` that `web` waits on. Answer `celery=true` and you also get a `worker` service running `celery -A app worker --loglevel=info` against the same database and cache. Leave it `false` and there is no `worker` service at all.

Two tooling commands ship with the Landofile, both running inside the `web` service:

```sh
lando django migrate
lando pip install -r requirements.txt
```

`lando django` wraps `python manage.py`, so `lando django runserver` and `lando django createsuperuser` work the way you expect.

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe django --name=my-django-celery --yes
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
lando init --recipe django --name=my-django-celery --yes --answer=celery=true
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
