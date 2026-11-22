# joomla

Use this recipe for Joomla with Apache PHP and MariaDB. It extends the `lamp`
recipe and adds Joomla CLI tooling inside `appserver`. The recipe configures
the services but does not download Joomla.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Bootstrapping the codebase

The recipe writes a Landofile only. The prompts come from the `lamp` recipe. After
`lando start`, install Joomla into the app root if it is empty.

## Generated services

- `appserver` - `php:8.4` by default, with the Apache-based PHP image and
  `framework: joomla`.
- `database` - `mariadb`.

The PHP prompt accepts `8.1`, `8.2`, `8.3`, `8.4`, `8.5`, and `8.6`. These
are accepted recipe inputs, not a guarantee that every application or framework
version supports every PHP version. Choose a version supported by your project.

## Generated tooling

- `lando joomla …` - `php cli/joomla.php` inside the appserver service, through `:php-local`, from any directory in the app.
- `lando composer …` - Composer.
- `lando create-project <package> [<version>]` - Stage a Composer project outside the app root, promote it into `/app` without overwriting `.lando.yml`, then install `vendor` in place (inherited from `lamp`). Add `--no-scripts` to skip the project's Composer hooks.
- `lando php …` - PHP CLI inside the appserver service.
