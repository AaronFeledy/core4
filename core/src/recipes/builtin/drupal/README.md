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

- `lando drush …`: Drush.
- `lando composer …`: Composer inside the appserver.
- `lando drupal-scaffold`: Scaffold pinned Drupal 11 and project-local Drush, with recovery on retry.
