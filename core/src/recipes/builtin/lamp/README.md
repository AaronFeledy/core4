# lamp

Generic LAMP (Linux + Apache + MariaDB + PHP) starter.

## Generated services

- `appserver` — `php:<8.2|8.3>` with the Apache-based PHP image and
  `framework: none`.
- `database` — `mariadb`.

## Generated tooling

- `lando composer …` — Composer.
- `lando php …` — PHP CLI inside the appserver service.

## Alpha limitations

- The PHP service ships the framework-agnostic `apache` image only; running a
  dedicated `apache` service in front of `php-fpm` is deferred to Beta.
- Lando enables `mod_rewrite` during the stock Apache service build. Vhost
  templates beyond the bundled defaults are deferred.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
