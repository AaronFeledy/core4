# drupal

Drupal 11 scaffold with PHP, a database (MariaDB or PostgreSQL), and Drush.

## Generated services

- `appserver` — `php:8.3`, `framework: drupal` (webroot `/app/web`).
- `database` — `mariadb` or `postgres` (prompt: `database`).

## Generated tooling

- `lando drush …` — Drush.
- `lando composer …` — Composer inside the appserver.
- `lando drupal-scaffold` — Retryably scaffold pinned Drupal 11 and project-local Drush.

## Bootstrapping the codebase

The recipe writes a Landofile only; it does not download Drupal or Drush. After
`lando start`, scaffold both through the generated tooling. The command stages a
complete project before copying it into `/app` and recovers a partial copy on retry:

```bash
lando drupal-scaffold
lando drush --version
```

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.
