# LEMP

Create a PHP development stack with nginx, PHP-FPM, and MariaDB. Put your
`index.php` in the project root so nginx has an application to serve.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe lemp --name=my-lemp-app --yes
cd my-lemp-app
lando start
lando info
```

`--yes` uses PHP 8.4. Pass `--answer` to change that. PHP 8.6 is a valid `--answer=php=8.6`.

`lando start` prints the app URL. `lando info` repeats it.

The `web` service serves `/app` through nginx and sends PHP requests to
`appserver` on its internal PHP-FPM port. Both services use `.` as the webroot, resolving to the app mount at `/app`.
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
