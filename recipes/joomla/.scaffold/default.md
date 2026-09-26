# Joomla

`lando init --recipe joomla` scaffolds PHP, Composer, and MariaDB or MySQL.

```sh
lando init --recipe joomla --name=my-joomla-app --yes
lando start
lando info
```

`--yes` uses PHP 8.3, MariaDB 11.4, Composer 2, and webroot `/app`. Pass `--answer` to change those. PHP 8.6 is a valid `--answer=php=8.6`.

```sh
lando init --recipe joomla --name=my-joomla-mysql --yes \
  --answer=php=8.2 \
  --answer=database=mysql:8.0 \
  --answer=composer=2.7.7 \
  --answer=webroot=/app
```

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

For day-to-day tooling and database hosts, see [Run the Joomla recipe](/guides/recipes/joomla-workflow/).

## 1. scaffold

```bash
lando init --recipe joomla --name=my-joomla-mysql --yes
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
lando init --recipe joomla --name=my-joomla-mysql --yes --answer=php=8.2 --answer=database=mysql:8.0 --answer=composer=2.7.7 --answer=webroot=/app
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
