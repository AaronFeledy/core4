# WordPress

Create the Lando services for WordPress with PHP, MariaDB, Composer, and
WP-CLI tooling. Starting the stock PHP service builds in mysqli,
checksum-verified WP-CLI, and a 512M memory limit for CLI and web requests.
The recipe does not download WordPress; install it after starting the stack. To run a subdomain network, follow the [WordPress multisite guide](/guides/recipes/wordpress-multisite/).

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe wordpress --name=my-wordpress-app --yes
cd my-wordpress-app
lando start
lando wp --info
lando info
```

`--yes` uses PHP 8.4 and no Redis cache. Pass `--answer` to change those. PHP 8.6 is a valid `--answer=php=8.6`. The 512M limit lives in the image as `50-lando-wordpress.ini`; mount a later drop-in like `zz-custom.ini` to change it.

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

For the install steps and database hosts, see [Run the WordPress recipe](/guides/recipes/wordpress-workflow/).

## 1. scaffold

```bash
lando init --recipe wordpress --name=my-wordpress-app --yes
```

## 2. start

```bash
lando start
```

## 3. info

```bash
lando info
```

## Cleanup

```bash
lando destroy -y
```
