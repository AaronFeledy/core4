import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { loadLandofileLayers } from "../../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "../support.ts";

const web = ServiceName.make("web");
const hostsPath = ["services", "web", "extra_hosts"];
const landofile = (hosts: string) => `name: demo\nservices:\n  web:\n    extra_hosts:\n${hosts}\n`;
const withHosts = async (hosts: string, run: (file: string, root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-extra-host-expressions-"));
  const file = join(root, ".lando.yml");
  try {
    await Bun.write(file, landofile(hosts));
    await run(file, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const load = (file: string, root: string) =>
  loadLandofileLayers(root, file, {
    ports: makeTestLandofilePorts(root),
    stateStore: makeTestLandofileStateStore(),
    templates: {
      modules: [],
      context: { env: { HOST: "eager.test" }, scope: "app", bootstrapLevel: "plugins" },
    },
  });

test("rebases deferred host addresses to hostname and occurrence without losing their list indices", () =>
  withHosts(
    `      - "peer:2001:db8::1"
      - "single={{ services.db.creds.user }}"
      - "peer=2001:db8::{{ app.name }}"
      - "peer:{{ app.name == 'demo' ? '::2' : '::3' }}"`,
    async (file, root) => {
      const loaded = await Effect.runPromise(load(file, root));
      expect(loaded.pendingSites.map(({ path, source }) => [path, source])).toEqual([
        [
          [...hostsPath, "single"],
          expect.objectContaining({ file, layer: "canonical", path: [...hostsPath, 1] }),
        ],
        [
          [...hostsPath, "peer", 1],
          expect.objectContaining({ file, layer: "canonical", path: [...hostsPath, 2] }),
        ],
        [
          [...hostsPath, "peer", 2],
          expect.objectContaining({ file, layer: "canonical", path: [...hostsPath, 3] }),
        ],
      ]);
    },
  ));

test("drops the pending site when a higher layer replaces its extra_hosts list", () =>
  withHosts('      - "{{ env.MISSING_HOST }}={{ app.missing }}"', async (file, root) => {
    await Bun.write(join(root, ".lando.local.yml"), landofile('      peer: "192.0.2.31"'));
    const loaded = await Effect.runPromise(load(file, root));
    expect(loaded.pendingSites).toEqual([]);
    expect(loaded.document.services?.[web]?.extra_hosts).toEqual({ peer: "192.0.2.31" });
  }));

test("loads mixed-scope hostnames before assigning deferred addresses their repeated-host positions", () => {
  const equalsAddress = "{{ services.db.creds.user }}";
  const colonAddress = "2001:db8::{{ app.name == 'demo' ? '2' : env.HOST }}";
  return withHosts(
    `      - "{{ env.HOST }}=${equalsAddress}"
      - "eager.test:192.0.2.31"
      - "{{ env.HOST == 'eager.test' ? env.HOST : 'other.test' }}:${colonAddress}"`,
    async (file, root) => {
      const loaded = await Effect.runPromise(load(file, root));
      expect(loaded.document.services?.[web]?.extra_hosts).toEqual({
        "eager.test": [equalsAddress, "192.0.2.31", colonAddress],
      });
      expect(loaded.pendingSites.map(({ path, source }) => [path, source.path])).toEqual([
        [
          [...hostsPath, "eager.test", 0],
          [...hostsPath, 0],
        ],
        [
          [...hostsPath, "eager.test", 2],
          [...hostsPath, 2],
        ],
      ]);
    },
  );
});

test("reports a missing load-owned hostname at the authored list index", () =>
  withHosts('      - "{{ env.MISSING_HOST }}={{ app.name }}"', async (file, root) => {
    const path = [...hostsPath, 0];
    expect(await Effect.runPromise(Effect.flip(load(file, root)))).toMatchObject({
      _tag: "ConfigExpressionError",
      path,
      source: { file, layer: "canonical", path },
    });
  }));

test.each([":", "="])("rejects a deferred hostname with an authored list location (%s)", (separator) =>
  withHosts(
    `      - "{{ app.name == 'demo' ? 'peer' : 'alias' }}${separator}192.0.2.31"`,
    async (file, root) => {
      const path = [...hostsPath, 0];
      expect(await Effect.runPromise(Effect.flip(load(file, root)))).toMatchObject({
        _tag: "LandofileValidationError",
        issues: [
          {
            rule: "unsupported-expression",
            message: expect.stringContaining("Key expressions are not supported"),
            path,
            source: { file, layer: "canonical", path },
          },
        ],
      });
    },
  ),
);

test("expands an eager environment hostname in list form", () =>
  withHosts('      - "{{ env.HOST }}=192.0.2.31"', async (file, root) => {
    const loaded = await Effect.runPromise(load(file, root));
    expect(loaded.document.services?.[web]?.extra_hosts).toEqual({ "eager.test": "192.0.2.31" });
    expect(loaded.pendingSites).toEqual([]);
  }));

test("still rejects an eager environment expression in an authored map key", () =>
  withHosts('      "{{ env.HOST }}": "192.0.2.31"', async (file, root) => {
    expect(await Effect.runPromise(Effect.flip(load(file, root)))).toMatchObject({
      _tag: "LandofileValidationError",
      issues: [{ rule: "unsupported-expression", path: [...hostsPath, "{{ env.HOST }}"] }],
    });
  }));
