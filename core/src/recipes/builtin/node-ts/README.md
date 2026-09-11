# node-ts

Scaffolds a canonical `.lando.yml` for a Node app. The generated
Landofile uses environment expressions for the Node image and
`NODE_ENV`, so you can change either value without regenerating it.

## Generated services

- `web`: `image: node:<LANDO_NODE_VERSION ?? "lts">`

The Node major version is resolved from `LANDO_NODE_VERSION` at
`LandofileService` load time, with `lts` as the default. `NODE_ENV`
defaults to `development` and can be overridden the same way.

## Alpha limitations

- No tooling or storage scaffolding. Edit `.lando.yml` to add the
  rest of your stack.
- Host environment values are resolved when Lando loads the
  generated Landofile.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
