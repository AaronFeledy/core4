# lemp

Use this recipe to serve a PHP app through nginx and PHP-FPM with MariaDB.
The LEMP stack (Linux, nginx, MariaDB, and PHP) keeps the web server separate
from `appserver`, where PHP runs and tooling commands execute.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.

## Serve PHP

Put `index.php` in the project root, then run `lando start` and `lando info`.
Open the app URL served by `web`. Lando generates the nginx FastCGI configuration
and waits for the PHP-FPM backend to be healthy before starting nginx.

## Generated services

- `web`: `nginx`, serves `/app` and forwards PHP requests to `appserver` via FastCGI.
- `appserver`: `php:8.4` by default, with `via: fpm`, `framework: none`, and app-root webroot `.`.
  This is the primary service for tooling, with no separate HTTP route.
- `database`: `mariadb`.

The PHP prompt accepts `8.1`, `8.2`, `8.3`, `8.4`, `8.5`, and `8.6`. These
are accepted recipe inputs, not a guarantee that every application or framework
version supports every PHP version. Choose a version supported by your project.

## Generated tooling

- `lando composer …`: Composer.
- `lando php …`: PHP CLI inside the appserver service.
