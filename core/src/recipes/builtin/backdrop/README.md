# backdrop

Backdrop CMS with Apache PHP and MariaDB. Extends lamp. Bee tooling is generated
on the appserver. There is no network scaffold.

## Generated services

- `appserver` - `php:<8.3>` with the Apache-based PHP image,
  `framework: backdrop`, and `BACKDROP_SETTINGS` for the database.
- `database` - `mariadb`.

## Generated tooling

- `lando bee …` - Bee inside the appserver service.
- `lando composer …` - Composer.
- `lando php …` - PHP CLI inside the appserver service.

## Alpha limitations

- The recipe writes a Landofile only.
- Prompts flatten from lamp.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
