# Drupal

Spin up a Drupal 11 stack with PHP, MariaDB, Drush, and Composer. After the app
starts, use `lando drupal-scaffold` to install the pinned Drupal 11 project and
project-local Drush through a retryable stage-then-commit workflow. The walkthrough
below runs that scaffold, verifies its outputs, checks Drush, and tears the app down.

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
