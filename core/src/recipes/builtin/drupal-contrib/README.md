# drupal-contrib

Use this recipe when the git repository is a Drupal module, theme, or
profile with exactly one root `*.info.yml`.
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
lando phpunit --version
```

The Drupal site lives at `/app`. The extension is bind-mounted at
`/app/web/modules|themes|profiles/custom/<project>`. Vendor and core stay in
the named volume; they are not copied to the host.

The site `composer.json` requires `drupal/core-recommended` and
`drupal/core-dev` at the `drupal` constraint. Drush is unconstrained so
Composer picks a compatible release. The scaffold copies `require` and
`require-dev` entries from the extension's `composer.json` if present. It leaves
that file alone and uses the bind-mounted checkout without installing the
extension as a Composer package. Rerun an interrupted scaffold to resume.

If the scaffold reports a mismatch, set `recipe.options.project` and
`recipe.options.type` in `.lando.yml` to match the root info file, run
`lando restart`, then rerun `lando drupal-contrib-scaffold`.

## Generated services

- `appserver`: `php:8.4` by default, `framework: drupal`, webroot `/app/web`,
  named volume at `/app`, nested `appMount` at the custom extension path.
- `database`: MariaDB by default, with MySQL and PostgreSQL options.
- `chrome`: Selenium standalone Chromium for FunctionalJavascript tests.

The PHP prompt accepts `8.1`, `8.2`, `8.3`, `8.4`, `8.5`, and `8.6`. These
are accepted recipe inputs, not a guarantee that every application or framework
version supports every PHP version. Choose a version supported by your project.

## Generated tooling

- `lando drush …`: Drush, working directory `/app`.
- `lando composer …`: Composer, working directory `/app`.
- `lando drupal-contrib-scaffold`: Fill `/app` around the extension mount.
- `lando core-version '^10'`: After scaffolding, change the site core packages
  and `drupal/core-dev`, update Drush, and save the constraint in
  `recipe.options.drupal` after Composer succeeds. Quote the constraint.
- `lando phpunit --filter ExampleUnitTest web/modules/custom/example`: Run a
  matching test with core's configuration as `www-data`. Substitute your test
  class and extension path.
- `lando phpcs …` / `lando phpcbf …`: Drupal Coder.
- `lando phpstan …`: PHPStan from `vendor/bin` after core-dev.
