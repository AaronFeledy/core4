# Drupal CMS

`lando init --recipe drupal-cms` scaffolds PHP, MariaDB, Drush, and Composer.

```sh
lando init --recipe drupal-cms --name=my-drupal-cms-app --yes
lando start
lando info
```

`lando start` prints the app URL(s). `lando info` repeats them.

After start, scaffold the codebase, then install:

```sh
lando drupal-cms-scaffold
lando drupal-cms-install
```

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe drupal-cms --name=my-drupal-cms-app --yes
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
