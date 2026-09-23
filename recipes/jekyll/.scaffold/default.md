# Jekyll

`lando init --recipe jekyll` scaffolds a Jekyll site with a Ruby builder and an nginx sidecar.

```sh
lando init --recipe jekyll --name=my-jekyll --yes
cd my-jekyll
```

Jekyll declares no recipe options, so the only prompt is the app name and `--yes` answers it. Pass an undeclared `--answer` and init fails instead of quietly ignoring it.

The scaffold writes only `.lando.yml`. Park `builder` with compile tooling before the first start, install gems and scaffold the site, then restore the serve command. Open the **builder** URL from `lando info` after that restore.

For park, install, scaffold, build, browse, and cleanup steps, see [Run the Jekyll recipe](/guides/recipes/jekyll-workflow/).

When you are finished:

```sh
lando destroy -y
```
