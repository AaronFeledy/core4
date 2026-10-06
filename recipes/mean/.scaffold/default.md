# MEAN

`lando init --recipe mean` scaffolds Node, MongoDB, optional Redis, npm tooling, and an Express-style default scaffold. There is no framework picker.

```sh
lando init --recipe mean --name=my-mean-app --yes
cd my-mean-app
lando start
lando info
```

The named init creates `my-mean-app/`. Change into it before app commands. `--yes` uses Node lts, MongoDB, and no Redis. Pass `--answer` to change those.

```sh
lando init --recipe mean --name=my-mean-app --yes \
  --answer=node=22 \
  --answer=redis=true
```

`lando start` installs the Express dependencies in `api` before serving the scaffold on port `3000`. Open the URL `lando info` prints. `GET /` answers `Hello from Lando` without a separate install command or Landofile edit.

Use `lando npm` and `lando node` to run tooling inside `api`:

```sh
lando npm --version
lando node --version
```

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe mean --name=my-mean-redis --yes
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
lando init --recipe mean --name=my-mean-redis --yes --answer=node=22 --answer=redis=true
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
