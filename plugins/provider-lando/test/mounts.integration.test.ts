import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { bringUp, exec, makePodmanApiClient, pullImage } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
  landoNetworkingPlan,
  landoOwnedNetworkNames,
} from "@lando/sdk/schema";
import { DateTime, Effect, Schema } from "effect";

const socket = resolveLiveProviderSocket()?.socketPath;
const ContainerInspect = Schema.Struct({
  HostConfig: Schema.Struct({ Tmpfs: Schema.Record(Schema.String, Schema.String) }),
  Mounts: Schema.Array(
    Schema.Struct({
      Type: Schema.String,
      Destination: Schema.String,
      Source: Schema.optionalKey(Schema.String),
      RW: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

const mountTable = (text: string) =>
  new Map(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const [mount, filesystem] = line.split(" - ");
        const fields = mount?.split(" ") ?? [];
        const fs = filesystem?.split(" ") ?? [];
        return [
          fields[4],
          { type: fs[0], options: new Set([...(fields[5]?.split(",") ?? []), ...(fs[2]?.split(",") ?? [])]) },
        ];
      }),
  );

test.skipIf(socket === undefined)(
  `live mounts: tmpfs, nested bind, and private file mode${socket === undefined ? " (SKIP: explicit answering LANDO_TEST_PODMAN_SOCKET required)" : ""}`,
  async () => {
    // Given
    if (socket === undefined) throw new TypeError("LANDO_TEST_PODMAN_SOCKET required");
    const root = await mkdtemp(join(tmpdir(), "lando-live-mounts-"));
    const suffix = crypto.randomUUID().slice(0, 12);
    const name = `mounts-${suffix}`;
    const volume = `${name}-data`;
    const nested = join(root, "nested");
    const config = join(root, "config");
    await writeFile(nested, "nested bind visible\n");
    await writeFile(config, "private config bytes\n", { mode: 0o600 });
    const metadata = {
      resolvedAt: DateTime.makeUnsafe("2026-10-26T00:00:00Z"),
      source: "live-mounts",
      runtime: 4 as const,
    };
    const service: ServicePlan = {
      name: ServiceName.make("web"),
      type: "alpine",
      primary: true,
      provider: ProviderId.make("lando"),
      artifact: { kind: "ref", ref: "docker.io/library/alpine:3.20" },
      command: ["sleep", "infinity"],
      environment: {},
      endpoints: [],
      routes: [],
      hostAliases: [],
      dependsOn: [],
      metadata,
      extensions: {},
      mounts: [
        { type: "tmpfs", target: PortablePath.make("/scratch"), readOnly: false, origin: "authored" },
        {
          type: "tmpfs",
          target: PortablePath.make("/readonly"),
          readOnly: true,
          options: "size=8m",
          origin: "authored",
        },
        {
          type: "volume",
          store: volume,
          target: PortablePath.make("/data"),
          readOnly: false,
          origin: "authored",
        },
        {
          type: "bind",
          source: nested,
          target: PortablePath.make("/data/nested"),
          readOnly: true,
          realization: "passthrough",
          createHostPath: false,
          origin: "authored",
        },
        {
          type: "bind",
          source: config,
          target: PortablePath.make("/config"),
          readOnly: true,
          realization: "passthrough",
          createHostPath: false,
          fileMode: 0o440,
          origin: "authored",
          relativeTo: "app",
        },
      ],
    };
    const plan: AppPlan = {
      valueModel: 1,
      id: AppId.make(name),
      name,
      slug: name,
      root: AbsolutePath.make(root),
      provider: service.provider,
      services: { [service.name]: service },
      stores: [{ name: volume, scope: "app", kind: "data" }],
      routes: [],
      fileSync: [],
      extensions: {},
      metadata,
      networking: landoNetworkingPlan({
        slug: name,
        serviceNames: [service.name],
        sharedCrossAppNetwork: false,
      }),
    };
    const api = makePodmanApiClient(socket);
    const request = api.request;
    if (request === undefined) throw new TypeError("Missing live API request");
    const shell = (command: readonly string[]) =>
      Effect.runPromise(exec(plan, { app: plan.id, service: service.name }, { command }, { api }));
    const container = serviceContainerName(plan, service.name);
    try {
      await Effect.runPromise(pullImage(api, "docker.io/library/alpine:3.20", { policy: "missing" }));
      // When
      await Effect.runPromise(bringUp(plan, { api, userDataRoot: join(root, "data") }));
      const response = await Effect.runPromise(
        request({ method: "GET", path: `/containers/${container}/json` }),
      );
      expect(response.status).toBe(200);
      const inspected = Schema.decodeUnknownSync(ContainerInspect)(JSON.parse(response.body));
      const mountinfo = await shell(["cat", "/proc/self/mountinfo"]);
      // Then
      expect(mountinfo.exitCode).toBe(0);
      const mounted = mountTable(mountinfo.stdout);
      expect(mounted.get("/scratch")?.type).toBe("tmpfs");
      expect(mounted.get("/scratch")?.options).toContain("rw");
      expect(mounted.get("/readonly")?.type).toBe("tmpfs");
      expect(mounted.get("/readonly")?.options).toContain("ro");
      expect(mounted.get("/readonly")?.options).toContain("size=8192k");
      const scratchOptions = new Set(inspected.HostConfig.Tmpfs["/scratch"]?.split(","));
      const readonlyOptions = new Set(inspected.HostConfig.Tmpfs["/readonly"]?.split(","));
      expect(inspected.HostConfig.Tmpfs).toHaveProperty("/scratch");
      expect(scratchOptions).not.toContain("ro");
      expect(readonlyOptions).toContain("ro");
      expect(readonlyOptions).toContain("size=8m");
      const byTarget = new Map(inspected.Mounts.map((mount) => [mount.Destination, mount]));
      expect(byTarget.get("/data")?.Type).toBe("volume");
      expect(byTarget.get("/data")?.RW).toBe(true);
      expect(byTarget.get("/data/nested")).toMatchObject({ Type: "bind", RW: false, Source: nested });
      expect(byTarget.get("/config")).toMatchObject({ Type: "bind", RW: false });
      expect(byTarget.get("/config")?.Source).not.toBe(config);
      expect(mounted.has("/data")).toBe(true);
      expect(mounted.get("/data/nested")?.options).toContain("ro");
      expect(mounted.get("/config")?.options).toContain("ro");
      expect(await shell(["cat", "/data/nested"])).toMatchObject({
        exitCode: 0,
        stdout: "nested bind visible\n",
      });
      expect(await shell(["stat", "-c", "%a", "/config"])).toMatchObject({ exitCode: 0, stdout: "440\n" });
      expect(await shell(["cat", "/config"])).toMatchObject({
        exitCode: 0,
        stdout: "private config bytes\n",
      });
      expect(
        await shell([
          "sh",
          "-c",
          "touch /scratch/writable && test -f /scratch/writable && ! touch /readonly/rejected && ! echo changed >> /config",
        ]),
      ).toMatchObject({ exitCode: 0 });
    } finally {
      try {
        const cleanup = [];
        cleanup.push(
          await Effect.runPromise(
            request({ method: "DELETE", path: `/containers/${container}?force=true&v=true` }),
          ),
        );
        cleanup.push(await Effect.runPromise(request({ method: "DELETE", path: `/volumes/${volume}` })));
        for (const network of landoOwnedNetworkNames(plan)) {
          cleanup.push(await Effect.runPromise(request({ method: "DELETE", path: `/networks/${network}` })));
        }
        for (const result of cleanup) expect([200, 204, 404]).toContain(result.status);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
