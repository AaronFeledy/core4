# Backdrop

Create the Lando services for Backdrop CMS with PHP, Composer, and MariaDB or
MySQL. The recipe writes the Landofile, not the Backdrop application.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe backdrop --name=my-backdrop-app --yes
cd my-backdrop-app
lando start
lando info
```

`--yes` uses PHP 8.4, MariaDB 11.4, Composer 2, webroot `.`. Pass `--answer` to change those. PHP 8.6 is a valid `--answer=php=8.6`.

The Landofile sets `BACKDROP_SETTINGS` on `appserver` with the database credentials: database is the app name, user and password `lando`, host `database`. Backdrop reads it under Apache and in `lando bee`, so you don't edit `settings.php`. It overrides `settings.php`, so put custom credentials in `BACKDROP_SETTINGS`.

To choose a different stack, use this initialization command instead of the
default one above. Run it from the parent directory, not inside the app:

```sh
lando init --recipe backdrop --name=my-backdrop-app --yes \
  --answer=php=8.2 \
  --answer=database=mysql:8.0 \
  --answer=composer=2.7.7 \
  --answer=webroot=.
```

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

For day-to-day tooling and database hosts, see [Run the Backdrop recipe](/guides/recipes/backdrop-workflow/).

## 1. scaffold

```bash
lando init --recipe backdrop --name=my-backdrop-app --yes
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
lando init --recipe backdrop --name=my-backdrop-mysql --yes --answer=php=8.2 --answer=database=mysql:8.0 --answer=composer=2.7.7 --answer=webroot=.
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
