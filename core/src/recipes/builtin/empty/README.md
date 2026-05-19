# empty

Blank Landofile starter — picks no services and adds no tooling. Use this
when you want to drive the Landofile shape entirely by hand or layer on a
non-canonical recipe later.

## Generated services

- *(none)* — the Landofile omits the `services:` key entirely. Add a
  `services:` block manually before running `lando start`.

## Alpha limitations

- The recipe writes a single empty Landofile. No tooling, no env scaffold, no
  README placeholder.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.
