# django

Use this recipe for a Django app with PostgreSQL, Redis, and an optional Celery
worker. It writes a Landofile, not a Django project, so install the application
and its dependencies before starting the Django server.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.

## Prepare the application

The web service stays running for project setup; it does not start a Django
server. After installing the app, run `lando django runserver 0.0.0.0:8000`.
You can change port `8000` in the Landofile.

The `web` service and optional Celery `worker` receive `DATABASE_URL` for
PostgreSQL and `REDIS_URL` for Redis. Lando resolves database credentials from
the database service when it builds the app plan. Both services use
`DJANGO_SETTINGS_MODULE: config.settings`; edit their `environment` fields if
your project uses another settings module.

If you enabled Celery, start warns about a `restarting` worker until the
application and dependencies exist. The engine retries the worker automatically,
so it starts after installation. Check `lando logs --service=worker` to see
what it is doing.

## Generated services

- `web`: `python:3.12`, `framework: django`, no default healthcheck.
- `database`: `postgres`.
- `cache`: `redis`.
- `worker`: additional `python:3.12` running `celery -A app worker` with `restart: unless-stopped` when
  prompt `celery` answers `true`.

## Generated tooling

- `lando django`: Django management script through `python manage.py`.
- `lando pip`: pip inside the web service.

## Alpha limitations

- The recipe writes a Landofile only; after installing Django, bootstrap the
  project with `lando exec web -- django-admin startproject config .`.
- Channels / ASGI workers and additional broker backends beyond Redis are
  deferred to Beta.
