# LEMP

`lando init --recipe lemp` scaffolds Nginx, PHP, and MariaDB.

```sh
lando init --recipe lemp --name=my-lemp-app --yes
lando start
lando info
```

`lando start` prints the app URL. `lando info` repeats it. TODO: capture

`lando destroy -y` removes the app containers and volumes.

## 1. scaffold

```bash
lando init --recipe lemp --name=my-lemp-app --yes
```

## 2. start

```bash
lando start
```

## Cleanup

```bash
lando destroy -y
```
