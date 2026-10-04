# LEMP

`lando init --recipe lemp` scaffolds nginx, PHP-FPM, and MariaDB.

```sh
lando init --recipe lemp --name=my-lemp-app --yes
cd my-lemp-app
lando start
lando info
```

`lando start` prints the app URL. `lando info` repeats it.

The `web` service serves `/app` through nginx and sends PHP requests to
`appserver` on its internal PHP-FPM port. Both services use `/app` as the webroot.
Put your `index.php` in the project root. `appserver` remains the primary service
for PHP and Composer tooling; it does not expose a separate HTTP route.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

For day-to-day tooling, PHP-FPM behind nginx, and database hosts, see [Run the LEMP recipe](https://aaronfeledy.github.io/core4/guides/recipes/lemp-workflow/).

## 1. scaffold

```bash
lando init --recipe lemp --name=my-lemp-app --yes
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
