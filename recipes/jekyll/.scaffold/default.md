# Jekyll

`lando init --recipe jekyll` scaffolds a Jekyll site with a Ruby builder and an nginx sidecar.

```sh
lando init --recipe jekyll --name=my-jekyll --yes
cd my-jekyll
```

Jekyll declares no recipe options, so the only prompt is the app name and `--yes` answers it. Pass an undeclared `--answer` and init fails instead of quietly ignoring it.

The scaffold writes only `.lando.yml`. Its `builder` service carries a build step that installs `build-essential`, `libssl-dev`, and `zlib1g-dev` on the first start, so native gems compile without extra apt setup. Park `builder` on `sleep infinity` before the first start, install gems and scaffold the site, then restore the serve command. Open the **builder** URL from `lando info` after that restore. The app hostname URL (`web`) serves `_site/` through nginx once a build has written it.

For park, install, scaffold, build, browse, and cleanup steps, see [Run the Jekyll recipe](/guides/recipes/jekyll-workflow/).

When you are finished:

```sh
lando destroy -y
```
