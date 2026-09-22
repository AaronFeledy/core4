# Symfony

`lando init --recipe symfony` scaffolds PHP, Composer, PostgreSQL or MariaDB, Redis, and the Symfony console.

```sh
lando init --recipe symfony --name=my-symfony-app --yes
cd my-symfony-app
lando start
lando info
```

The named init creates `my-symfony-app/`. Change into it before app commands. `--yes` uses PHP 8.4, PostgreSQL 16, Composer 2, and webroot `/app/public`. Pass `--answer` to change those. PHP 8.6 is a valid `--answer=php=8.6`.

```sh
lando init --recipe symfony --name=my-symfony-app --yes \
  --answer=php=8.5 \
  --answer=database=mariadb:11.4 \
  --answer=composer=2 \
  --answer=webroot=/app/public
```

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe symfony --name=my-symfony-mariadb --yes
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
lando init --recipe symfony --name=my-symfony-mariadb --yes --answer=php=8.5 --answer=database=mariadb:11.4 --answer=composer=2 --answer=webroot=/app/public
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
