# Start a Drupal CMS app

If this README is inside a generated Drupal CMS app, you're already in the app directory. Start it:

```sh
lando start
lando info
```

To create a new app, run `lando init` from its parent directory, then enter the directory it creates:

```sh
lando init --recipe drupal-cms --name=my-drupal-cms-app --yes
cd my-drupal-cms-app
lando start
lando info
```

`--yes` uses PHP 8.4, Apache, MariaDB 11.4, Composer 2, and webroot `web`. The generated `.lando/php/drupal-cms.ini` sets a 512M PHP memory limit for both Drush and web requests. Edit that file if your site needs another limit. Pass `--answer` to change the stack choices. PHP 8.6 is a valid `--answer=php=8.6`.

```sh
lando init --recipe drupal-cms --name=my-drupal-cms-app --yes --answer=php=8.5 --answer=webserver=nginx --answer=database=postgres:16 --answer=composer=2
```

Run that optional command from the parent directory, then `cd my-drupal-cms-app` before `lando start`.

`lando start` prints the app URL(s). `lando info` repeats them.

After start, scaffold the codebase, then install. Drush comes from the project's Composer manifest:

```sh
lando drupal-cms-scaffold
lando drupal-cms-install
lando drush --version
lando drush user:login --no-browser
```

The scaffold installs Git in `appserver` and pins the upstream SVG Image security patch from [merge request 65](https://git.drupalcode.org/project/svg_image/-/merge_requests/65) at commit `c788b1e2f2be29f62c9812b2b0558472afa61d6d`. This is a `3.x-dev` development build, not a tagged release. It lets Drupal CMS use the fixed `enshrined/svg-sanitize` 1.0 release without ignoring security advisories. The source pin and its package metadata stay in your `composer.json` and `composer.lock`; a mismatch or failed audit stops scaffolding before it touches your app.

`lando drupal-cms-install` prints the admin username and a generated password when it finishes. Then open the site:

```sh
lando open
lando open --print
```

`lando open` launches the current app URL in your browser; `--print` just prints it. The front page and `/user/login` should both render with HTTP 200. On the default Apache stack, check both pages from inside `appserver`, without a browser or the proxy:

```sh
lando exec appserver -- curl --fail --silent --show-error --max-time 30 --output /dev/null --write-out %{http_code} http://127.0.0.1/
lando exec appserver -- curl --fail --silent --show-error --max-time 30 --output /dev/null --write-out %{http_code} http://127.0.0.1/user/login
```

Each prints `200`. Anything else means Drupal didn't render the page, so check `lando logs -s appserver`.

The generated Drush task uses the current app URL, including its proxy port, for login links. Set `DRUSH_OPTIONS_URI` or pass Drush `--uri` to choose another URL.

For a Drush flag that also names a Lando flag, put `--` before the Drush arguments. For example, `lando drush -- status --format=json` passes `--format=json` to Drush.

On Windows, a later Composer install can hit Composer's 300-second subprocess
limit while moving Drupal core from the `vendor` volume into `web/` on the
host bind mount. If Composer reports that `mv` timed out, retry that install
with a bounded timeout for just this command:

```sh
lando exec appserver -- env COMPOSER_PROCESS_TIMEOUT=900 composer install --no-interaction
```

This allows up to 15 minutes for each Composer subprocess. It does not make
writes to the Windows bind mount faster.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

For day-to-day tooling and database hosts, see [Run the Drupal CMS recipe](/guides/recipes/drupal-cms-workflow/).

## 1. scaffold

```bash
lando init --recipe drupal-cms --name=my-drupal-cms-nginx --yes
```

## 2. start

```bash
lando start
```

## 3. scaffold-cms

```bash
lando drupal-cms-scaffold
```

## 4. install-cms

```bash
lando drupal-cms-install
```

## 5. check-drush

```bash
lando drush --version
```

## 6. init

```bash
lando init --recipe drupal-cms --name=my-drupal-cms-nginx --yes --answer=php=8.5 --answer=webserver=nginx --answer=database=postgres:16 --answer=composer=2 --answer=webroot=web
```

## 7. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
