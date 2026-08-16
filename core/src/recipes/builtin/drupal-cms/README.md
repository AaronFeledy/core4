# drupal-cms

Drupal CMS 2 scaffold with PHP, a database (MariaDB or PostgreSQL), and Drush.

## Generated services

- `appserver` — `php:8.3`, `framework: drupal`, `webroot: /app/web`, `allowOverride: true` (webroot `/app/web`). Database credentials are injected as environment variables.
- `database` — `mariadb` or `postgres` (prompt: `database`).

## Generated tooling

- `lando drush …` — Drush (via `vendor/bin/drush` after scaffolding).
- `lando composer …` — Composer inside the appserver.
- `lando drupal-cms-scaffold` — Scaffold Drupal CMS 2 and project-local Drush into the mounted app root. Handles empty volume directories atomically.
- `lando drupal-cms-install` — Install Drupal CMS 2 using the drupal_cms_starter recipe with wired database credentials.

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

Drupal CMS 2 uses the same Lando stack as the `drupal` recipe; the difference is
the Composer project (`drupal/cms`) and its bundled install profile / recipes.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.
