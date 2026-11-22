# Start a Drupal contrib app

Run a local Drupal site around your module, theme, or profile checkout. The
extension root must have exactly one `*.info.yml`. Init writes a Landofile into
that checkout, and the scaffold installs Drupal into the `/app` volume.

You need Lando installed and provider setup complete. Run init from the
extension root so `.lando.yml` lands next to the info file:

```sh
lando init . --recipe drupal-contrib --name=example --yes --answer=project=example
lando start
lando info
```

`--yes` keeps Drupal `^11`, PHP 8.4, Apache, MariaDB 11.4, Composer 2, type
`module`, and machine name `example`. The site's webroot is always `/app/web`.
Change the machine name with `--answer=project=my_module` so it matches
`my_module.info.yml`. Use `--answer=type=theme` or `--answer=type=profile` when
the info file says so.

The first `lando start` builds the Drupal site around your extension, which
takes a few minutes while Composer downloads Drupal. `lando info` shows the app
URL. The site lives in a named volume at `/app`, and your extension is mounted
at `/app/web/modules/custom/<project>` (or `themes` / `profiles`). Drupal core
and `vendor/` stay in that volume, so your repository holds only your extension.

Run tests from the extension root. Paths are relative to where you run them:

```sh
lando drush status
lando phpunit tests/src/Unit
```

`lando phpcs`, `lando phpcbf`, and `lando phpstan` read your extension's
`phpcs.xml.dist` and `phpstan.neon.dist`. Without them, `lando phpcs` checks the
extension against Drupal and DrupalPractice, and a bare `lando phpstan` analyses
it at level 0. See [Lint PHP](../../docs/guides/recipes/drupal-contrib-workflow.mdx#lint-php).

The site requires your extension's `require` and `require-dev` entries but
never installs the extension as a Composer package. Every `lando start` brings
the site in line with your extension's `composer.json` and
`recipe.options.drupal` in `.lando.yml`; run `lando drupal-contrib-sync` to do it
without restarting.

## Choose stack options

Pass `--answer` for nginx plus FPM, another PHP, another database, or another
core constraint. PHP 8.6 is a valid `--answer=php=8.6`.

```sh
lando init . --recipe drupal-contrib --name=example --yes \
  --answer=project=example \
  --answer=type=module \
  --answer=php=8.5 \
  --answer=webserver=nginx \
  --answer=database=postgres:16 \
  --answer='drupal=^11'
```

`lando destroy -y` removes the app containers and networks and keeps its named
volumes, including the Drupal site at `/app`. See [Keep data across stop,
restart, and destroy](../../docs/guides/tutorial/app-lifecycle.mdx#keep-data-across-stop-restart-and-destroy).

For dependency changes, switching Drupal core, and fixing a failed sync, see
[Run the Drupal contrib recipe](../../docs/guides/recipes/drupal-contrib-workflow.mdx).

## 1. scaffold

```bash
lando init --recipe drupal-contrib --name=example --yes --answer=project=example
```

## 2. inspect

```bash
lando app:config --format=json
```

## 3. init

```bash
lando init --recipe drupal-contrib --name=example-theme --yes --answer=project=hello --answer=type=theme --answer=php=8.5 --answer=webserver=nginx --answer=database=postgres:16 --answer=drupal=^10
```

## 4. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
