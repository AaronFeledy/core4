# django

Use this recipe for a Django app with PostgreSQL or SQLite, Redis, and an optional Celery
worker. It writes a Landofile, not a Django project, so install the application
and its dependencies before starting the Django server.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Prepare the application

The web service stays running for project setup; it does not start a Django
server. After installing the app, run `lando django runserver 0.0.0.0:8000`.
You can change port `8000` in the Landofile.

The `web` service and optional Celery `worker` receive `DATABASE_URL` for
the chosen database and `REDIS_URL` for Redis. Lando resolves PostgreSQL credentials from
the database service when it builds the app plan. Both services use
`DJANGO_SETTINGS_MODULE: config.settings`; edit their `environment` fields if
your project uses another settings module.

The `web` and `worker` services share `/app/.venv` automatically.
Run `lando start` on a fresh clone to install `requirements.txt`. After editing
it in a running app, run `lando restart`. Rebuilds keep installed packages.

For Celery, include `celery[redis]` in the requirements, configure the Celery
app in `config/celery.py`, and set `CELERY_BROKER_URL` from `REDIS_URL` in
your Django settings. `lando start` warns while the worker retries with missing
application code or dependencies. Check `lando logs --service=worker` for readiness, and run
`lando restart -s worker` after changing code or dependencies.

## Generated services

- `web`: `python:3.12`, `framework: django`, no default healthcheck.
- `database`: `postgres`.
- With `database=sqlite`, Lando omits the database service and its dependencies,
  declares `sqlite.path: db.sqlite3` on `web` with an explicit `/app` mount, and
  sets `DATABASE_URL=sqlite:////app/db.sqlite3` on `web` and `worker`. The documented
  `startproject config .` layout puts `BASE_DIR` at `/app`, so Django's default
  file and `dj-database-url` resolve to the same path. PostgreSQL stays the default.
- `cache`: `redis`.
- `worker`: additional `python:3.12` with `command: exec celery -A config worker --loglevel=info`, `restart: unless-stopped`, and
  `endpoints: []` (Celery serves no HTTP, so the worker gets no route) when prompt `celery` answers `true`.

## Generated tooling

- `lando django`: Django management script through `python manage.py`.
- `lando pip`: `python -m pip` inside the web service, installing into the shared venv.

## Limitations

- The recipe writes a Landofile only; after installing Django, bootstrap the
  project with `lando exec web -- django-admin startproject config .`.
- The recipe provides Redis and the optional Celery worker. It does not
  configure Channels, ASGI workers, or other broker backends.
