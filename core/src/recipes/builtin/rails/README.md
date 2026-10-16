# rails

Ruby on Rails scaffold with PostgreSQL and Redis.

## Generated services

- `web`: `ruby:3.3`, `framework: rails`, `webroot: public`, port `3000`.
- `database`: `postgres`.
- `cache`: `redis`.

The `web` service receives `DATABASE_URL` for PostgreSQL and `REDIS_URL` for
Redis. Database credentials resolve from the database service at plan time.
The Landofile also writes `RAILS_ENV: development` and
`RAILS_LOG_TO_STDOUT: "true"`. These are editable service fields, not hidden
framework defaults. `webroot` is Ruby service context, not Rails server configuration.
The web container stays up for `rails new` and `bundle install`; start the Rails
server explicitly with `lando rails server -b 0.0.0.0`.

## Generated tooling

- `lando rails …`: Rails CLI inside the web service.
- `lando bundle …`: Bundler inside the web service.
- `lando rake …`: Rake inside the web service.

## Alpha limitations

- The recipe writes a Landofile and a minimal Gemfile; `rails new .` runs through the
  generated tooling once the app is started.
- Active Job adapters beyond Redis-backed Sidekiq, Action Cable scaling, and
  multi-database routing are deferred to Beta.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
