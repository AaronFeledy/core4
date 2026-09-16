# Empty

`lando init --recipe empty` scaffolds a blank, valid Landofile. You declare the stack yourself.

```sh
lando init --recipe empty --name=my-app --yes
```

The scaffold writes only `.lando.yml`, and that file holds exactly three keys: the app `name`, `runtime: 4`, and a `recipe` object recording the `empty` recipe's identity, version, producer, and empty options. No services, no tooling, no routes. Pick it when none of the framework recipes match what you're building, or when you'd rather type every line of the Landofile than delete someone else's.

Empty declares no recipe options. The only prompt is the app name, which `--name` answers, so `--yes` has nothing left to fill in. Pass an `--answer` anyway and init fails instead of quietly ignoring it.

Because the Landofile declares no services, there's nothing to start yet. `lando start` has no work to do until you add one. That's the point: init leaves a message telling you to edit the generated `.lando.yml` and declare services for your stack.

Add a `services` block by hand, leaving the generated name, runtime, and recipe metadata in place. This is yours to write, not something init produced:

```yaml
services:
  app:
    type: "node:22"
    primary: true
```

Then `lando start` and `lando info` behave like they do for any other app.

## 1. scaffold

```bash
lando init --recipe empty --name=my-app --yes
```

## 2. inspect

```bash
lando app:config --format=json
```
