import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { Schema } from "effect";

import { SOLR_FEATURE_ID, solrServiceFeature, solrServiceType } from "../src/services/solr.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

// Model the image wrapper's forwarding and the runtime CLI's help/flag contract.
// File operations are recorded, not run against the host's /var or /etc trees.
const EXECUTABLES = {
  solr: `#!/bin/bash
printf 'solr'; printf '\\t%s' "$@"; printf '\\n'
if [[ "$*" == 'start --help' ]]; then
  if [[ "$DOCUMENTED_MODE" == yes ]]; then
    printf '%s\\n' '  --user-managed Run in user-managed mode' >&2
  else
    printf '%s\\n' 'Usage: solr start [-p port] [-c]' >&2
  fi
  exit 0
fi
for arg in "$@"; do
  if [[ "$arg" == --user-managed && "$ACCEPTS_MODE" == no ]]; then exit 64; fi
done
if [[ "$REQUIRES_MODE" == yes && "$*" != *--user-managed* ]]; then
  printf '%s\\n' 'Cloud mode does not load precreated cores' >&2
  exit 65
fi
`,
  "solr-foreground": `#!/bin/bash
printf 'solr-foreground'; printf '\\t%s' "$@"; printf '\\n'
exec solr start -f "$@"
`,
  "precreate-core": `#!/bin/bash
printf 'precreate-core'; printf '\\t%s' "$@"; printf '\\n'
`,
  mkdir: `#!/bin/bash
printf 'mkdir'; printf '\\t%s' "$@"; printf '\\n'
`,
  cp: `#!/bin/bash
printf 'cp'; printf '\\t%s' "$@"; printf '\\n'
`,
} as const;

const RUNTIMES = [
  { runtime: "8", image: "solr:8", documented: false, accepts: false },
  { runtime: "9.7", image: "solr:9.7", documented: false, accepts: false },
  { runtime: "9.8", image: "solr:9", documented: false, accepts: true },
  { runtime: "10", image: "solr:10", documented: true, accepts: true },
  { runtime: "11", image: "solr:11", documented: true, accepts: true },
  { runtime: "10-custom-tag", image: "registry.example/search:stable", documented: true, accepts: true },
  {
    runtime: "10-custom-digest",
    image: `registry.example/search@sha256:${"a".repeat(64)}`,
    documented: true,
    accepts: true,
  },
  { runtime: "8-misleading-tag", image: "registry.example/search:10", documented: false, accepts: false },
] as const;

// These commands run inside Linux images, including on Windows hosts.
describe.skipIf(process.platform === "win32")("Solr generated startup", () => {
  for (const hasConfig of [false, true]) {
    test.each([...RUNTIMES])(`$runtime core startup (config.dir=${hasConfig})`, async (runtime) => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: {
          search: {
            type: "solr",
            image: runtime.image,
            port: 18983,
            cores: ["a.b", "second-core"],
            ...(hasConfig ? { config: { dir: "solr/conf" } } : {}),
          },
        },
      });
      const service = landofile.services?.[ServiceName.make("search")];
      if (service === undefined) throw new Error("search service missing");
      const plan = await composeServicePlan({
        serviceType: solrServiceType,
        service,
        appRoot: "/srv/apps/myapp",
        appName: "myapp",
        serviceName: "search",
        metadata: { resolvedAt: "2026-05-28T00:00:00Z", source: "/srv/apps/myapp/.lando.yml", runtime: 4 },
        featureOverrides: new Map([[SOLR_FEATURE_ID, solrServiceFeature]]),
      });
      const command = plan.command;
      if (command === undefined) throw new Error("Solr startup command missing");
      const root = await mkdtemp(join(tmpdir(), "lando-solr-startup-"));
      try {
        for (const [name, script] of Object.entries(EXECUTABLES)) {
          const path = join(root, name);
          await Bun.write(path, script);
          await chmod(path, 0o700);
        }
        const child = Bun.spawn([...command], {
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH ?? ""}`,
            SOLR_VERSION: "8.0.0",
            DOCUMENTED_MODE: runtime.documented ? "yes" : "no",
            ACCEPTS_MODE: runtime.accepts ? "yes" : "no",
            REQUIRES_MODE: runtime.documented ? "yes" : "no",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
        const calls = stdout
          .trim()
          .split("\n")
          .map((line) => line.split("\t"));
        const mode = runtime.documented ? ["--user-managed"] : [];
        const coreCalls = ["a.b", "second-core"].flatMap((core) => [
          ["precreate-core", core],
          ...(hasConfig
            ? [
                ["mkdir", "-p", `/var/solr/data/${core}/conf`],
                ["cp", "-a", "/etc/lando/solr/conf/.", `/var/solr/data/${core}/conf/`],
              ]
            : []),
        ]);
        expect(calls).toEqual([
          ...coreCalls,
          ["solr-foreground", "-p", "18983", ...mode],
          ["solr", "start", "-f", "-p", "18983", ...mode],
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
