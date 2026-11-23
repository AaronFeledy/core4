# drupal

Use this recipe to run Drupal 11 with PHP, MariaDB or PostgreSQL, and Drush.
Initialization configures the stack. The first `lando start` scaffolds Drupal
and project-local Drush into the app root.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Bootstrapping the codebase

The recipe writes a Landofile only. After `lando start`, the appserver `build.app`
scaffold step stages a complete project before copying it into `/app` and recovers
a partial copy on retry:

```bash
lando start
lando drush --version
```

A later start with an intact site skips Composer. An existing checkout with
`composer.json` is adopted without rewriting project files.

## Generated services

- `appserver`: `php:8.4` by default, `framework: drupal` (app-relative webroot `web`), with a first-start scaffold step.
- `database`: `mariadb` or `postgres` (prompt: `database`).

The PHP prompt accepts `8.1`, `8.2`, `8.3`, `8.4`, `8.5`, and `8.6`. These
are accepted recipe inputs, not a guarantee that every application or framework
version supports every PHP version. Choose a version supported by your project.

## Generated tooling

- `lando drush …`: Drush from the site's `vendor/bin`, from any directory in the app.
- `lando composer …`: Composer inside the appserver.
- `lando phpcs …` / `lando phpcbf …`: PHP_CodeSniffer from the site's
  `vendor/bin`, through the `:drupal-local` launcher. First start installs
  `drupal/coder` and writes `phpcs.xml.dist` (Drupal and DrupalPractice over
  modules, themes, and profiles under the webroot, skipping `contrib`). Without a
  ruleset, Lando adds `--standard=Drupal,DrupalPractice`, Drupal's file
  extensions, and `--ignore=*/node_modules/*,*/vendor/*`, and with no arguments
  checks whichever `*/custom` directories exist under the webroot.
- `lando phpstan …`: PHPStan from the site's `vendor/bin`. First start installs
  it with `mglaman/phpstan-drupal` and writes `phpstan.neon.dist` (level 1, same
  directories). The task passes the nearest PHPStan config to `analyse`, because
  PHPStan only looks in its working directory.
