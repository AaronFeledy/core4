# PRD: Alpha-08: Proxy host-port fallback

## Introduction

Post Alpha 1 exit (after US-600). Traefik host ports today are hardcoded `127.0.0.1:38080` / `38443`, with `80`/`443` as a separate acquisition hop. A second Lando on shared localhost (another WSL distro) collides on that last pair. Developers expect familiar ports: no port in the URL on `80`/`443`, then `8080`/`8443`, not a Lando-only high band.

This PRD sequences the change. Durable contract is §10.2.3. Do not edit US-592..US-600. Do not edit `spec/ROADMAP.md`.

## Implementation plan

Execute in priority order after US-600.

1. **Contract (US-601).** §10.2.3 lists, persist, Traefik publishes the chosen pair, fail closed, doctor/start use persisted ports, and `routing:` overrides at global and Landofile scope.
2. **Acquisition (US-602).** Widen port-acquisition beyond `80|38080` / `443|38443`. TCP bind via `runProbe`. Persist and reuse the chosen pair. First free per protocol from the merged lists (defaults → global `routing:` → env → Landofile `routing:`). Fail with a tagged error if a list is exhausted or an app pins ports that do not match a running Traefik.
3. **Publish (US-603).** Global Traefik `PortBindings` are the chosen host ports → container `80`/`443`. Do not always bind `38080`/`38443`. Socket-helper hops to the chosen high port when `80`/`443` need a helper.
4. **Surfaces (US-604).** `lando info` omits `:80`/`:443`. Doctor leftover probes and start-path `EADDRINUSE` remap use persisted ports. Occupied-hop must not treat another Lando's healthy Traefik as leftover `rootlessport`.

## Source References

- [`spec/11-subsystems.md`](../11-subsystems.md) §10.2.3
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.4 Landofile `routing:`, §7.5 global `routing:`
- Lando 3 defaults: `proxyHttpPort` `80`, `proxyHttpsPort` `443`, fallbacks `8000,8080,8888,8008` / `444,4433,4444,4443`, persist `proxyCache`, HTTP-scan (v4 replaces with TCP bind)
- DDEV documented alternate pair: `8080` / `8443`
- Current v4: `plugins/proxy-traefik/src/ports.ts`, `port-acquisition.ts`, `port-acquisition-state.ts`, `global-services/traefik.ts`

## User Stories

### US-601: Spec contract for familiar proxy host-port fallback

**Description:** As a maintainer, §10.2.3 is the durable contract for Traefik host-port acquisition before any implementation.

**Acceptance Criteria:**

- [ ] US-601 edits `spec/11-subsystems.md` §10.2.3. That section states the HTTP list `80, 8080, 8000, 8888, 8008, 38080`, the HTTPS list `443, 8443, 4443, 4433, 4444, 444, 38443`, TCP bind (not HTTP GET), persist and reuse, Traefik publishes the chosen pair, fail closed, and doctor/start use persisted ports.
- [ ] Users can override preferred ports, fallback arrays, and bind address globally (`routing:` in §7.5) and per app (Landofile `routing:` in §7.4). App-level pins are a request against the one host Traefik, not a second proxy.
- [ ] `38080`/`38443` are last-resort, not the degraded default.
- [ ] Topic lookup in `spec/README.md` names §10.2.3.
- [ ] This story does not change acquisition, Traefik publish, doctor, or start code.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** Implementing acquisition or Traefik publish before this contract. Leaving `38080`/`38443` as the only high-port fallback in the spec.

**Verification:** §10.2.3 exists with the lists and behaviors above. `prd.json` IDs US-601..US-604, unique priorities 10..13, `passes: false`, no `dependsOn` field.

### US-602: Acquire and persist Traefik host ports

**Description:** As a user, Lando picks the first free familiar host ports and remembers them.

**Acceptance Criteria:**

- [ ] Requires US-601. Do not start this story before §10.2.3 exists.
- [ ] HTTP try order defaults to `80, 8080, 8000, 8888, 8008, 38080`. HTTPS defaults to `443, 8443, 4443, 4433, 4444, 444, 38443`. First TCP-bind success per protocol wins.
- [ ] Merged lists are compiled defaults → global `routing:` → env → Landofile `routing:`. `httpPort`/`httpsPort` replace the preferred candidate; fallback arrays replace the rest of that protocol's list.
- [ ] Chosen `{ http, https }` is persisted and reused when preferred config still matches and the proxy still owns those binds.
- [ ] If Traefik is already running and this app set `httpPort`/`httpsPort` that do not match the running pair, fail with a tagged error naming the running ports.
- [ ] Acquisition state is not limited to `80|38080` and `443|38443`.
- [ ] If a protocol's list is exhausted, proxy start fails with a tagged error naming the tried ports. Do not disable the proxy silently.
- [ ] Bind probes use `@lando/sdk/probe` `runProbe`. No hand-rolled `Effect.retry` / `Schedule` loops.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** HTTP GET "open port" scans. Always binding `38080`. Silent proxy-off when the list is full.

**Verification:** Unit tests for try order, persist/reuse, exhausted-list tagged error, and TCP-bind vs HTTP-GET. `bun test` with a positive count; typecheck; lint.

### US-603: Traefik publishes the chosen host ports

**Description:** As a user, Traefik listens on the acquired host ports, not on a hidden extra `38080`/`38443` pair.

**Acceptance Criteria:**

- [ ] Requires US-602.
- [ ] Global Traefik `PortBindings` map chosen HTTP→container `80` and chosen HTTPS→container `443` on `127.0.0.1`.
- [ ] Traefik MUST NOT always publish `38080`/`38443` in addition to the chosen pair.
- [ ] Socket-helper / occupied-hop, when used, target the chosen high ports from the same lists.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** Keeping a permanent `38080` publish so a second WSL Lando still collides. Helper still hopping to hardcoded `38080`.

**Verification:** Traefik global-service tests assert PortBindings equal the persisted pair. Helper tests hop to the chosen high port.

### US-604: Info, doctor, and start use persisted proxy ports

**Description:** As a user, URLs and diagnostics follow the ports Lando actually bound.

**Acceptance Criteria:**

- [ ] Requires US-603.
- [ ] `lando info` and post-start messages omit `:80` / `:443` and include the port when non-default.
- [ ] Doctor leftover-proxy checks probe the persisted chosen ports (not only `38080`/`38443`).
- [ ] Start-path `EADDRINUSE` remap uses the persisted chosen ports.
- [ ] Occupied-hop / leftover classification MUST NOT treat another Lando instance's healthy Traefik as leftover `rootlessport`.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** Doctor silent on a foreign healthy Traefik that still blocks start. Error copy that always says `38080`/`38443`.

**Verification:** Doctor and start remediation tests with a non-default chosen pair. Info URL tests for `80` (no port) vs `8080` (port shown).
