# django

Django scaffold with PostgreSQL, Redis, and an optional Celery worker.

## Generated services

- `web` — `python:3.12`, `framework: django`.
- `database` — `postgres`.
- `cache` — `redis`.
- `worker` — additional `python:3.12` running `celery -A app worker` when
  prompt `celery` answers `true`.

## Generated tooling

- `lando django …` — Django management script through `python manage.py`.
- `lando pip …` — pip inside the web service.

## Alpha limitations

- The recipe writes a Landofile only; project bootstrap (`django-admin
  startproject .`) runs through the generated tooling after start.
- Channels / ASGI workers and additional broker backends beyond Redis are
  deferred to Beta.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
