# WordPress

`lando init --recipe wordpress` writes PHP, MariaDB, Composer, and a `lando wp` task. Start builds the stock PHP service with mysqli, checksum-verified WP-CLI, and a 512M PHP memory limit for both `lando wp` and web requests, ready to install WordPress.

```sh
lando init --recipe wordpress --name=my-wordpress-app --yes
cd my-wordpress-app
lando start
lando wp --info
lando info
```

`--yes` uses PHP 8.4 and no Redis cache. Pass `--answer` to change those. PHP 8.6 is a valid `--answer=php=8.6`. The 512M limit lives in the image as `50-lando-wordpress.ini`; mount a later drop-in like `zz-custom.ini` to change it.

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

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
