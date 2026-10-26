# Symfony

Create the Lando services for Symfony with PHP, Composer, PostgreSQL or
MariaDB, and Redis. The recipe adds Symfony console tooling, but does not
create the Symfony application.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe symfony --name=my-symfony-app --yes
cd my-symfony-app
lando start
lando info
```

The named init creates `my-symfony-app/`. Change into it before app commands. `--yes` uses PHP 8.4, PostgreSQL 16, Composer 2, and webroot `public`. Pass `--answer` to change those. PHP 8.6 is a valid `--answer=php=8.6`.

To choose a different stack, use this initialization command instead of the
default one above. Run it from the parent directory, not inside the app:

```sh
lando init --recipe symfony --name=my-symfony-app --yes \
  --answer=php=8.5 \
  --answer=database=mariadb:11.4 \
  --answer=composer=2 \
  --answer=webroot=public
```

`lando start` prints the app URL. `lando info` repeats it.

`appserver` starts with `DATABASE_URL` pointing at the `database` service (Postgres or MariaDB, matching your answer, with `serverVersion` and charset set) and `REDIS_URL` pointing at `cache`. Doctrine reads `DATABASE_URL` directly, and Symfony's Dotenv never overrides a real environment variable, so the injected value wins over `.env`. The password comes from the database service's resolved credentials; `lando info` shows the user and database name and redacts the rest.

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

## 1. scaffold

```bash
lando init --recipe symfony --name=my-symfony-mariadb --yes
```

## 2. start

```bash
lando start
```

## 3. info

```bash
lando info
```

## 4. init

```bash
lando init --recipe symfony --name=my-symfony-mariadb --yes --answer=php=8.5 --answer=database=mariadb:11.4 --answer=composer=2 --answer=webroot=public
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
