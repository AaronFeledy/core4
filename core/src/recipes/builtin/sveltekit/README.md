# sveltekit

Use this recipe for a SvelteKit frontend with an optional database. The adapter
picker records your choice in `SVELTEKIT_ADAPTER`; it does not install or
configure the adapter package.

## Host prerequisites

- Lando v4 alpha install with `provider-lando` or `provider-docker`.

## Generated services

- `web`: `node:lts` or `node:22` (prompt: `node`), exposes Vite's default
  port 5173 with `SVELTEKIT_ADAPTER` env hint.
- `database`: `postgres` or `mariadb` when prompt `database` is not `none`.

## Generated tooling

- `lando svelte …`: Svelte CLI through `npx svelte-kit`.
- `lando npm …`: npm inside the web service.

## Alpha limitations

- Adapter picker is informational: it sets a `SVELTEKIT_ADAPTER` env hint but
  does not install or configure `@sveltejs/adapter-*`. Users wire the adapter
  through the generated tooling.
- A dedicated SvelteKit service type is deferred to Beta.
