import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { defaultTlsFile } from "../src/proxy-paths.ts";
import { app } from "./proxy-tls-harness.ts";
import {
  DAY_MS,
  caFailure,
  expiry,
  makeCertificateFixture,
  now,
  pem,
  route,
} from "./router-certificate-fixture.ts";

test.each(["root", "first-issue", "second-issue"] as const)(
  "%s failure preserves published files and Windows acknowledgement",
  async (stage) => {
    const f = makeCertificateFixture("win32");
    f.seed(pem.current);
    await f.run(f.makeService().applyRoutes([route], app));
    const before = new Map(f.files);
    f.events.length = 0;
    f.operations.length = 0;
    f.state.root = pem.rootB;
    f.state.issued = pem.rotated;
    f.state.rootFailure = stage === "root";
    f.state.failIssue = stage === "first-issue" ? 1 : 2;

    const result = await f.run(f.makeService().applyRoutes([route], app).pipe(Effect.result));

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProxyApplyError", cause: caFailure } });
    expect(f.files).toEqual(before);
    expect(f.operations).toEqual([]);
    expect(f.events).toEqual(["lock"]);
    expect(f.state.restarts).toBe(1);
  },
);

test.each(["http", "empty", "remove", "stop", "observe"] as const)(
  "%s needs no CA root",
  async (operation) => {
    const f = makeCertificateFixture();
    f.seed(pem.current);
    f.state.rootFailure = true;
    const service = f.makeService();
    switch (operation) {
      case "http":
        await f.run(service.applyRoutes([{ ...route, scheme: "http" }], app));
        break;
      case "empty":
        await f.run(service.applyRoutes([], app));
        break;
      case "remove":
        await f.run(service.removeRoutes(app));
        break;
      case "stop":
        await f.run(service.stop);
        break;
      case "observe":
        await f.run(service.observeRoutes(app, [route]));
        break;
    }
    expect(f.state.rootReads).toBe(0);
    expect(f.calls).toEqual([]);
  },
);

test("repairs a mixed pair after a failed certificate write before publishing the watched trigger", async () => {
  const f = makeCertificateFixture();
  f.seed(pem.expiring);
  let fail = true;
  const service = makeTraefikRouterService({
    ...f.dependencies,
    fileSystem: {
      ...f.dependencies.fileSystem,
      writeAtomic: (path, content) =>
        path === f.appFiles.cert && fail
          ? Effect.sync(() => {
              fail = false;
            }).pipe(Effect.andThen(Effect.fail("write failed")))
          : f.dependencies.fileSystem.writeAtomic(path, content),
    },
  });
  const at = Date.parse("2026-12-15T00:00:00Z");
  const result = await f.run(service.applyRoutes([route], app).pipe(Effect.result), at);
  expect(result._tag).toBe("Failure");
  expect(f.files.get(f.appFiles.key)).toBe(pem.current.privateKey);
  expect(f.files.get(f.appFiles.cert)).toBe(pem.expiring.certificate);
  expect(f.operations).not.toContain(`write:${f.watched}`);

  await f.run(f.makeService().applyRoutes([route], app), at);

  expect(f.files.get(f.appFiles.cert)).toBe(pem.current.certificate);
  expect(f.operations.at(-1)).toBe(`write:${f.watched}`);
});

for (const replacement of ["root-rotation", "default-renewal"] as const) {
  test.each(["route", "issuer", "default-config"] as const)(
    `#2254 a fresh process completes ${replacement} after a failed %s publication`,
    async (stage) => {
      const f = makeCertificateFixture();
      f.seed(pem.current, replacement === "default-renewal" ? pem.expiring : pem.current);
      await f.run(f.makeService().applyRoutes([route], app));
      const previousYaml = f.files.get(f.watched) ?? "";
      const at = replacement === "default-renewal" ? expiry - 30 * DAY_MS : now;
      const issued = replacement === "root-rotation" ? pem.rotated : pem.current;
      if (replacement === "root-rotation") f.state.root = pem.rootB;
      f.state.issued = issued;
      const configFile = defaultTlsFile(f.dependencies.paths);
      if (stage === "default-config") f.files.set(configFile, "tls: {}\n");
      if (stage === "issuer") f.files.set(f.issuer, "stale issuer");
      const failedPath = stage === "route" ? f.watched : stage === "issuer" ? f.issuer : configFile;
      const failing = makeTraefikRouterService({
        ...f.dependencies,
        fileSystem: {
          ...f.dependencies.fileSystem,
          writeAtomic: (path, content) =>
            path === failedPath
              ? Effect.fail(new Error("publication failed"))
              : f.dependencies.fileSystem.writeAtomic(path, content),
        },
      });

      const first = await f.run(failing.applyRoutes([route], app).pipe(Effect.result), at);

      expect(first._tag).toBe("Failure");
      expect(f.files.get(f.defaultFiles.cert)).toBe(issued.certificate);
      expect(f.files.get(f.defaultFiles.key)).toBe(issued.privateKey);
      expect(f.files.get(f.appFiles.cert)).toBe(
        replacement === "root-rotation" ? issued.certificate : pem.current.certificate,
      );
      expect(f.files.get(f.watched)).toBe(previousYaml);
      f.operations.length = 0;
      f.calls.length = 0;

      const recovered = await f.run(f.makeService().applyRoutes([route], app), at);

      expect(recovered.appliedRoutes).toEqual([route]);
      expect(f.operations.at(-1)).toBe(`write:${f.watched}`);
      expect(f.calls).toEqual([]);
      const publishedYaml = f.files.get(f.watched) ?? "";
      expect(Bun.YAML.parse(publishedYaml)).toEqual(Bun.YAML.parse(previousYaml));
      expect(publishedYaml).not.toBe(previousYaml);
      f.operations.length = 0;
      await f.run(f.makeService().applyRoutes([route], app), at);
      expect(f.operations).toEqual([]);
      expect(f.calls).toEqual([]);
    },
  );
}
