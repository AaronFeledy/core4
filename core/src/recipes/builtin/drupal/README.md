# drupal

Drupal 11 scaffold with PHP, a database (MariaDB or PostgreSQL), and Drush.

## Generated services

- `appserver` — `php:8.3`, `framework: drupal` (webroot `/app/web`).
- `database` — `mariadb` or `postgres` (prompt: `database`).

## Generated tooling

- `lando drush …` — Drush.
- `lando composer …` — Composer inside the appserver.

## Bootstrapping the codebase

The recipe writes a Landofile only; it does not download Drupal. After
`lando start`, scaffold the project through the generated tooling:

```bash
lando composer create-project drupal/recommended-project .
lando drush site:install
```

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.
