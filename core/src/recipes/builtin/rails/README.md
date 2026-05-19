# rails

Ruby on Rails scaffold with PostgreSQL and Redis.

## Generated services

- `web` — `ruby:3.3`, `framework: rails`.
- `database` — `postgres`.
- `cache` — `redis`.

## Generated tooling

- `lando rails …` — Rails CLI inside the web service.
- `lando bundle …` — Bundler inside the web service.

## Alpha limitations

- The recipe writes a Landofile only; `rails new .` runs through the
  generated tooling once the app is started.
- Active Job adapters beyond Redis-backed Sidekiq, Action Cable scaling, and
  multi-database routing are deferred to Beta.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
