# Empty

Create a blank, valid Landofile and declare your own stack. The recipe adds
no services, tooling, or routes; add a service before trying to start the app.

Before you begin, install Lando and complete provider setup. For a new app,
run the initialization command from the directory that will contain it. If this
README is already in a generated app, skip the `lando init` and `cd` lines below. Run
the remaining app commands from that directory.

```sh
lando init --recipe empty --name=my-app --yes
cd my-app
```

The scaffold writes only `.lando.yml`, and that file holds exactly three keys: the app `name`, `runtime: 4`, and a `recipe` object recording the `empty` recipe's identity, version, producer, and empty options. No services, no tooling, no routes. Use it when you want to choose the services yourself rather than start from a framework recipe.

Empty declares no recipe options. The only prompt is the app name, which `--name` answers, so `--yes` has nothing left to fill in. Pass an `--answer` anyway and init fails instead of quietly ignoring it.

Because the Landofile declares no services, there's nothing to start yet. `lando start` has no work to do until you add one. Initialization tells you to edit the generated `.lando.yml` and declare services for your stack.

In the app directory, edit `.lando.yml` and add a `services` block. Keep the generated name, runtime, and recipe metadata in place. This is yours to write, not something init produced:

```yaml
services:
  app:
    type: "node:22"
    primary: true
```

From your app directory, run `lando start`, then `lando info` to inspect the service.

## 1. scaffold

```bash
lando init --recipe empty --name=my-app --yes
```

## 2. inspect

```bash
lando app:config --format=json
```
