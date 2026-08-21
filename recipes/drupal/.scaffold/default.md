# Drupal

`lando init --recipe drupal` scaffolds PHP, MariaDB, Drush, and Composer.

```sh
lando init --recipe drupal --name=my-drupal-app --yes
lando start
lando info
```

`lando start` prints the app URL. `lando info` repeats it.

After start, scaffold the pinned Drupal 11 project and project-local Drush. The scaffold is a retryable stage-then-commit, so a flaky Composer fetch does not leave you half-installed:

```sh
lando drupal-scaffold
lando drush --version
```

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe drupal --name=my-drupal-app --yes
```

## 2. start

```bash
lando start
```

## 3. scaffold-drupal

```bash
lando drupal-scaffold
```

## 4. check-drush

```bash
lando drush --version
```

## Cleanup

```bash
lando destroy -y
```
