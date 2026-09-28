# lemp

Generic LEMP (Linux + nginx + MariaDB + PHP) starter.

## Generated services

- `web`: `nginx`, serves `/app` and forwards PHP requests to `appserver` via FastCGI.
- `appserver`: `php:<8.2|8.3>` with `via: fpm`, `framework: none`, and webroot `/app`.
  This is the primary service for tooling, with no separate HTTP route.
- `database`: `mariadb`.

## Generated tooling

- `lando composer …`: Composer.
- `lando php …`: PHP CLI inside the appserver service.

## Serve PHP

Put `index.php` in the project root, then run `lando start` and `lando info`.
Open the app URL served by `web`. Lando generates the nginx FastCGI configuration
and waits for the PHP-FPM backend to be healthy before starting nginx.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
