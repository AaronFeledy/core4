# Data Helper Guide Coverage

This durable matrix owns the executable-guide paths for ephemeral data-helper reclamation. The guide coverage gate compares these paths with `docs/guides/INDEX.md` and verifies that every shipped guide exists.

## Guide Coverage

| User Stories | Feature | Guide Path |
|---|---|---|
| - | Data helper cleanup during app teardown | `docs/guides/tutorial/app-lifecycle.mdx` |
| - | Database import, export, snapshot, and restore helpers | `docs/guides/tooling/db-import-export.mdx` |

### Surface paths covered

- `container-runtime/src/stale-data-helpers.ts`
- `container-runtime/src/ephemeral-data-helpers.ts`
- `container-runtime/src/helper-owner.ts`
