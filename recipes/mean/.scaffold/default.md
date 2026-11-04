# MEAN

Create and run an Express starter app with Node, MongoDB, npm tooling, and
optional Redis. Express is the fixed framework; this recipe has no framework
picker.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe mean --name=my-mean-app --yes
cd my-mean-app
lando start
lando info
```

The named init creates `my-mean-app/`. Change into it before app commands. `--yes` uses Node lts, MongoDB, and no Redis. Pass `--answer` to change those.

To choose a different stack, use this initialization command instead of the
default one above. Run it from the parent directory, not inside the app:

```sh
lando init --recipe mean --name=my-mean-app --yes \
  --answer=node=22 \
  --answer=redis=true
```

`lando start` installs the Express dependencies in `api` before serving the scaffold on port `3000`. The scaffold reads `PORT`, which Lando derives from `port:` (default `3000`). An unequal or malformed authored `environment.PORT` fails planning; change `port:` instead. This recipe supplies a server command; the Node preset alone stays idle. Open the URL `lando info` prints. `GET /` answers `Hello from Lando`.

Use `lando npm` and `lando node` to run tooling inside `api`:

```sh
lando npm --version
lando node --version
```

`lando destroy -y` removes the app containers and networks and keeps its named volumes. See [Keep data across stop, restart, and destroy](https://aaronfeledy.github.io/core4/guides/tutorial/app-lifecycle/#keep-data-across-stop-restart-and-destroy).

## 1. scaffold

```bash
lando init --recipe mean --name=my-mean-app --yes
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
