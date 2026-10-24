# Start a Node app with environment expressions

Create a `.lando.yml` with one Node service whose image and `NODE_ENV` are
resolved from your environment when Lando loads the app. The recipe has no
options beyond the app name.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe node-ts --name=my-node-ts --yes
cd my-node-ts
lando start
lando info
```

The generated Landofile reads two environment variables at load time:

| Variable | Used for | Fallback |
| --- | --- | --- |
| `LANDO_NODE_VERSION` | the Node image tag for the `web` service | `lts` |
| `NODE_ENV` | `NODE_ENV` inside the `web` service | `development` |

Set either one in your shell before `lando start` and the app picks it up on the next load. You do not need to regenerate the Landofile or add another config file.

```sh
LANDO_NODE_VERSION=22 lando start
```

The `web` service also carries the primary route, so `lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

Open the generated Landofile once the scaffold lands. It is short on purpose: one service, one route, two environment lookups. Copy the pattern when your own app needs config that changes between machines.

To see what Lando resolved from it without starting anything, print the loaded config:

```sh
lando app:config --format=json
```

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe node-ts --name=my-node-ts --yes
```

## 2. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
