# LAMP

`lando init --recipe lamp` scaffolds Apache, PHP, and MariaDB.

```sh
lando init --recipe lamp --name=my-lamp-app --yes
lando start
lando info
```

`lando start` prints the app URL. `lando info` repeats it. TODO: capture

`lando destroy -y` removes the app containers and volumes.

## 1. scaffold

```bash
lando init --recipe lamp --name=my-lamp-app --yes
```

## 2. start

```bash
lando start
```

## Cleanup

```bash
lando destroy -y
```
