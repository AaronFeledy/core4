# joomla

Joomla with Apache PHP and MariaDB. Extends lamp. The Joomla CLI is generated
on the appserver as `php cli/joomla.php`. There is no network install.

## Generated services

- `appserver` - `php:<8.3>` with the Apache-based PHP image and
  `framework: joomla`.
- `database` - `mariadb`.

## Generated tooling

- `lando joomla …` - `php cli/joomla.php` inside the appserver service.
- `lando composer …` - Composer.
- `lando php …` - PHP CLI inside the appserver service.

## Bootstrapping the codebase

The recipe writes a Landofile only. Prompts flatten from lamp. After
`lando start`, install Joomla into the app root if it is empty.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.
