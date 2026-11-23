# drupal-cms

Use this recipe to run Drupal CMS 2 with PHP, MariaDB or PostgreSQL, and Drush.
Initialization configures the stack; the scaffold and install commands below
create the application and install the site.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Bootstrapping the codebase

The recipe writes a Landofile and `.lando/php/drupal-cms.ini` (a 512M PHP
memory limit for Drush and web requests); it does not download Drupal CMS 2.
After `lando start`, scaffold and install the project through the generated
tooling, then browse the installed site with `lando open`:

```bash
lando drupal-cms-scaffold
lando drupal-cms-install
lando open
```

The front page and `/user/login` both answer HTTP 200 once install finishes.

The scaffold command stages the `composer create-project` output and atomically
moves files into place, similar to how the `drupal` recipe works. PHP services
get no `vendor` or `node_modules` volumes, so the project lands in your app
directory.

Right after `create-project`, the staged project allows the
`dealerdirect/phpcodesniffer-composer-installer` and
`phpstan/extension-installer` Composer plugins, as `drupal/recommended-project`
does. It requires `drupal/coder`, `phpstan/phpstan`, `mglaman/phpstan-drupal`,
and `phpstan/extension-installer` as dev dependencies in the same Composer solve
and stages `phpcs.xml.dist` and `phpstan.neon.dist`, so `lando phpcs` and
`lando phpstan` work as soon as the scaffold finishes.

Before promotion, the staged project pins the upstream SVG Image security patch
(merge request 65) through a first-priority root `package` repository. Its
metadata is the patch commit's `composer.json` verbatim plus two Lando-authored
fields: `version: 3.x-dev` (the 3.x development line the patch targets) and a
git `source` pinned to `c788b1e2f2be29f62c9812b2b0558472afa61d6d`. The root
requires `drupal/svg_image:3.x-dev` and `enshrined/svg-sanitize:^1.0`, with no
alias, plus `drupal/drupal_cms_starter:^2`, which `drupal/cms` no longer requires
itself. The scaffold fails if that recipe is not installed. Composer resolves the lock without installing, the scaffold verifies the
repository and locked source and metadata, audits the lock, installs, verifies
the checkout, replays the deferred root `post-update-cmd` and
`post-create-project-cmd` hooks (recipe unpack), then re-verifies and
re-audits. Any failure publishes nothing. The app keeps `composer.json` and `composer.lock`.

Drupal CMS 2 uses the same Lando stack as the `drupal` recipe; the difference is
the Composer project (`drupal/cms`) and its bundled install profile / recipes.

## Generated services

- `appserver`: `php:8.4`, `framework: drupal`, `webroot: web`, `allowOverride: true`. A root artifact step installs Git for the pinned SVG Image source. Database credentials are injected as environment variables.
- `database`: `mariadb` or `postgres` (prompt: `database`).

## Generated tooling

- `lando drush`: Drush from the site's `vendor/bin` after scaffolding, from any directory in the app.
- `lando composer`: Composer inside the appserver.
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
- `lando drupal-cms-scaffold`: Scaffold Drupal CMS 2 and project-local Drush into the mounted app root. Handles empty volume directories atomically.
- `lando drupal-cms-install`: Install Drupal CMS 2 using the drupal_cms_starter recipe with wired database credentials.
