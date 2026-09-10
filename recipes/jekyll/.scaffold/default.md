# Jekyll

`lando init --recipe jekyll` scaffolds a Jekyll site with a Ruby builder and an nginx front door.

```sh
lando init --recipe jekyll --name=my-jekyll --yes
lando start
lando info
```

Jekyll declares no recipe options, so the only prompt is the app name and `--yes` answers it. There is nothing to `--answer`. Pass one anyway and init fails instead of quietly ignoring it.

The scaffold writes only `.lando.yml`. It declares a `builder` service on `ruby:3.3` with no framework that runs `bundle exec jekyll serve --host 0.0.0.0 --port 4000` on port 4000, and a `web` service on `static:nginx` that mounts your app at `/app` and owns the route for `https://<app-name>.lndo.site` on both `http` and `https`. Ruby builds the site; nginx serves it.

Two tooling commands ship with the Landofile, both running inside the `builder` service:

```sh
lando jekyll build
lando bundle install
```

`lando jekyll` wraps `bundle exec jekyll`, so `lando jekyll serve` and `lando jekyll doctor` work the way the Jekyll docs say they do. Run `lando bundle install` first if your `Gemfile` changed.

`lando start` prints the app URL at `https://<app-name>.lndo.site`. `lando info` repeats it.

`lando destroy -y` removes the app containers and networks. Volumes stay unless you pass `--volumes` or `--purge`.

## 1. scaffold

```bash
lando init --recipe jekyll --name=my-jekyll-stack --yes
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
lando init --recipe jekyll --name=my-jekyll-stack --yes
```

## 5. inspect

```bash
lando app:config --format=json
```

## Cleanup

```bash
lando destroy -y
```
