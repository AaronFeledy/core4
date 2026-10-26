# node-ts

Use this recipe to create a `.lando.yml` for a Node app. The generated
Landofile reads environment expressions for the Node image and `NODE_ENV`,
so you can change either value without regenerating the file. Add tooling
and storage to the Landofile as your app needs them.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.

## Generated services

- `web`: `image: node:<LANDO_NODE_VERSION ?? "24">`

The Node major version is resolved from `LANDO_NODE_VERSION` at
`LandofileService` load time, with `24` as the default. `NODE_ENV`
defaults to `development` and can be overridden the same way.

## Alpha limitations

- No tooling or storage scaffolding. Edit `.lando.yml` to add the
  rest of your stack.
- Host environment values are resolved when Lando loads the
  generated Landofile.
