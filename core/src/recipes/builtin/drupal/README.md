# drupal

Use this recipe to run Drupal 11 with PHP, MariaDB or PostgreSQL, and Drush.
Initialization configures the stack; run the scaffold command below to add
Drupal and project-local Drush.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Bootstrapping the codebase

The recipe writes a Landofile only; it does not download Drupal or Drush. After
`lando start`, scaffold both through the generated tooling. The command stages a
complete project before copying it into `/app` and recovers a partial copy on retry:

```bash
lando drupal-scaffold
lando drush --version
```

## Generated services

- `appserver`: `php:8.4` by default, `framework: drupal` (app-relative webroot `web`).
- `database`: `mariadb` or `postgres` (prompt: `database`).

The PHP prompt accepts `8.1`, `8.2`, `8.3`, `8.4`, `8.5`, and `8.6`. These
are accepted recipe inputs, not a guarantee that every application or framework
version supports every PHP version. Choose a version supported by your project.

## Generated tooling

- `lando drush …`: Drush from the app's `vendor/bin`, from any directory in the app.
- `lando composer …`: Composer inside the appserver.
- `lando phpcs …` / `lando phpcbf …`: PHP_CodeSniffer from the app's
  `vendor/bin`; require `drupal/coder` to install it. Without a project ruleset
  (`phpcs.xml.dist`, `phpcs.xml`, `.phpcs.xml`, or `.phpcs.xml.dist` in the
  current directory or a parent), Lando adds `--standard=Drupal,DrupalPractice`,
  Drupal's file extensions, and `--ignore=*/node_modules/*,*/vendor/*`, and with
  no arguments checks whichever of `modules/custom`, `themes/custom`, and
  `profiles/custom` exist under the webroot. A ruleset or an explicit
  `--standard=` passes the arguments through unchanged.
- `lando phpstan …`: PHPStan from the app's `vendor/bin`; require
  `phpstan/phpstan`, `mglaman/phpstan-drupal`, and `phpstan/extension-installer`.
  With no arguments it runs `analyse` with the nearest PHPStan config in the
  current directory or a parent, or else on the same custom directories.
  Arguments pass through unchanged.
- `lando drupal-scaffold`: Scaffold pinned Drupal 11 and project-local Drush, with recovery on retry.
