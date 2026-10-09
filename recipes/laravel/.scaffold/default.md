# Start a Laravel app

`lando init --recipe laravel` scaffolds PHP, Composer, Node 22, MariaDB or PostgreSQL, Redis, Artisan, npm, and an optional queue worker.

```sh
lando init --recipe laravel --name=my-laravel-app --yes
cd my-laravel-app
lando start
lando info
```

The named init creates `my-laravel-app/`. Change into it before app commands. `--yes` uses PHP 8.4, MariaDB 11.4, Composer 2, webroot `/app/public`, and no worker. Pass `--answer` to change those. PHP 8.6 is a valid `--answer=php=8.6`.

```sh
lando init --recipe laravel --name=my-laravel-app --yes \
  --answer=php=8.1 \
  --answer=database=postgres:16 \
  --answer=composer=2.7.7 \
  --answer=webroot=/app/public \
  --answer=worker=true
```

`lando start` prints the app URL. `lando info` repeats it.

The recipe writes a Landofile, not a Laravel application. For a new app, create
Laravel in `tmp-app` because `.lando.yml` makes the root nonempty:

```sh
lando composer create-project laravel/laravel tmp-app --prefer-dist --no-interaction
lando exec appserver -- sh -c 'cp -a tmp-app/. . && rm -r tmp-app'
lando composer install --no-interaction
lando artisan --version
```

Then install and build the frontend. `lando npm` runs in the `node` service, a
`node:22` container that idles until you call it:

```sh
lando npm --version
lando npm install
lando npm run build
```

`public/build` lands in the shared `/app`, so Apache serves the built assets.
`node_modules` lives in a volume private to the `node` service.

The default app keeps `vendor` in an appserver volume.
With `--answer=worker=true`, the recipe automatically shares the host `vendor`
directory between appserver and worker. No manual mount overrides are needed.
The worker needs a Laravel application and dependencies before it can run
`php artisan queue:work`. If you started it before installation, restart it afterward:

```sh
lando restart
lando logs --service=worker
```

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

For day-to-day tooling and DB/Redis hosts, see [Run the Laravel recipe](/guides/recipes/laravel-workflow/).

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
