# drupal-cms

Drupal CMS 2 scaffold with PHP, a database (MariaDB or PostgreSQL), and Drush.

## Generated services

- `appserver`: `php:8.4`, `framework: drupal`, `webroot: /app/web`, `allowOverride: true`. A root artifact step installs Git for the pinned SVG Image source. Database credentials are injected as environment variables.
- `database`: `mariadb` or `postgres` (prompt: `database`).

## Generated tooling

- `lando drush`: Drush (via `vendor/bin/drush` after scaffolding).
- `lando composer`: Composer inside the appserver.
- `lando drupal-cms-scaffold`: Scaffold Drupal CMS 2 and project-local Drush into the mounted app root. Handles empty volume directories atomically.
- `lando drupal-cms-install`: Install Drupal CMS 2 using the drupal_cms_starter recipe with wired database credentials.

## Bootstrapping the codebase

The recipe writes a Landofile only; it does not download Drupal CMS 2. After
`lando start`, scaffold and install the project through the generated tooling:

```bash
lando drupal-cms-scaffold
lando drupal-cms-install
```

The scaffold command handles the empty `vendor` and `node_modules` volumes by
staging the `composer create-project` output and atomically moving files into
place, similar to how the `drupal` recipe works.

Before promotion, the staged project pins the upstream SVG Image security patch
(merge request 65) through a first-priority root `package` repository. Its
metadata is the patch commit's `composer.json` verbatim plus two Lando-authored
fields: `version: 3.x-dev` (the 3.x development line the patch targets) and a
git `source` pinned to `c788b1e2f2be29f62c9812b2b0558472afa61d6d`. The root
requires `drupal/svg_image:3.x-dev` and `enshrined/svg-sanitize:^1.0`, with no
alias. Composer resolves the lock without installing, the scaffold verifies the
repository and locked source and metadata, audits the lock, installs, verifies
the checkout, replays the deferred root `post-update-cmd` and
`post-create-project-cmd` hooks (recipe unpack), then re-verifies and
re-audits. Any failure publishes nothing. The app keeps `composer.json` and `composer.lock`.

Drupal CMS 2 uses the same Lando stack as the `drupal` recipe; the difference is
the Composer project (`drupal/cms`) and its bundled install profile / recipes.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.
