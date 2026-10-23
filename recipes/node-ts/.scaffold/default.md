# Start a Node app with environment expressions

`lando init --recipe node-ts` scaffolds a canonical `.lando.yml` with one Node service. The Landofile adapts to your environment when the app loads. There are no options beyond the app name.

```sh
lando init --recipe node-ts --name=my-node-ts --yes
cd my-node-ts
lando start
lando info
```

The generated Landofile reads two environment variables at load time:

| Variable | Used for | Fallback |
| --- | --- | --- |
| `LANDO_NODE_VERSION` | the Node image tag for the `web` service | `24` |
| `NODE_ENV` | `NODE_ENV` inside the `web` service | `development` |

The default image is `node:24`, so changes to the upstream `node:lts` tag do
not move this app to another major version. `LANDO_NODE_VERSION` selects an
image tag directly; this recipe does not use Lando's Node service type.

If you choose a Node 26 image, it will not include Yarn or Corepack. To use
Node-service features such as `globals` package installation, replace the
`web` service's `image:` field with an explicit type such as `type: node:26`.
That type selects the version directly instead of reading `LANDO_NODE_VERSION`.

Set either environment variable in your host shell before `lando start`. The Landofile reads it on the next load; you do not need a second config file.

```sh
LANDO_NODE_VERSION=22 lando start
```

The `web` service also carries the primary route, so `lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

Open the generated Landofile once the scaffold lands. It is short on purpose: one service, one route, two environment lookups. Copy the pattern when your own app needs config that changes per machine or per CI job.

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
