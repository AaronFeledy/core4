import { expect, test } from "bun:test";
import { AbsolutePath, type MountPlan, PortablePath, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { CONTAINER_HELPER_COMMANDS, containerHelperDelivery } from "../src/container-helper.ts";
import { prepareContainerHelperMounts } from "../src/container-helper-mount.ts";
import { commonContainerLabels } from "../src/plan.ts";
import { bringUp } from "../src/podman/bring-up.ts";
import { ctx, fakeEngine, plan, service } from "./fixtures/environment-values.ts";

const target = { os: "linux", arch: "x64" } as const;
// The profile stub, like the shims, has one stable source per architecture.
const hookSource = "/helpers/linux-x64/profile/zz-lando-service-path.sh";
const options = (digest: string) => ({
  ctx,
  helperTarget: target,
  resolveContainerHelper: () =>
    Effect.succeed({
      target,
      digest,
      path: AbsolutePath.make(`/helpers/linux-x64/${digest}/lando-container-helper`),
    }),
});

test("new helper digests share one stable command source and create identity", async () => {
  const first = await Effect.runPromise(prepareContainerHelperMounts(plan, options("a".repeat(64))));
  const next = await Effect.runPromise(prepareContainerHelperMounts(plan, options("b".repeat(64))));
  const a = first.services[service.name];
  const b = next.services[service.name];
  if (a === undefined || b === undefined) throw new TypeError("Missing fixture service");
  expect(a.mounts.find((mount) => mount.target === "/run/lando/helper")).toMatchObject({
    source: "/helpers/linux-x64",
    target: "/run/lando/helper",
    readOnly: true,
  });
  // The commands bind immutable per-architecture shims, so a helper update never
  // changes a mount source.
  for (const name of CONTAINER_HELPER_COMMANDS) {
    const target = `/usr/local/bin/${name}`;
    const mount = a.mounts.find((candidate) => candidate.target === target);
    expect(mount).toMatchObject({
      source: `/helpers/linux-x64/shims/${name}`,
      target,
      readOnly: true,
    });
    expect(b.mounts.find((candidate) => candidate.target === target)).toEqual(mount);
  }
  expect(commonContainerLabels(first, a)["dev.lando.create-config"]).toBe(
    commonContainerLabels(next, b)["dev.lando.create-config"],
  );
  expect(commonContainerLabels(first, a)["dev.lando.create-config"]).not.toBe(
    commonContainerLabels(plan, service)["dev.lando.create-config"],
  );
  expect(plan.services[service.name]?.mounts).toEqual(service.mounts);
});

test("service creation lowers the helper directory without mutating its logical plan", async () => {
  const engine = fakeEngine();
  await Effect.runPromise(bringUp(plan, { api: engine.api, ...options("a".repeat(64)) }));
  expect(engine.calls.find((request) => request.path.startsWith("/containers/create?"))?.body).toMatchObject({
    HostConfig: {
      Binds: [
        "/helpers/linux-x64:/run/lando/helper:ro",
        ...CONTAINER_HELPER_COMMANDS.map(
          (name) => `/helpers/linux-x64/shims/${name}:/usr/local/bin/${name}:ro`,
        ),
        `${hookSource}:/etc/profile.d/zz-lando-service-path.sh:ro`,
      ],
    },
  });
  expect(plan.services[service.name]?.mounts).toEqual([]);
});

test("helper delivery preserves the digest-relative executable and source-build path", () => {
  const digest = "c".repeat(64);
  expect(
    containerHelperDelivery({
      target,
      digest,
      path: AbsolutePath.make(`/helpers/linux-x64/${digest}/lando-container-helper`),
    }),
  ).toEqual({
    source: "/helpers/linux-x64",
    target: "/run/lando/helper",
    executable: `/run/lando/helper/${digest}/lando-container-helper`,
  });
  expect(
    containerHelperDelivery({
      target,
      digest,
      path: AbsolutePath.make("/dist/linux-x64/lando-container-helper"),
    }).executable,
  ).toBe("/run/lando/helper/lando-container-helper");
});

test("creation refuses an unavailable helper instead of creating an unsupervised service", async () => {
  const engine = fakeEngine();
  const failure = await Effect.runPromise(bringUp(plan, { api: engine.api, ctx }).pipe(Effect.flip));
  expect(failure._tag).toBe("ProviderInternalError");
  expect(engine.calls).toEqual([]);
});

test("every service binds the login-profile stub read-only from its stable source", async () => {
  // Given
  const worker = { ...service, name: ServiceName.make("worker"), primary: false };
  const input = { ...plan, services: { [service.name]: service, [worker.name]: worker } };
  // When
  const prepared = await Effect.runPromise(prepareContainerHelperMounts(input, options("a".repeat(64))));
  // Then
  for (const name of [service.name, worker.name])
    expect(
      prepared.services[name]?.mounts.find(
        (mount) => mount.target === "/etc/profile.d/zz-lando-service-path.sh",
      ),
    ).toMatchObject({ type: "bind", source: hookSource, readOnly: true });
});

const authored = (type: MountPlan["type"], target: string): MountPlan => {
  const common = { target: PortablePath.make(target), readOnly: false, origin: "authored" as const };
  switch (type) {
    case "bind":
      return { ...common, type, source: "/host/dir", realization: "passthrough" };
    case "volume":
      return { ...common, type, store: "data" };
    case "tmpfs":
      return { ...common, type };
    default:
      return type satisfies never;
  }
};

const shimTargets = CONTAINER_HELPER_COMMANDS.map((name) => `/usr/local/bin/${name}`);
const helperTargets = ["/run/lando/helper", ...shimTargets, "/etc/profile.d/zz-lando-service-path.sh"];
const without = (...targets: ReadonlyArray<string>) =>
  helperTargets.filter((target) => !targets.includes(target));

const overlaps: ReadonlyArray<{
  readonly mount: MountPlan;
  readonly outcome: { readonly refused: string } | { readonly bound: ReadonlyArray<string> };
}> = [
  { mount: authored("bind", "/run/lando/helper"), outcome: { refused: "/run/lando/helper" } },
  { mount: authored("tmpfs", "/run/lando/helper/"), outcome: { refused: "/run/lando/helper" } },
  { mount: authored("volume", "/run/lando/helper/cache"), outcome: { refused: "/run/lando/helper/cache" } },
  { mount: authored("bind", "/run/lando"), outcome: { refused: "/run/lando" } },
  { mount: authored("volume", "/run"), outcome: { refused: "/run" } },
  { mount: authored("tmpfs", "/run"), outcome: { bound: helperTargets } },
  { mount: authored("bind", "/run/lando-helper"), outcome: { bound: helperTargets } },
  {
    mount: authored("bind", "/usr/local/bin/lando-drupal-scaffold"),
    outcome: { refused: "/usr/local/bin/lando-drupal-scaffold" },
  },
  { mount: authored("bind", "/usr/local/bin"), outcome: { bound: without(...shimTargets) } },
  { mount: authored("volume", "/usr/local"), outcome: { bound: without(...shimTargets) } },
  { mount: authored("bind", "/usr/local/bin/tool"), outcome: { bound: helperTargets } },
  {
    mount: authored("bind", "/etc/profile.d/zz-lando-service-path.sh"),
    outcome: { bound: without("/etc/profile.d/zz-lando-service-path.sh") },
  },
  {
    mount: authored("bind", "/etc/profile.d"),
    outcome: { bound: without("/etc/profile.d/zz-lando-service-path.sh") },
  },
  {
    mount: authored("volume", "/etc"),
    outcome: { bound: without("/etc/profile.d/zz-lando-service-path.sh") },
  },
  { mount: authored("bind", "/etc/profile.d/other.sh"), outcome: { bound: helperTargets } },
  // Exact targets compare canonically.
  {
    mount: authored("bind", "/usr/local//bin/./lando-create-project/"),
    outcome: { refused: "/usr/local//bin/./lando-create-project/" },
  },
  // A tmpfs persists nothing, so Lando's file binds still mount beneath it.
  { mount: authored("tmpfs", "/usr/local/bin"), outcome: { bound: helperTargets } },
  { mount: authored("tmpfs", "/etc/profile.d"), outcome: { bound: helperTargets } },
  { mount: authored("tmpfs", "/etc"), outcome: { bound: helperTargets } },
];

for (const { mount, outcome } of overlaps)
  test(`an authored ${mount.type} at ${mount.target} ${"refused" in outcome ? "is refused" : "keeps only uncovered helper binds"}`, async () => {
    // Given
    const input = { ...plan, services: { [service.name]: { ...service, mounts: [mount] } } };
    // When
    const result = await Effect.runPromise(
      prepareContainerHelperMounts(input, options("a".repeat(64))).pipe(Effect.result),
    );
    // Then
    if ("refused" in outcome) {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ProviderInternalError");
        expect(result.failure.message).toContain(outcome.refused);
      }
      return;
    }
    expect(result._tag).toBe("Success");
    if (result._tag === "Success")
      expect(
        result.success.services[service.name]?.mounts.slice(1).map((planned): string => planned.target),
      ).toEqual([...outcome.bound]);
  });
