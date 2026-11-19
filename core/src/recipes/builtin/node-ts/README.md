# node-ts

Use this recipe to create a `.lando.yml` for a Node app. The generated
Landofile reads environment expressions for the Node version and `NODE_ENV`,
so you can change either value without regenerating the file. Add tooling
and storage to the Landofile as your app needs them.

## Host prerequisites

- Lando v4 install with `provider-lando` or `provider-docker`.

## Generated services

- `web`: `type: node:<LANDO_NODE_VERSION ?? "lts">`

The Node version is resolved from `LANDO_NODE_VERSION` at
`LandofileService` load time. It defaults to `lts`, Lando's current Node
LTS major, and accepts `lts`, `22`, `24`, or `26`. `NODE_ENV`
defaults to `development` and can be overridden the same way.

## Limitations

- No tooling or storage scaffolding. Edit `.lando.yml` to add the
  rest of your stack.
- Host environment values are resolved when Lando loads the
  generated Landofile.
