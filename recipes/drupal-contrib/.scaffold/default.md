# Start a Drupal contrib app

Run a local Drupal site around your module, theme, or profile checkout. The
extension root must have exactly one `*.info.yml`. Init writes a Landofile into
that checkout, and the scaffold installs Drupal into the `/app` volume.

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
lando phpunit --version
lando composer --version
```

If the extension has a `composer.json`, the scaffold copies its `require` and
`require-dev` entries into the site's `composer.json`. It leaves the extension's
file alone and uses the mounted checkout without installing the extension as a
Composer package. If the scaffold is interrupted, rerun it to resume.

To run one test by name, pass a PHPUnit filter and the extension's path inside
`/app`. Replace `ExampleUnitTest` with your test class:

```sh
lando phpunit --filter ExampleUnitTest web/modules/custom/example
```

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
  --answer='drupal=^11'
```

`lando destroy -y` removes the app containers and networks and keeps its named
volumes, including the Drupal site at `/app`. See [Keep data across stop,
restart, and destroy](../../docs/guides/tutorial/app-lifecycle.mdx#keep-data-across-stop-restart-and-destroy).

For the core constraint change and scaffold recovery, see
[Run the Drupal contrib recipe](../../docs/guides/recipes/drupal-contrib-workflow.mdx).

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
