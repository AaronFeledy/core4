# LEMP

Spin up a classic Nginx, PHP, and MariaDB stack for a traditional PHP application.
The walkthrough below scaffolds the recipe, starts the app, and tears it back down.

## 1. scaffold

```bash
lando init --recipe lemp --name=my-lemp-app --yes
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
