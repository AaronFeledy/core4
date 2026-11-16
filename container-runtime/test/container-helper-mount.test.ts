import { expect, test } from "bun:test";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { CONTAINER_HELPER_COMMANDS, containerHelperDelivery } from "../src/container-helper.ts";
import { prepareContainerHelperMounts } from "../src/container-helper-mount.ts";
import { commonContainerLabels } from "../src/plan.ts";
import { bringUp } from "../src/podman/bring-up.ts";
import { ctx, fakeEngine, plan, service } from "./fixtures/environment-values.ts";

const target = { os: "linux", arch: "x64" } as const;
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
