# backdrop

Use this recipe for Backdrop CMS with Apache PHP and MariaDB. It extends the
`lamp` recipe and adds Bee tooling inside `appserver`. The recipe configures the
services but does not download Backdrop.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Bootstrapping the codebase

The recipe writes a Landofile only. The prompts come from the `lamp` recipe. After
`lando start`, install Backdrop into the app root if it is empty.

## Generated services

- `appserver` - `php:<8.4>` with the Apache-based PHP image,
  `framework: backdrop`, and `BACKDROP_SETTINGS` for the database. The `BACKDROP_SETTINGS` value
  names `{{ app.name }}` as the database, resolved at start and visible to
  both Bee and Apache.
- `database` - `mariadb`.

## Generated tooling

- `lando bee …` - Bee inside the appserver service.
- `lando composer …` - Composer.
- `lando php …` - PHP CLI inside the appserver service.
