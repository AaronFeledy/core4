# PRD: L3P-03 — Service catalog completion

## Introduction

The §6.12.1 catalog names service types the runtime registry does not ship: `rabbitmq`, `minio`, `localstack`, `mailhog` (deprecated-but-registered), and an app-scoped `mailpit` (today mailpit exists only as a global-app contribution). The catalog amendment (US-561) additionally adds the L3-parity types `tomcat`, `varnish`, `dotnet`, `mssql`, and `phpmyadmin`. This PRD implements all ten in `plugins/service-lando/src/services/`, each satisfying the full §6.12.1 per-service-type implementation checklist and shipping a `docs/guides/services/<type>.mdx` executable guide in the same story.

## Source References

- [`spec/06-services.md`](../06-services.md) §6.12.1 catalog rows + implementation checklist, §6.12.3 membership rules, §6.12.4 creds contract (`mssql`, `phpmyadmin` wiring), §6.11.3 service-type tooling.
- [`spec/16-deprecation-and-surface-evolution.md`](../16-deprecation-and-surface-evolution.md) §18.4 `deprecation-used` event (mailhog).
- [`spec/18-global-app.md`](../18-global-app.md) §20.11.1 global Mailpit (unchanged; the app-scoped type is additive).
- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) executable-guide requirements; guide-coverage gate.

## User Stories

### US-566: `rabbitmq`, `minio`, `localstack`

**Description:** As a user, I can declare `type: rabbitmq`, `type: minio`, or `type: localstack` services exactly as the catalog promises (management/console routes, persistence, bucket init).

**Acceptance Criteria:**

- [ ] Three new service types registered per their §6.12.1 rows (rabbitmq 3/4 + management UI route + persistent volume; minio + console route + bucket init; localstack).
- [ ] Each passes `runServiceCompositionContract`, declares `base: lando`, ships tooling/healthchecks appropriate to the row, and publishes its config schema under `@lando/sdk/schema/services/<type>` with snapshot updates.
- [ ] `docs/guides/services/rabbitmq.mdx`, `minio.mdx`, `localstack.mdx` executable guides; INDEX + coverage gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-567: App-scoped `mailpit` + deprecated `mailhog`

**Description:** As a user, I can declare an app-scoped `type: mailpit` service (SMTP capture + web UI route), and legacy Landofiles using `type: mailhog` still validate while emitting the §18.4 deprecation event.

**Acceptance Criteria:**

- [ ] `mailpit` ships as an app-scoped service type per its catalog row without disturbing the existing global-app Mailpit contribution; both can coexist in one install.
- [ ] `mailhog` registers as a working compatibility type whose use emits `deprecation-used` with the §18 notice (since v4.2.0, removal v5.0.0, replacement `mailpit`); renderer dedupes the warning per process; `lando doctor` reports its use.
- [ ] Both pass the composition contract and publish schemas + snapshots.
- [ ] `docs/guides/services/mailpit.mdx` guide (app-scoped capture; contrast with global capture) with a hidden mailhog-deprecation scenario asserting the warning; gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-568: `tomcat` + `varnish`

**Description:** As a user, I can run a Tomcat servlet container and a Varnish HTTP cache fronting a named backend, per the amended catalog rows.

**Acceptance Criteria:**

- [ ] `tomcat` (9/10/11): webapp deployment mount, TLS via `lando.certs`, sensible default route; composition contract + schema snapshot.
- [ ] `varnish` (6/7): required `backend: <service>` config validated against app services at plan time (unknown backend fails closed with remediation), VCL override mount, backend healthcheck gating per §6.12.1 row.
- [ ] Proxy/route integration works for both (varnish routable in front of its backend).
- [ ] `docs/guides/services/tomcat.mdx` and `varnish.mdx` executable guides; gates green.
- [ ] Tests pass; typecheck passes; lint passes.

### US-569: `dotnet`, `mssql`, `phpmyadmin`

**Description:** As a user, I can run .NET apps, SQL Server, and phpMyAdmin per the amended catalog rows, completing the L3 service set.

**Acceptance Criteria:**

- [ ] `dotnet` (8.0/9.0): SDK + ASP.NET runtime, `command:` dev-server support, NuGet cache mount; composition contract + schema snapshot.
- [ ] `mssql` (2019/2022): §6.12.4 creds opt-in with `rootPassword` mapped to `SA_PASSWORD`, healthcheck, persistent volume, `sqlcmd` tooling; on non-amd64 hosts without emulation capability the type fails closed at plan time with the spec'd remediation (capability check, not provider runtime error).
- [ ] `phpmyadmin` (5/latest): auto-wires to all MySQL-family services via the §6.12.4 cross-service creds scope; proxy route; zero-config in the single-DB case; explicit `hosts:` override supported.
- [ ] `docs/guides/services/dotnet.mdx`, `mssql.mdx`, `phpmyadmin.mdx` executable guides (mssql guide notes the platform constraint); gates green.
- [ ] Tests pass; typecheck passes; lint passes.

## Guide Coverage

| User Stories | Feature | Guide Path |
|---|---|---|
| US-566 | rabbitmq service type | `docs/guides/services/rabbitmq.mdx` |
| US-566 | minio service type | `docs/guides/services/minio.mdx` |
| US-566 | localstack service type | `docs/guides/services/localstack.mdx` |
| US-567 | app-scoped mailpit + deprecated mailhog | `docs/guides/services/mailpit.mdx` |
