# Netavark v2.0.0 rootless Aardvark user-bus patch

## Problem

Netavark v2.0.0 selects `systemd-run` whenever the host booted with systemd and the executable is on `PATH`. A rootless Lando runtime can satisfy both checks while its user D-Bus at `$XDG_RUNTIME_DIR/bus` is absent or unreachable. Aardvark DNS then fails to launch through `systemd-run` even though direct launch works.

## Patch

For rootless launches only, connect to `$XDG_RUNTIME_DIR/bus` before selecting `systemd-run`. Rootful behavior is unchanged. The bundle builder verifies the exact v2.0.0 `src/dns/aardvark.rs` SHA-256 before applying this unified diff with zero fuzz, then verifies the patched SHA-256.

- Source archive: `https://github.com/containers/netavark/archive/refs/tags/v2.0.0.tar.gz`
- Source archive SHA-256: `031aeeacc930382e8635d40a885798eff1da164dfcf9024b698f822e5995d9c8`
- Source file SHA-256: `0cc2090fc5124a68f69da60215a2b7a85023d1c495d2e5685e83ccf20ecd3823`
- Patched file SHA-256: `f01cefaf9a960ead28008b6bddb9d76811dbbb44b339e70c64fff66a5c3c969d`
- Upstream tracking: `https://github.com/containers/netavark/issues/TODO-LANDO-ROOTLESS-AARDVARK-USER-BUS`

## Removal condition

Remove the patch, hash checks, and build step when the pinned Netavark release contains an equivalent rootless user-bus reachability check and the managed-runtime integration test passes without this diff.
