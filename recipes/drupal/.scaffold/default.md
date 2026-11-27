# Drupal

Create a Drupal stack with PHP, a database, Composer, and Drush tooling.
The first `lando start` downloads the Drupal project and project-local Drush.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe drupal --name=my-drupal-app --yes
cd my-drupal-app
lando start
lando info
```

`lando start` prints the app URL. `lando info` repeats it.

Confirm project-local Drush after start:

```sh
lando drush --version
```

The first start also installs Drupal Coder and PHPStan and writes `phpcs.xml.dist` and `phpstan.neon.dist`, so `lando phpcs`, `lando phpcbf`, and `lando phpstan` check your custom modules and themes. See [Lint PHP](https://aaronfeledy.github.io/core4/guides/recipes/drupal-workflow/#lint-php).

## Choose stack options

`--yes` uses Drupal 11, PHP 8.4, Apache, MariaDB 11.4, Composer 2, and webroot `web`. Pass `--answer=webroot=docroot` to use `docroot/` instead. A new scaffold needs one directory name. Pass `--answer=testing=true` to set up PHPUnit and Chrome when scaffolding a new site. To use PHP 8.6, pass `--answer=php=8.6`.

To choose a different stack, use this initialization command instead of the
default one above. Run it from the parent directory, not inside the app:

```sh
lando init --recipe drupal --name=my-drupal-app --yes \
  --answer=php=8.5 \
  --answer=webserver=nginx \
  --answer=database=postgres:16 \
  --answer=composer=2 \
  --answer=drupal=10
```

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

For day-to-day tooling and database hosts, see [Run the Drupal recipe](https://aaronfeledy.github.io/core4/guides/recipes/drupal-workflow/).

## 1. init

```bash
lando init --recipe drupal --name=my-drupal-app --yes
```

## 2. start

```bash
lando start
```

## 3. check-drush

```bash
lando drush --version
```

## 4. init

```bash
lando init --recipe drupal --name=my-drupal-nginx --yes --answer=php=8.5 --answer=webserver=nginx --answer=database=postgres:16 --answer=composer=2 --answer=drupal=10 --answer=webroot=docroot
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y --volumes
```
