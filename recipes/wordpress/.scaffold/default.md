# WordPress

`lando init --recipe wordpress` writes PHP, MariaDB, Composer, and a `lando wp` task. The stock PHP image has no `wp` binary or `mysqli` extension yet, so add both before you install WordPress.

```sh
lando init --recipe wordpress --name=my-wordpress-app --yes
cd my-wordpress-app
lando start
lando info
```

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

For WP-CLI, `mysqli`, the install steps, and database hosts, see [Run the WordPress recipe](/guides/recipes/wordpress-workflow/).

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
