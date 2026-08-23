# Laravel

`lando init --recipe laravel` scaffolds PHP, Composer, MariaDB or PostgreSQL, Redis, Artisan, and an optional queue worker.

```sh
lando init --recipe laravel --name=my-laravel-app --yes
lando start
lando info
```

`--yes` uses PHP 8.3, MariaDB 11.4, Composer 2, webroot `/app/public`, and no worker. Pass `--answer` to change those.

```sh
lando init --recipe laravel --name=my-laravel-app --yes \
  --answer=php=8.1 \
  --answer=database=postgres:16 \
  --answer=composer=2.7.7 \
  --answer=webroot=/app/public \
  --answer=worker=true
```

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe laravel --name=my-laravel-worker --yes
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
lando init --recipe laravel --name=my-laravel-worker --yes --answer=php=8.1 --answer=database=postgres:16 --answer=composer=2.7.7 --answer=webroot=/app/public --answer=worker=true
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
