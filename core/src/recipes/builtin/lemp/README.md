# lemp

Generic LEMP (Linux + nginx + MariaDB + PHP) starter.

## Generated services

- `web` — `nginx`, fronts the `appserver` service.
- `appserver` — `php:<8.2|8.3>` with `framework: none`.
- `database` — `mariadb`.

## Generated tooling

- `lando composer …` — Composer.
- `lando php …` — PHP CLI inside the appserver service.

## Alpha limitations

- The bundled nginx service ships a default configuration. Custom
  vhost / upstream templates are not auto-generated.
- TLS, HTTP/2, and reverse-proxy caching are deferred to Beta.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
