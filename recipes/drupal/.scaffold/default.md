# Drupal

`lando init --recipe drupal` scaffolds PHP, a database, Drush, and Composer.

```sh
lando init --recipe drupal --name=my-drupal-app --yes
lando start
lando info
```

`--yes` uses Drupal 11, PHP 8.3, Apache, MariaDB 11.4, Composer 2, and webroot `/app/web`. Pass `--answer` for nginx plus FPM, another PHP, or another database.

```sh
lando init --recipe drupal --name=my-drupal-app --yes \
  --answer=php=8.5 \
  --answer=webserver=nginx \
  --answer=database=postgres:16 \
  --answer=composer=2 \
  --answer=drupal=10
```

`lando start` prints the app URL. `lando info` repeats it.

After start, scaffold the Drupal project and project-local Drush. The scaffold is a retryable stage-then-commit, so a flaky Composer fetch does not leave you half-installed:

```sh
lando drupal-scaffold
lando drush --version
```

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe drupal --name=my-drupal-nginx --yes
```

## 2. start

```bash
lando start
```

## 3. scaffold-drupal

```bash
lando drupal-scaffold
```

## 4. check-drush

```bash
lando drush --version
```

## 5. init

```bash
lando init --recipe drupal --name=my-drupal-nginx --yes --answer=php=8.5 --answer=webserver=nginx --answer=database=postgres:16 --answer=composer=2 --answer=drupal=10 --answer=webroot=/app/web
```

## 6. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
