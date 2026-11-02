# rails

Use this recipe for Ruby on Rails with PostgreSQL and Redis. It writes a
Landofile and a minimal Gemfile, not a complete Rails application. Create the
application and install its dependencies before starting the Rails server.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.

## Prepare the application

The web container stays running so you can create the application with
`rails new` and install dependencies with `bundle install`. It does not start
the Rails server for you. When the application is ready, run
`lando rails server -b 0.0.0.0`.

The `web` service receives `DATABASE_URL` for PostgreSQL and `REDIS_URL` for
Redis. Lando resolves database credentials from the database service when it
builds the app plan. The Landofile also sets `RAILS_ENV: development` and
`RAILS_LOG_TO_STDOUT: "true"`. You can edit these service fields; they are not
hidden framework defaults. The `webroot` field supplies context to the Ruby
service, not configuration to the Rails server.

## Generated services

- `web`: `ruby:3.3`, `framework: rails`, `webroot: public`, port `3000`.
- `database`: `postgres`.
- `cache`: `redis`.

## Generated tooling

- `lando rails …`: Rails CLI inside the web service.
- `lando bundle …`: Bundler inside the web service.
- `lando rake …`: Rake inside the web service.

## Alpha limitations

- The recipe writes a Landofile and a minimal Gemfile; `rails new .` runs through the
  generated tooling once the app is started.
- Active Job adapters beyond Redis-backed Sidekiq, Action Cable scaling, and
  multi-database routing are deferred to Beta.
