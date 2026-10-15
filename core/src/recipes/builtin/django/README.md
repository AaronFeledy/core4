# django

Django scaffold with PostgreSQL, Redis, and an optional Celery worker.

## Generated services

- `web`: `python:3.12`, `framework: django`, no default healthcheck.
- `database`: `postgres`.
- `cache`: `redis`.
- `worker`: additional `python:3.12` running `celery -A app worker` with `restart: unless-stopped` when
  prompt `celery` answers `true`.

The `web` service and optional Celery `worker` receive `DATABASE_URL` for
PostgreSQL and `REDIS_URL` for Redis. Database credentials resolve from the
database service at plan time.

Before the application and dependencies exist, start warns about the `restarting`
worker. The engine retries it automatically; it starts on its own after installation.
Check `lando logs --service=worker`.

## Generated tooling

- `lando django`: Django management script through `python manage.py`.
- `lando pip`: pip inside the web service.

## Alpha limitations

- The recipe writes a Landofile only; project bootstrap (`django-admin
  startproject .`) runs through the generated tooling after start.
- Channels / ASGI workers and additional broker backends beyond Redis are
  deferred to Beta.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
