# WordPress

`lando init --recipe wordpress` scaffolds PHP, MariaDB, WP-CLI, and Composer.

```sh
lando init --recipe wordpress --name=my-wordpress-app --yes
lando start
lando info
```

`--yes` uses PHP 8.4 and no Redis cache. Pass `--answer` to change those. PHP 8.6 is a valid `--answer=php=8.6`.

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

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
