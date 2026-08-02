# Service Trust Guide Coverage

This durable matrix owns the executable-guide paths for the service-trust feature wave. The guide coverage gate compares these paths with `docs/guides/INDEX.md` and verifies that every shipped guide exists.

## Guide Coverage

| User Stories | Feature | Guide Path |
|---|---|---|
| US-483–US-489, US-499 | Corporate CA and proxy injection | `docs/guides/config/corporate-network-trust.mdx` |
| US-490–US-492, US-500 | Certificate authoring, setup, and active CA selection | `docs/guides/subsystems/certificates-mkcert.mdx` |
| US-493, US-501 | Service boot scaffold and inherited-user preservation | `docs/guides/services/lando-boot-scaffold.mdx` |
| US-494, US-496 | Runtime CA environment and guide-pack closure | `docs/guides/config/corporate-network-trust.mdx` |
| US-495, US-498 | Certificate, network-trust, and proxy TLS diagnostics | `docs/guides/subsystems/doctor-walkthrough.mdx` |
| US-495 | Global-app certificate diagnostics | `docs/guides/global/doctor-walkthrough.mdx` |
| US-497 | Traefik HTTPS certificates | `docs/guides/subsystems/proxy-traefik.mdx` |
