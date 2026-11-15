import { expect, test } from "bun:test";
import { certificatePairIsCurrent } from "@lando/sdk/certificates";
import { app } from "./proxy-tls-harness.ts";
import { DAY_MS, domain, expiry, makeCertificateFixture, pem, route } from "./router-certificate-fixture.ts";

test.each(["app", "default"] as const)(
  "#2254 renews only the %s pair at the 30-day boundary and reloads unchanged routing last",
  async (target) => {
    const f = makeCertificateFixture();
    f.seed(target === "app" ? pem.expiring : pem.current, target === "default" ? pem.expiring : pem.current);
    const previousYaml = f.files.get(f.watched);
    const changed = target === "app" ? f.appFiles : f.defaultFiles;

    await f.run(f.makeService().applyRoutes([route], app), expiry - 30 * DAY_MS);

    expect(f.files.get(changed.cert)).toBe(pem.current.certificate);
    expect(f.files.get(changed.key)).toBe(pem.current.privateKey);
    expect(f.calls.map((call) => call.cn)).toEqual([target === "app" ? route.hostname : `*.${domain}`]);
    expect(f.operations.at(-1)).toBe(`write:${f.watched}`);
    expect(Bun.YAML.parse(f.files.get(f.watched) ?? "")).toEqual(Bun.YAML.parse(previousYaml ?? ""));
    expect(f.files.get(f.watched)).not.toBe(previousYaml);
    expect(f.state.rootReads).toBe(1);
  },
);

test("keeps both pairs just outside the renewal margin without writes or issuance", async () => {
  const f = makeCertificateFixture();
  f.seed(pem.expiring);

  await f.run(f.makeService().applyRoutes([route], app), expiry - 30 * DAY_MS - 1);

  expect(f.operations).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(f.state.rootReads).toBe(1);
  expect(f.runtime.requests).toHaveLength(1);
});

test("#2254 replaces both old-root pairs and issuer, then reuses the new material", async () => {
  const f = makeCertificateFixture();
  f.seed(pem.current);
  f.state.root = pem.rootB;
  f.state.issued = pem.rotated;

  await f.run(f.makeService().applyRoutes([route], app));

  for (const files of [f.appFiles, f.defaultFiles]) {
    expect(
      certificatePairIsCurrent(
        { certificate: f.files.get(files.cert) ?? "", privateKey: f.files.get(files.key) ?? "" },
        {
          names: [route.hostname],
          root: pem.rootB,
          now: expiry - 60 * DAY_MS,
        },
      ),
    ).toBe(true);
  }
  expect(f.files.get(f.issuer)).toBe(pem.rootB);
  expect(f.calls).toHaveLength(2);
  expect(f.state.rootReads).toBe(1);
  f.operations.length = 0;
  f.calls.length = 0;
  await f.run(f.makeService().applyRoutes([route], app));
  expect(f.operations).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(f.state.rootReads).toBe(2);
});

test.each(["missing", "stale"] as const)(
  "#2254 repairs a %s issuer without replacing valid leaves or restarting acknowledged Windows routes",
  async (issuerState) => {
    const f = makeCertificateFixture("win32");
    f.seed(pem.current);
    await f.run(f.makeService().applyRoutes([route], app));
    f.events.length = 0;
    f.operations.length = 0;
    if (issuerState === "missing") f.files.delete(f.issuer);
    else f.files.set(f.issuer, pem.rootB);

    await f.run(f.makeService().applyRoutes([route], app));

    expect(f.files.get(f.issuer)).toBe(pem.rootA);
    expect(f.operations).toEqual([`write:${f.issuer}`]);
    expect(f.calls).toEqual([]);
    expect(f.state.restarts).toBe(1);
    expect(f.events).toEqual(["lock"]);
    expect(f.runtime.requests).toHaveLength(2);
  },
);

test("requires the literal default wildcard even when representative hosts are covered", async () => {
  const f = makeCertificateFixture();
  f.seed(pem.current, pem.exactOnly);

  await f.run(f.makeService().applyRoutes([route], app));

  expect(f.files.get(f.defaultFiles.cert)).toBe(pem.current.certificate);
  expect(f.calls.map((call) => call.cn)).toEqual([`*.${domain}`]);
});
