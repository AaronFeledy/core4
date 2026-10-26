# LAMP

Create a PHP development stack with Apache and MariaDB or MySQL. Add your
application files to the configured webroot after creating the stack.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe lamp --name=my-lamp-app --yes
cd my-lamp-app
lando start
lando info
```

`--yes` uses PHP 8.4, MariaDB 11.4, Composer 2, and webroot `.`. Pass `--answer` to change those. PHP 8.6 is a valid `--answer=php=8.6`.

To choose a different stack, use this initialization command instead of the
default one above. Run it from the parent directory, not inside the app:

```sh
lando init --recipe lamp --name=my-lamp-app --yes \
  --answer=php=8.1 \
  --answer=database=mysql:8.0 \
  --answer=composer=2.7.7 \
  --answer=webroot=public
```

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

For day-to-day tooling, Apache PHP, and database hosts, see [Run the LAMP recipe](https://aaronfeledy.github.io/core4/guides/recipes/lamp-workflow/).

## 1. scaffold

```bash
lando init --recipe lamp --name=my-lamp-mysql --yes
```

## 2. start

```bash
lando start
```

## 3. info

```bash
lando info
```

## 4. init

```bash
lando init --recipe lamp --name=my-lamp-mysql --yes --answer=php=8.1 --answer=database=mysql:8.0 --answer=composer=2.7.7 --answer=webroot=public
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
