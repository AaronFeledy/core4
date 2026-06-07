# Drupal

Spin up a Drupal 11 stack with PHP, MariaDB, Drush, and Composer. After the app
starts, scaffold the codebase with `lando composer create-project drupal/recommended-project .`.
The walkthrough below scaffolds the recipe, starts the app, and tears it back down.

## 1. scaffold

```bash
lando init --recipe drupal --name=my-drupal-app --yes
```

## 2. start

```bash
lando start
```

## 3. inspect

```
(generated at runtime)
```

## Cleanup

```bash
lando destroy -y
```
