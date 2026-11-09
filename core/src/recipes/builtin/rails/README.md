# rails

Use this recipe for Ruby on Rails with PostgreSQL or SQLite and Redis. It writes a
Landofile and a minimal Gemfile, not a complete Rails application. Create the
application and install its dependencies before starting the Rails server.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Prepare the application

The web container stays running so you can create the application with
`lando rails new . --database=postgresql --force` (the default choice) or
`lando rails new . --database=sqlite3 --force` (the SQLite choice). Use `--force`
only in a new app; Rails replaces the minimal Gemfile and adds `pg` or `sqlite3`.
Install dependencies with `bundle install`. The recipe does not start
the Rails server. When the application is ready, run
`lando rails server -b 0.0.0.0`.

The `web` service receives `DATABASE_URL` for PostgreSQL and `REDIS_URL` for
Redis. Lando resolves PostgreSQL credentials from the database service when it
builds the app plan. The Landofile also sets `RAILS_ENV: development` and
`RAILS_LOG_TO_STDOUT: "true"`. You can edit these service fields; they are not
hidden framework defaults. The `webroot` field supplies context to the Ruby
service, not configuration to the Rails server.

## Generated services

- `web`: `ruby:3.3`, `framework: rails`, `webroot: public`, port `3000`. Its build
  installs `build-essential`, `git`, `libpq-dev`, and `libyaml-dev` so `rails new`
  can initialize the repository and compile `pg` and `psych`, then installs Rails.
- `database`: `postgres`.
- `database=sqlite` omits the database service and its dependencies and declares
  `sqlite.path: storage/development.sqlite3` on `web` with a `/app` app mount.
  Rails 8's generated `config/database.yml` points at that file under `Rails.root`,
  so SQLite needs no `DATABASE_URL`. PostgreSQL stays the recipe default.

- `cache`: `redis`.

Recipe files cannot vary by option, so the seed Gemfile remains source-only.
The application generator selects the adapter gem; each app gets only its
chosen database adapter.

## Generated tooling

- `lando rails …`: Rails CLI inside the web service.
- `lando bundle …`: Bundler inside the web service.
- `lando rake …`: Rake inside the web service.

## Limitations

- The recipe writes a Landofile and a minimal Gemfile; `rails new .` runs through the
  generated tooling once the app is started.
- The recipe wires `DATABASE_URL` and `REDIS_URL` only. It does not configure
  an Active Job adapter, Sidekiq, Action Cable scaling, or multi-database
  routing; add those gems and services to the Landofile yourself.
