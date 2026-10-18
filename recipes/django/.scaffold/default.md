# Start a Django project

`lando init --recipe django` scaffolds Django on Python with PostgreSQL, Redis, and an optional Celery worker.

```sh
lando init --recipe django --name=my-django --yes
cd my-django
lando start
lando info
```

The named init creates `my-django/`. Change into it before app commands. `--yes` skips the Celery worker. Pass `--answer` to add it.

```sh
lando init --recipe django --name=my-django --yes \
  --answer=celery=true
```

| Option | Values | Default |
| --- | --- | --- |
| `celery` | `true`, `false` | `false` |

The scaffold writes only `.lando.yml`. It declares a `web` service on `python:3.12` with the `django` framework on port 8000, a `database` service on `postgres`, and a `cache` service on `redis` that `web` waits on. Answer `celery=true` and you also get a `worker` service running `celery -A app worker --loglevel=info` against the same database and cache. Leave it `false` and there is no `worker` service at all.

Python has no default healthcheck; add `healthcheck:` if start should wait for your application to serve requests. The Celery worker uses `restart: unless-stopped`. If missing code or dependencies make its process exit, start succeeds with a warning and a `restarting` worker row. An exhausted healthcheck still fails start regardless of restart policy. The worker retries and starts on its own once the application is installed. Check it with:

```sh
lando logs --service=worker
```

Two tooling commands ship with the Landofile, both running inside the `web` service:

```sh
lando django migrate
lando pip install -r requirements.txt
```

`lando django` wraps `python manage.py`. After creating your project and installing its dependencies, run `lando django runserver 0.0.0.0:8000` to serve it through the proxy.

`web` (and `worker`, if you added it) starts with `DATABASE_URL` pointing at the `database` service and `REDIS_URL` pointing at `cache`. Parse `DATABASE_URL` with `dj-database-url` or `urllib.parse` in `settings.py`; nothing there needs to name the host or password. `lando info` shows the user and database name and redacts the rest.

The generated Landofile writes `DJANGO_SETTINGS_MODULE: config.settings` into `environment` on `web` and the optional `worker`. Edit either value if your project uses another module. Port `8000` is editable on `web`; keep the server bind in sync.

`lando start` keeps the web container running for project setup; it does not start Django's server. The route from `lando info` reaches your app only while the server is running.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

For the day-to-day path (`django-admin`, `DATABASE_URL` in settings, `runserver` bind), see [Run the Django recipe](/guides/recipes/django-workflow/).

## 1. scaffold

```bash
lando init --recipe django --name=my-django-celery --yes
```

## 2. inspect-config

```bash
lando app:config --format=json
```

## 3. start

```bash
lando start
```

## 4. info

```bash
lando info
```

## 5. init

```bash
lando init --recipe django --name=my-django-celery --yes --answer=celery=true
```

## 6. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
