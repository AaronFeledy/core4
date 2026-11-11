# Start a Rails project

Create a Rails development stack with PostgreSQL or SQLite, Redis, and `rails`,
`bundle`, and `rake` tooling. The recipe writes a Landofile and a minimal
Gemfile; create the Rails project and install its dependencies before running
the server.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe rails --name=my-rails-app --yes
cd my-rails-app
lando start
lando info
```

The named init creates `my-rails-app/`. Change into it before app commands.
`lando start` keeps the web container running for project setup; it does not
start a Rails server. Generate Rails with the PostgreSQL adapter below.
`--force` replaces the recipe's minimal Gemfile with generated application files,
so run these commands only in a new app:

```sh
lando rails new . --database=postgresql --force
lando rails db:prepare
lando rails server -b 0.0.0.0
```

Rails adds `pg` to the application's Gemfile.
Open the route shown by `lando info` after the server starts.

| Option | Values | Default |
| --- | --- | --- |
| `database` | `postgres`, `sqlite` | `postgres` |

With `--answer=database=sqlite`, generate Rails with `--database=sqlite3`
instead. Rails adds the `sqlite3` gem and uses `storage/development.sqlite3`.
Lando declares that file on `web` and omits the database service. SQLite uses the
generated `config/database.yml`; the recipe does not set `DATABASE_URL` for it.
See [Use SQLite](../../docs/guides/recipes/rails-workflow.mdx#use-sqlite).

The generated Landofile keeps `framework: rails` and writes `webroot: public`, port `3000`, `RAILS_ENV: development`, and `RAILS_LOG_TO_STDOUT: "true"` on `web`. Edit those fields directly. `port:` sets the endpoint and `PORT`; the Rails preset defaults `BINDING=0.0.0.0`. `rails server` reads both, so it needs no bind flags. An authored `PORT` must equal the planned port or planning fails; `BINDING` remains overridable. `webroot` is Ruby service context, not Rails server configuration.

After start, run app tooling inside the web service:

```sh
lando rails
lando bundle
lando rake
```

With PostgreSQL, `web` starts with `DATABASE_URL` pointing at the `database` service and `REDIS_URL` pointing at `cache`. ActiveRecord reads `DATABASE_URL` on its own, so `lando rails db:prepare` connects without a `database.yml` edit. The URL is built from the database service's resolved credentials and its planned port, with the user, password, and database name each percent-encoded, so it follows an authored `creds:` block or `port:` on `database`. A `creds.password` written as a `${secret:...}` reference resolves when `web` is created, never into the plan. `lando info` shows the user and database name and redacts the rest.

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

For day-to-day tooling and DB/Redis hosts, see [Run the Rails recipe](/guides/recipes/rails-workflow/).

## Choose Redis persistence

Redis keeps data across restarts by default. For disposable caches, set `persist: false` on your Redis service and rebuild. That disables its durable data store, AOF, and RDB snapshots. Don't use it for queues or data you need to keep.

Set `creds.password` on the same service to require authentication. Configure your Rails Redis client with the matching password; `lando redis-cli` authenticates automatically. Verify the change with `lando redis-cli ping` after `lando rebuild`. See [Add Redis](../../docs/guides/services/redis.mdx) for persistence, port, and restart checks.

## 1. scaffold

```bash
lando init --recipe rails --name=my-rails-app --yes
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
lando init --recipe rails --name=rails-sqlite --answer=database=sqlite --yes
```

## 6. inspect

## Cleanup

```bash
lando destroy -y
```
