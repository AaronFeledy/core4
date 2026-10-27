import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type BindMountPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { CREATE_CONFIG_LABEL, createConfigFingerprint } from "../src/create-fingerprint.ts";
import { prepareFileModeMounts } from "../src/file-mode-mounts.ts";
import { bindMountStrings, commonContainerLabels, containerHostConfigFragment } from "../src/plan.ts";
import { bringUpRecreateReasons } from "../src/podman/bring-up-recreate.ts";
import { renderCompose } from "../src/podman/compose.ts";

const ctx = { providerId: "podman", remediation: "Retry.", env: {} };

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-file-mode-"));
  const source = join(root, "php.ini");
  await writeFile(source, "memory_limit=512M\n", { mode: 0o600 });
  const mount: BindMountPlan = {
    type: "bind",
    source,
    target: PortablePath.make("/config:ro"),
    readOnly: true,
    realization: "passthrough",
    createHostPath: false,
    fileMode: 0o440,
    origin: "authored",
    relativeTo: "app",
  };
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-10-26T00:00:00Z"),
    source: "file-mode-test",
    runtime: 4 as const,
  };
  const service: ServicePlan = {
    name: ServiceName.make("web"),
    type: "web",
    provider: ProviderId.make("podman"),
    primary: true,
    artifact: { kind: "ref", ref: "alpine:3.21" },
    environment: {},
    mounts: [mount],
    endpoints: [],
    hostAliases: [],
    routes: [],
    dependsOn: [],
    extensions: {},
    metadata,
  };
  const plan: AppPlan = {
    valueModel: 1,
    id: AppId.make("file-mode"),
    name: "file-mode",
    slug: "file-mode",
    root: AbsolutePath.make(root),
    provider: service.provider,
    services: { [service.name]: service },
    routes: [],
    stores: [],
    fileSync: [],
    extensions: {},
    metadata,
  };
  const prepare = (mode = 0o440) =>
    prepareFileModeMounts(
      {
        ...plan,
        services: {
          [service.name]: { ...service, mounts: [{ ...mount, fileMode: mode }] },
        },
      },
      ctx,
      join(root, "data"),
    );
  const preparedService = (prepared: AppPlan) => {
    const value = prepared.services[service.name];
    if (value === undefined) throw new TypeError("Missing fixture service");
    return value;
  };
  const copy = (prepared: AppPlan) => {
    const value = preparedService(prepared).mounts[0];
    if (value?.type !== "bind") throw new TypeError("Missing fixture bind");
    return value.source;
  };
  const fingerprint = (prepared: AppPlan) => createConfigFingerprint(prepared, preparedService(prepared), {});
  return {
    root,
    source,
    mount,
    service,
    plan,
    prepare,
    copy,
    fingerprint,
    preparedService,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
};

