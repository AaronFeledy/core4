# drupal-contrib

Use this recipe when the git repository is a Drupal module, theme, or
profile: a root `*.info.yml` and the extension's own `composer.json`.
Initialization writes a Landofile into that repository. After `lando start`,
scaffold a Drupal site into an app-scoped `/app` volume around the nested
extension mount.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.
- Run `lando init` from the extension root. The machine name must match the
  root `*.info.yml`.

## Bootstrapping the codebase

The recipe writes a Landofile only. It does not download Drupal during image
build, and it does not edit the extension's `composer.json`. After
`lando start`, scaffold the site through the generated tooling:

```bash
lando drupal-contrib-scaffold
lando drush --version
lando phpunit -- --version
```

The Drupal site lives at `/app`. The extension is bind-mounted at
`/app/web/modules|themes|profiles/custom/<project>`. Vendor and core stay in
the named volume; they are not copied to the host.

The site `composer.json` requires `drupal/core-recommended` and
`drupal/core-dev` at the `drupal` constraint. Drush is unconstrained so
Composer picks a compatible release. A path repository pointing at the
extension mount lets the extension's `require` and `require-dev` resolve. The
scaffold does not `composer require` the extension package itself.

## Generated services

- `appserver`: `php:8.4` by default, `framework: drupal`, webroot `/app/web`,
  named volume at `/app`, nested `appMount` at the custom extension path.
- `database`: `mariadb` or `postgres` (prompt: `database`).
- `chrome`: Selenium standalone Chromium for FunctionalJavascript tests.

The PHP prompt accepts `8.1`, `8.2`, `8.3`, `8.4`, `8.5`, and `8.6`. These
are accepted recipe inputs, not a guarantee that every application or framework
version supports every PHP version. Choose a version supported by your project.

## Generated tooling

- `lando drush …`: Drush, working directory `/app`.
- `lando composer …`: Composer, working directory `/app`.
- `lando drupal-contrib-scaffold`: Fill `/app` around the extension mount.
- `lando core-version <constraint>`: Update the Drupal core constraint.
- `lando phpunit …`: PHPUnit with core's configuration and SIMPLETEST env.
- `lando phpcs …` / `lando phpcbf …`: Drupal Coder.
- `lando phpstan …`: PHPStan from `vendor/bin` after core-dev.
