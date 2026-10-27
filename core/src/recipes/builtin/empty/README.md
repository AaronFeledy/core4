# empty

Use this recipe when you want to write your own Landofile or add another recipe
later. It creates a blank Landofile with no services or tooling. Add a
`services:` block before running `lando start`.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.

## Generated services

- *(none)*: the Landofile omits the `services:` key entirely. Add a
  `services:` block manually before running `lando start`.

## Alpha limitations

- The recipe writes a single empty Landofile. No tooling, no env scaffold, no
  README placeholder.
