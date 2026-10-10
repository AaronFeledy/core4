# Backdrop

`lando init --recipe backdrop` scaffolds PHP, Composer, and MariaDB or MySQL for a Backdrop CMS app.

```sh
lando init --recipe backdrop --name=my-backdrop-app --yes
cd my-backdrop-app
lando start
lando info
```

`--yes` uses PHP 8.4, MariaDB 11.4, Composer 2, webroot `/app`. Pass `--answer` to change those. PHP 8.6 is a valid `--answer=php=8.6`.

The Landofile sets `BACKDROP_SETTINGS` on `appserver` with the database credentials: database is the app name, user and password `lando`, host `database`. Backdrop reads it under Apache and in `lando bee`, so you don't edit `settings.php`. It overrides `settings.php`, so custom credentials go in the blob.

```sh
lando init --recipe backdrop --name=my-backdrop-app --yes \
  --answer=php=8.2 \
  --answer=database=mysql:8.0 \
  --answer=composer=2.7.7 \
  --answer=webroot=/app
```

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

For day-to-day tooling and database hosts, see [Run the Backdrop recipe](/guides/recipes/backdrop-workflow/).

## 1. scaffold

```bash
lando init --recipe backdrop --name=my-backdrop-mysql --yes
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
lando init --recipe backdrop --name=my-backdrop-mysql --yes --answer=php=8.2 --answer=database=mysql:8.0 --answer=composer=2.7.7 --answer=webroot=/app
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