describe("planned config binds", () => {
  test("omits colon targets from short bind strings", async () => {
    // Given
    await using f = await fixture();
    const prepared = await Effect.runPromise(f.prepare());
    // When
    const binds = bindMountStrings(prepared, f.preparedService(prepared));
    // Then
    expect(binds).toEqual([]);
  });

  test("uses only planned sources and targets, ignoring config extensions", async () => {
    // Given
    await using f = await fixture();
    const prepared = await Effect.runPromise(f.prepare());
    const service = {
      ...f.preparedService(prepared),
      extensions: { compose: { configs: [{ source: "ignored", target: "/extra" }] } },
    };
    // When
    const host = containerHostConfigFragment(prepared, service);
    const compose = renderCompose({ ...prepared, services: { [service.name]: service } }, ctx);
    // Then
    expect(host.Mounts).toEqual([
      {
        Type: "bind",
        Source: f.copy(prepared),
        Target: "/config:ro",
        ReadOnly: true,
        BindOptions: { CreateMountpoint: false },
      },
    ]);
    expect(compose).toContain(`source: "${f.copy(prepared)}"`);
    expect(compose).not.toContain("/extra");
  });

  test("prepares a private read-only copy without chmodding the source", async () => {
    // Given
    await using f = await fixture();
    // When
    const prepared = await Effect.runPromise(f.prepare());
    // Then
    expect(f.copy(prepared)).not.toBe(f.source);
    expect((await stat(f.copy(prepared))).mode & 0o7777).toBe(0o440);
    expect((await stat(f.source)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.root, "data", "file-mode-mounts"))).mode & 0o777).toBe(0o700);
  });

  test("refuses synchronous file-mode rendering before provider preparation", async () => {
    // Given
    await using f = await fixture();
    // When / Then
    expect(() => containerHostConfigFragment(f.plan, f.service)).toThrow(
      "File-mode binds require provider preparation",
    );
    expect(() => renderCompose(f.plan, ctx)).toThrow("File-mode binds require provider preparation");
  });

  test("publishes a new immutable copy when source content changes", async () => {
    // Given
    await using f = await fixture();
    const first = await Effect.runPromise(f.prepare());
    await writeFile(f.source, "memory_limit=256M\n");
    // When
    const second = await Effect.runPromise(f.prepare());
    // Then
    expect(f.copy(second)).not.toBe(f.copy(first));
    expect(await Bun.file(f.copy(first)).text()).toBe("memory_limit=512M\n");
    expect(await Bun.file(f.copy(second)).text()).toBe("memory_limit=256M\n");
    expect(f.fingerprint(second)).not.toBe(f.fingerprint(first));
  });

  test("renders prepared copies as strict read-only binds", async () => {
    // Given
    await using f = await fixture();
    const prepared = await Effect.runPromise(f.prepare());
    // When
    const host = containerHostConfigFragment(prepared, f.preparedService(prepared));
    // Then
    expect(host.Mounts).toEqual([
      {
        Type: "bind",
        Source: f.copy(prepared),
        Target: "/config:ro",
        ReadOnly: true,
        BindOptions: { CreateMountpoint: false },
      },
    ]);
  });

  test("reuses content and mode identities across concurrent preparation", async () => {
    // Given
    await using f = await fixture();
    const logical = f.fingerprint(f.plan);
    // When
    const [first, second] = await Promise.all([
      Effect.runPromise(f.prepare()),
      Effect.runPromise(f.prepare()),
    ]);
    // Then
    expect(f.copy(second)).toBe(f.copy(first));
    expect(f.fingerprint(second)).toBe(f.fingerprint(first));
    expect(f.fingerprint(first)).toBe(logical);
  });

  test("changes fingerprint and copy path when mode changes", async () => {
    // Given
    await using f = await fixture();
    const first = await Effect.runPromise(f.prepare());
    // When
    const second = await Effect.runPromise(f.prepare(0o444));
    // Then
    expect(f.copy(second)).not.toBe(f.copy(first));
    expect(f.fingerprint(second)).not.toBe(f.fingerprint(first));
    expect((await stat(f.copy(first))).mode & 0o7777).toBe(0o440);
  });

  test("keeps fingerprints logical across different private-copy directories", async () => {
    // Given
    await using f = await fixture();
    const first = await Effect.runPromise(f.prepare());
    // When
    const second = await Effect.runPromise(prepareFileModeMounts(f.plan, ctx, join(f.root, "other-data")));
    // Then
    expect(f.copy(second)).not.toBe(f.copy(first));
    expect(f.fingerprint(second)).toBe(f.fingerprint(first));
  });

  test("ignores origin and relativeTo in the logical fingerprint", async () => {
    // Given
    await using f = await fixture();
    const before = f.fingerprint(f.plan);
    const { relativeTo: _relativeTo, ...absoluteMount } = f.mount;
    const updated = {
      ...f.service,
      mounts: [{ ...absoluteMount, origin: "derived" as const }],
    };
    // When
    const after = createConfigFingerprint(f.plan, updated, {});
    // Then
    expect(after).toBe(before);
  });

  test("ignores staging paths during recreate checks but detects content changes", async () => {
    // Given
    await using f = await fixture();
    const first = await Effect.runPromise(f.prepare());
    const inspected = {
      bindSources: { [f.mount.target]: f.copy(first) },
      labels: commonContainerLabels(first, f.preparedService(first)),
    };
    expect(inspected.labels[CREATE_CONFIG_LABEL]).toBeDefined();
    expect(bringUpRecreateReasons(f.plan, f.service, inspected, { skipAbsentFields: true })).toEqual([]);
    await writeFile(f.source, "changed\n");
    // When
    const reasons = bringUpRecreateReasons(f.plan, f.service, inspected, { skipAbsentFields: true });
    // Then
    expect(reasons).toEqual(["config"]);
  });
});
