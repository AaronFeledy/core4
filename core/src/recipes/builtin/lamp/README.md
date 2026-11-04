# lamp

Use this recipe for a PHP app served by Apache with a MariaDB database. The
LAMP stack (Linux, Apache, MariaDB, and PHP) does not select an application
framework for you.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.

## Generated services

- `appserver`: `php:8.4` by default, with the Apache-based PHP image and
  `framework: none`.
- `database`: `mariadb`.

The PHP prompt accepts `8.1`, `8.2`, `8.3`, `8.4`, `8.5`, and `8.6`. These
are accepted recipe inputs, not a guarantee that every application or framework
version supports every PHP version. Choose a version supported by your project.

## Generated tooling

- `lando composer …`: Composer.
- `lando php …`: PHP CLI inside the appserver service.

## Alpha limitations

- This recipe selects the Apache PHP variant. The PHP service also supports FPM and CLI variants; configure your Landofile explicitly if you need a different service layout.
- Lando enables `mod_rewrite` during the stock Apache service build. Vhost
  templates beyond the bundled defaults are deferred.
