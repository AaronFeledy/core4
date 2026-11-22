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

- `lando drush …`: Drush from the site's `vendor/bin`, from any directory in the app.
- `lando composer …`: Composer inside the appserver.
- `lando phpcs …` / `lando phpcbf …`: PHP_CodeSniffer from the site's
  `vendor/bin`, through the `:drupal-local` launcher. The scaffold installs
  `drupal/coder` and writes `phpcs.xml.dist` (Drupal and DrupalPractice over
  `web/modules`, `web/themes`, and `web/profiles`, skipping `contrib`). Without a
  ruleset, Lando adds `--standard=Drupal,DrupalPractice`, Drupal's file
  extensions, and `--ignore=*/node_modules/*,*/vendor/*`, and with no arguments
  checks whichever `*/custom` directories exist under the webroot.
- `lando phpstan …`: PHPStan from the site's `vendor/bin`. The scaffold installs
  it with `mglaman/phpstan-drupal` and writes `phpstan.neon.dist` (level 1, same
  directories). The task passes the nearest PHPStan config to `analyse`, because
  PHPStan only looks in its working directory.
- `lando drupal-scaffold`: Scaffold pinned Drupal 11, project-local Drush, and the PHP lint tools and configs, with recovery on retry.
