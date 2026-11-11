# Start a Drupal contrib app

Use this recipe when the git repository is the module, theme, or profile: a
root `*.info.yml` and the extension's own `composer.json`. Init writes a
Landofile into that repository. After start, scaffold a Drupal site into the
`/app` volume around the nested extension mount.

You need Lando installed and provider setup complete. Run init from the
extension root so `.lando.yml` lands next to the info file:

```sh
lando init . --recipe drupal-contrib --name=example --yes --answer=project=example
lando start
lando info
```

`--yes` keeps Drupal `^11`, PHP 8.4, Apache, MariaDB 11.4, Composer 2, type
`module`, machine name `example`, and webroot `/app/web`. Change the machine
name with `--answer=project=my_module` so it matches `my_module.info.yml`.
Use `--answer=type=theme` or `--answer=type=profile` when the info file says
so.

`lando start` prints the app URL. `lando info` repeats it. The Drupal site is
not on the host. It lives in an app-scoped named volume at `/app`. Your
extension is bind-mounted at `/app/web/modules/custom/<project>` (or
`themes` / `profiles`). Vendor and core stay in that volume, so your IDE sees
the extension checkout, not Drupal core.

After start, scaffold the site. Composer runs then, not during image build:

```sh
lando drupal-contrib-scaffold
lando drush --version
lando phpunit -- --version
lando composer --version
```

The scaffold fills `/app` around the mount. It does not edit the extension
`composer.json`, and it does not `composer require` the extension package
itself. A path repository at the mount lets the extension's `require` and
`require-dev` resolve into the site.

## Choose stack options

Pass `--answer` for nginx plus FPM, another PHP, another database, or another
core constraint. PHP 8.6 is a valid `--answer=php=8.6`.

```sh
lando init . --recipe drupal-contrib --name=example --yes \
  --answer=project=example \
  --answer=type=module \
  --answer=php=8.5 \
  --answer=webserver=nginx \
  --answer=database=postgres:16 \
  --answer=drupal=^11
```

`lando destroy -y` removes the app containers and networks and keeps its named
volumes, including the Drupal site at `/app`. See [Keep data across stop,
restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

For day-to-day tooling, PHPUnit, and `lando core-version`, see
[Run the Drupal contrib recipe](/guides/recipes/drupal-contrib-workflow/).

## 1. scaffold

```bash
lando init --recipe drupal-contrib --name=example --yes --answer=project=example
```

## 2. inspect

```bash
lando app:config --format=json
```

## 3. init

```bash
lando init --recipe drupal-contrib --name=example-theme --yes --answer=project=hello --answer=type=theme --answer=php=8.5 --answer=webserver=nginx --answer=database=postgres:16 --answer=drupal=^10
```

## 4. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
