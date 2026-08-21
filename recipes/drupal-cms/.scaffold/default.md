# Drupal CMS

`lando init --recipe drupal-cms` scaffolds PHP, MariaDB, Drush, and Composer.

```sh
lando init --recipe drupal-cms --name=my-drupal-cms-app --yes
lando start
lando info
```

`lando start` prints the app URL(s). `lando info` repeats them. TODO: capture

After start, scaffold the codebase, then install:

```sh
lando drupal-cms-scaffold
lando drupal-cms-install
```

`lando destroy -y` removes the app containers and volumes.

## 1. scaffold

```bash
lando init --recipe drupal-cms --name=my-drupal-cms-app --yes
```

## 2. start

```bash
lando start
```

## Cleanup

```bash
lando destroy -y
```
