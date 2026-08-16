# drupal-cms

Drupal CMS 2 scaffold with PHP, a database (MariaDB or PostgreSQL), and Drush.

## Generated services

- `appserver` — `php:8.3`, `framework: drupal`, `webroot: /app/web`, `allowOverride: true` (webroot `/app/web`).
- `database` — `mariadb` or `postgres` (prompt: `database`).

## Generated tooling

- `lando drush …` — Drush (via `vendor/bin/drush` after scaffolding).
- `lando composer …` — Composer inside the appserver.

## Bootstrapping the codebase

The recipe writes a Landofile only; it does not download Drupal CMS 2. After
`lando start`, scaffold the project through the generated tooling:

```bash
lando composer create-project drupal/cms .
lando drush site:install recipes/drupal_cms_starter -y
```

Drupal CMS 2 uses the same Lando stack as the `drupal` recipe; the difference is
the Composer project (`drupal/cms`) and its bundled install profile / recipes.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.
