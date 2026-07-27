export const ARCHITECTURE_CORPUS: ReadonlyArray<{
  readonly path: string;
  readonly contents: string;
}> = [
  {
    path: "core/package.json",
    contents: '{"name":"@lando/core","exports":{".":"./src/index.ts"}}\n',
  },
  {
    path: "sdk/package.json",
    contents: '{"name":"@lando/sdk","exports":{".":"./src/index.ts"}}\n',
  },
  {
    path: "container-runtime/package.json",
    contents: '{"name":"@lando/container-runtime","exports":{".":"./src/index.ts"}}\n',
  },
  {
    path: "plugins/service-lando/package.json",
    contents: '{"name":"@lando/service-lando","exports":{".":"./src/index.ts"}}\n',
  },
  {
    path: "plugins/alpha/package.json",
    contents:
      '{"name":"@lando/alpha","exports":{".":"./src/index.ts"},"dependencies":{"@lando/beta":"workspace:*"}}\n',
  },
  {
    path: "plugins/beta/package.json",
    contents:
      '{"name":"@lando/beta","exports":{".":"./src/index.ts"},"dependencies":{"@lando/alpha":"workspace:*"}}\n',
  },
  { path: "core/src/index.ts", contents: 'export const core = "core";\n' },
  { path: "sdk/src/index.ts", contents: 'export const sdk = "sdk";\n' },
  {
    path: "container-runtime/src/index.ts",
    contents: 'export const containerRuntime = "container-runtime";\n',
  },
  { path: "plugins/service-lando/src/index.ts", contents: 'export const service = "service";\n' },

  {
    path: "core/src/characterization/renderer-offender.ts",
    contents: 'export const render = () => console.error("outside renderer");\n',
  },
  {
    path: "core/src/characterization/renderer-near-miss.ts",
    contents: 'declare const renderer: { error: (message: string) => void };\nrenderer.error("safe");\n',
  },
  { path: "core/bin/lando.ts", contents: 'process.stdout.write("legacy banner");\n' },
  {
    path: "core/src/cli/oclif/pre-renderer.ts",
    contents: 'console.warn("renderer is not ready");\n',
  },
  {
    path: "core/src/interaction/service.ts",
    contents: 'process.stderr.write("prompt fallback");\n',
  },

  {
    path: "core/src/characterization/managed-file-offender.ts",
    contents: 'export const marker = "lando-generated";\n',
  },
  {
    path: "core/src/characterization/managed-file-near-miss.ts",
    contents: 'export const marker = "lando generated";\n',
  },
  {
    path: "core/src/managed-file/x.ts",
    contents: 'export const fence = ">>> lando:fixture";\n',
  },

  {
    path: "core/src/characterization/redaction-offender.ts",
    contents: 'export const secret = "[redacted]";\n',
  },
  {
    path: "core/src/characterization/redaction-near-miss.ts",
    contents: 'export const status = "[redaction pending]";\n',
  },

  {
    path: "plugins/service-lando/src/features/env.ts",
    contents: "export const landoEnvFeature = {};\nexport const applyEnv = () => undefined;\n",
  },
  {
    path: "plugins/service-lando/src/features/environment.ts",
    contents: "export const applyEnvironment = () => undefined;\n",
  },
  {
    path: "plugins/service-lando/src/services/static.ts",
    contents: 'import { applyEnv } from "../features/env";\nvoid applyEnv;\n',
  },
  {
    path: "plugins/service-lando/src/services/dynamic.ts",
    contents: 'export const load = () => import("../features/env");\n',
  },
  {
    path: "plugins/service-lando/src/services/required.ts",
    contents: 'export const loaded = require("../features/env");\n',
  },
  {
    path: "plugins/service-lando/src/services/re-export.ts",
    contents: 'export { landoEnvFeature } from "../features/env";\n',
  },
  {
    path: "plugins/service-lando/src/services/env-near-miss.ts",
    contents: 'import { applyEnvironment } from "../features/environment";\nvoid applyEnvironment;\n',
  },

  {
    path: "plugins/alpha/src/index.ts",
    contents: 'import { beta } from "@lando/beta";\nexport const alpha = beta;\n',
  },
  {
    path: "plugins/beta/src/index.ts",
    contents: 'import { alpha } from "@lando/alpha";\nexport const beta = alpha;\n',
  },
  {
    path: "plugins/alpha/src/core-offender.ts",
    contents: 'import { core } from "@lando/core";\nvoid core;\n',
  },
  {
    path: "plugins/alpha/src/dag-near-miss.ts",
    contents: 'import { sdk } from "@lando/sdk";\nvoid sdk;\n',
  },
  {
    path: "core/src/plugins/generated/bundled.ts",
    contents: 'export { alpha } from "@lando/alpha";\n',
  },
  {
    path: "core/src/characterization/core-plugin-offender.ts",
    contents: 'import { alpha } from "@lando/alpha";\nvoid alpha;\n',
  },

  {
    path: "core/src/characterization/paths-offender.ts",
    contents:
      'import { join } from "node:path";\ndeclare const userDataRoot: string;\nexport const path = join(userDataRoot, "plugins");\n',
  },
  {
    path: "core/src/characterization/paths-near-miss.ts",
    contents:
      'import { join } from "node:path";\ndeclare const projectRoot: string;\nexport const path = join(projectRoot, "plugins");\n',
  },
  {
    path: "core/src/config/paths.ts",
    contents:
      'import { join } from "node:path";\ndeclare const userDataRoot: string;\nexport const owned = join(userDataRoot, "bin");\n',
  },

  {
    path: "core/src/characterization/state-store-offender.ts",
    contents:
      'declare const writeFile: (...args: unknown[]) => void;\ndeclare const rename: (...args: unknown[]) => void;\ndeclare const unlink: (...args: unknown[]) => void;\nconst tempPath = "state.tmp-1";\nwriteFile(tempPath, JSON.stringify({ version: 1, data: {} }));\nrename(tempPath, "state.json");\nunlink("state.lock");\n',
  },
  {
    path: "core/src/characterization/state-store-near-miss.ts",
    contents:
      'declare const writeFile: (...args: unknown[]) => void;\nconst tempPath = "state.tmp-1";\nwriteFile(tempPath, "unversioned");\n',
  },
  {
    path: "core/src/state/store.ts",
    contents:
      'declare const writeFile: (...args: unknown[]) => void;\ndeclare const rename: (...args: unknown[]) => void;\ndeclare const unlink: (...args: unknown[]) => void;\nconst tempPath = "owned.tmp-1";\nwriteFile(tempPath, JSON.stringify({ version: 1, data: {} }));\nrename(tempPath, "owned.json");\nunlink("owned.lock");\n',
  },
  {
    path: "core/src/cache/atomic.ts",
    contents:
      'declare const writeFile: (...args: unknown[]) => void;\ndeclare const rename: (...args: unknown[]) => void;\ndeclare const unlink: (...args: unknown[]) => void;\nconst tempPath = "cache.tmp-1";\nwriteFile(tempPath, JSON.stringify({ version: 1, data: {} }));\nrename(tempPath, "cache.json");\nunlink("cache.lock");\n',
  },

  {
    path: "core/src/characterization/probe-offender.ts",
    contents:
      'import { Effect } from "effect";\ndeclare const operation: unknown;\nexport const retried = Effect.retry(operation);\n',
  },
  {
    path: "core/src/characterization/probe-near-miss.ts",
    contents: 'import { runProbe } from "@lando/sdk/probe";\nexport const probed = runProbe;\n',
  },
  {
    path: "core/src/state/lock.ts",
    contents:
      'import { Effect } from "effect";\ndeclare const acquire: unknown;\nexport const lock = Effect.retry(acquire);\n',
  },

  {
    path: "core/src/characterization/network-offender.ts",
    contents: 'export const request = () => globalThis.fetch("https://example.invalid");\n',
  },
  {
    path: "core/src/characterization/network-near-miss.ts",
    contents:
      'declare const client: { fetch: (url: string) => unknown };\nexport const request = () => client.fetch("https://example.invalid");\n',
  },
  {
    path: "core/src/http-client/live.ts",
    contents: 'export const request = () => fetch("https://example.invalid");\n',
  },

  {
    path: "core/src/characterization/type-a.ts",
    contents: 'import type { TypeB } from "./type-b";\nexport type TypeA = TypeB;\n',
  },
  {
    path: "core/src/characterization/type-b.ts",
    contents: 'import type { TypeA } from "./type-a";\nexport type TypeB = TypeA;\n',
  },

  {
    path: "core/src/characterization/excluded.test.ts",
    contents:
      'import { Effect } from "effect";\nconsole.error("excluded");\nvoid fetch("https://example.invalid");\nvoid Effect.retry(undefined);\nexport const marker = "[REDACTED] lando-generated";\n',
  },
  {
    path: "plugins/alpha/src/excluded.test.ts",
    contents: 'import "@lando/core";\nexport const excluded = true;\n',
  },
];
