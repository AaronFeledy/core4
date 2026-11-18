# drupal-contrib

Use this recipe when the git repository is a Drupal module, theme, or
profile with exactly one root `*.info.yml`. Initialization writes a Landofile
into that repository. The first `lando start` builds a Drupal site in a `site`
volume at `/app` around the extension, which Lando mounts at
`/app/web/<type>s/custom/<project>`.

## Host prerequisites

- Lando v4 with provider setup complete.
- Run `lando init` from the extension root. The machine name must match the
  root `*.info.yml`.

## The Drupal site

`lando start` runs `lando-drupal-contrib-sync` as an app build step, so the
first start downloads Drupal and later starts reuse the site. The site's
`composer.json` lives in the volume. It requires `drupal/core-recommended` and
`drupal/core-dev` at the `drupal` constraint, Drush and Drupal Coder, and the
extension's own `require` and `require-dev` with their constraints. The site
never installs the extension as a Composer package, and the extension's
`composer.json` is never changed.

After editing the extension's `composer.json` or `recipe.options.drupal`, run
`lando drupal-contrib-sync`. It changes only the requirements it manages and
reports that the site is up to date when nothing changed.

If the sync reports a mismatch, set `recipe.options.project` and
`recipe.options.type` in `.lando.yml` to match the root info file, run
`lando restart`, then rerun `lando drupal-contrib-sync`.

## Generated services

- `appserver`: `php:8.4` by default, `framework: drupal`, webroot `/app/web`,
  the `site` volume at `/app`, and the extension mounted under it.
- `database`: MariaDB by default, with MySQL and PostgreSQL options.
- `chrome`: Selenium standalone Chromium for FunctionalJavascript tests.
- `edge` (nginx answers only): serves the same `site` volume, read-only.

The PHP prompt accepts `8.1`, `8.2`, `8.3`, `8.4`, `8.5`, and `8.6`. These
are accepted recipe inputs, not a guarantee that every application or framework
version supports every PHP version. Choose a version supported by your project.

## Generated tooling

- `lando drush …`: Drush, working directory `/app`.
- `lando composer …`: Composer for the site, working directory `/app`.
- `lando drupal-contrib-sync`: Build or update the site to match `.lando.yml`
  and the extension's `composer.json`.
- `lando phpunit …`: PHPUnit with core's configuration and SIMPLETEST env, run
  from your current directory as `www-data`.
- `lando phpcs …` / `lando phpcbf …`: Drupal Coder, run from your current
  directory so the extension's `phpcs.xml.dist` applies.
- `lando phpstan …`: PHPStan, run from your current directory so the
  extension's `phpstan.neon.dist` applies.
