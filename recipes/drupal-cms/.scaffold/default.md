# Drupal CMS

If this README is inside a generated Drupal CMS app, you're already in the app directory. Start it:

```sh
lando start
lando info
```

To create a new app, run `lando init` from its parent directory, then enter the directory it creates:

```sh
lando init --recipe drupal-cms --name=my-drupal-cms-app --yes
cd my-drupal-cms-app
lando start
lando info
```

`--yes` uses PHP 8.3, Apache, MariaDB 11.4, Composer 2, and webroot `/app/web`. The generated `.lando/php/drupal-cms.ini` sets a 512M PHP memory limit for both Drush and web requests. Edit that file if your site needs another limit. Pass `--answer` to change the stack choices. PHP 8.6 is a valid `--answer=php=8.6`.

```sh
lando init --recipe drupal-cms --name=my-drupal-cms-app --yes --answer=php=8.5 --answer=webserver=nginx --answer=database=postgres:16 --answer=composer=2
```

Run that optional command from the parent directory, then `cd my-drupal-cms-app` before `lando start`.

`lando start` prints the app URL(s). `lando info` repeats them.

After start, scaffold the codebase, then install. Drush comes from the project's Composer manifest:

```sh
lando drupal-cms-scaffold
lando drupal-cms-install
lando drush --version
lando drush user:login --no-browser
```

The generated Drush task uses the current app URL, including its proxy port, for login links. Set `DRUSH_OPTIONS_URI` or pass Drush `--uri` to choose another URL.

For a Drush flag that also names a Lando flag, put `--` before the Drush arguments. For example, `lando drush -- status --format=json` passes `--format=json` to Drush.

On Windows, a later Composer install can hit Composer's 300-second subprocess
limit while moving Drupal core from the `vendor` volume into `web/` on the
host bind mount. If Composer reports that `mv` timed out, retry that install
with a bounded timeout for just this command:

```sh
lando exec appserver -- env COMPOSER_PROCESS_TIMEOUT=900 composer install --no-interaction
```

This allows up to 15 minutes for each Composer subprocess. It does not make
writes to the Windows bind mount faster.

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
