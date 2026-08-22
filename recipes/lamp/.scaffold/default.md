# LAMP

`lando init --recipe lamp` scaffolds Apache, PHP, and MariaDB or MySQL.

```sh
lando init --recipe lamp --name=my-lamp-app --yes
lando start
lando info
```

`--yes` uses PHP 8.3, MariaDB 11.4, Composer 2, and webroot `/app`. Pass `--answer` to change those.

```sh
lando init --recipe lamp --name=my-lamp-app --yes \
  --answer=php=8.1 \
  --answer=database=mysql:8.0 \
  --answer=composer=2.7.7 \
  --answer=webroot=/app/public
```

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

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
lando init --recipe lamp --name=my-lamp-mysql --yes --answer=php=8.1 --answer=database=mysql:8.0 --answer=composer=2.7.7 --answer=webroot=/app/public
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
