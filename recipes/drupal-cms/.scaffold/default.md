# Drupal CMS

`lando init --recipe drupal-cms` scaffolds PHP, a database, Drush, and Composer.

```sh
lando init --recipe drupal-cms --name=my-drupal-cms-app --yes
lando start
lando info
```

`--yes` uses PHP 8.3, Apache, MariaDB 11.4, Composer 2, and webroot `/app/web`. Pass `--answer` to change those.

```sh
lando init --recipe drupal-cms --name=my-drupal-cms-app --yes \
  --answer=php=8.5 \
  --answer=webserver=nginx \
  --answer=database=postgres:16 \
  --answer=composer=2
```

`lando start` prints the app URL(s). `lando info` repeats them.

After start, scaffold the codebase, then install. Drush comes from the project's Composer manifest:

```sh
lando drupal-cms-scaffold
lando drupal-cms-install
lando drush --version
```

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe drupal-cms --name=my-drupal-cms-nginx --yes
```

## 2. start

```bash
lando start
```

## 3. scaffold-cms

```bash
lando drupal-cms-scaffold
```

## 4. check-drush

```bash
lando drush --version
```

## 5. init

```bash
lando init --recipe drupal-cms --name=my-drupal-cms-nginx --yes --answer=php=8.5 --answer=webserver=nginx --answer=database=postgres:16 --answer=composer=2 --answer=webroot=/app/web
```

## 6. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
