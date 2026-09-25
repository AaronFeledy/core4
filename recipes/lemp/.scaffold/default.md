# LEMP

`lando init --recipe lemp` scaffolds Nginx, PHP, and MariaDB.

```sh
lando init --recipe lemp --name=my-lemp-app --yes
lando start
lando info
```

`--yes` uses PHP 8.4. Pass `--answer` to change that. PHP 8.6 is a valid `--answer=php=8.6`.

`lando start` prints the app URL. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

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
