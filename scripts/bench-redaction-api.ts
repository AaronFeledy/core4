/**
 * Cross-checkout module loading for the redaction benchmark.
 *
 * Every module is imported by absolute path so `--repo` can point at another
 * worktree. A module or export that does not exist there is reported as absent
 * by the caller instead of failing the run.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LineStreamTimeBound, OutputRedactionScope } from "@lando/redaction/line-stream";
import type { Redactor } from "@lando/sdk/secrets";
import { patternValue } from "./bench-redaction-corpus.ts";

// ==== cross-checkout module loading ====

export interface EffectModule {
  readonly Effect: { readonly runSync: (effect: unknown) => unknown };
  readonly Schema: {
    readonly String: unknown;
    readonly Struct: (fields: Record<string, unknown>) => unknown;
    readonly Array: (item: unknown) => unknown;
    readonly Literal: (...values: readonly string[]) => unknown;
    readonly Record: (key: unknown, value: unknown) => unknown;
  };
}

interface SecretsModule {
  readonly createRedactor: (
    profile: "secrets",
    options?: {
      readonly values?: Iterable<string>;
      readonly wholeTokenValues?: Iterable<string>;
    },
  ) => Redactor;
}

interface LineStreamModule {
  readonly redactLineSequence: (
    scope: OutputRedactionScope,
    lines: readonly string[],
    options?: unknown,
  ) => ReadonlyArray<string | undefined>;
}

interface LiveChannelModule {
  readonly createLiveChannel: (options: {
    readonly kind: "bytes" | "record";
    readonly redactor: Pick<Redactor, "redactString" | "redactPrefix">;
    readonly payloadValues: () => Iterable<string>;
    readonly timeBound?: LineStreamTimeBound;
  }) => {
    readonly feed: (line: string | Uint8Array) => Uint8Array | undefined;
    readonly end: () => Uint8Array;
    readonly queue: readonly { readonly chunk: string }[];
    readonly shift: () => void;
  };
}

interface CommandResultModule {
  readonly encodeCommandResult: (options: Record<string, unknown>) => unknown;
}

interface BoundedJsonModule {
  readonly redactBoundedJsonValue: (value: unknown, redactor: Redactor, context: string) => unknown;
}

const loadModule = async <T>(path: string): Promise<T | undefined> => {
  if (!(await Bun.file(path).exists())) return undefined;
  return (await import(pathToFileURL(path).href)) as T;
};

const loadEffect = async (repo: string): Promise<EffectModule | undefined> => {
  try {
    const path = Bun.resolveSync("effect", join(repo, "sdk"));
    return (await import(pathToFileURL(path).href)) as EffectModule;
  } catch {
    return undefined;
  }
};

export interface LoadedApi {
  readonly repo: string;
  readonly secrets: SecretsModule;
  readonly lineStream: LineStreamModule | undefined;
  readonly liveChannel: LiveChannelModule | undefined;
  readonly commandResult: CommandResultModule | undefined;
  readonly boundedJson: BoundedJsonModule | undefined;
  readonly effect: EffectModule | undefined;
}

export const loadApi = async (repo: string): Promise<LoadedApi> => {
  const secrets = await loadModule<SecretsModule>(join(repo, "sdk/src/secrets/index.ts"));
  if (secrets === undefined) {
    throw new Error(`@lando/sdk/secrets is not present in ${repo}`);
  }
  return {
    repo,
    secrets,
    lineStream: await loadModule(join(repo, "redaction/src/line-stream.ts")),
    liveChannel: await loadModule(join(repo, "redaction/src/live-channel.ts")),
    commandResult: await loadModule(join(repo, "sdk/src/command-result/index.ts")),
    boundedJson: await loadModule(join(repo, "mcp/src/bounded-json.ts")),
    effect: await loadEffect(repo),
  };
};

// ==== command result workload ====

const SERVICE_COUNT = 20;
const ENV_ENTRIES = 40;
const LABEL_ENTRIES = 10;

interface EnvelopeWorkload {
  readonly resultSchema: unknown;
  readonly value: unknown;
}

/**
 * An `app:config`-sized result: literal enums the structural policy may keep,
 * index-signature maps it must redact, and secret-named environment entries.
 */
export const buildEnvelopeWorkload = (effect: EffectModule): EnvelopeWorkload => {
  const { Schema: S } = effect;
  const serviceSchema = S.Struct({
    name: S.String,
    type: S.String,
    version: S.String,
    image: S.String,
    status: S.Literal("running"),
    urls: S.Array(S.String),
    environment: S.Record(S.String, S.String),
    labels: S.Record(S.String, S.String),
  });
  const resultSchema = S.Struct({
    name: S.String,
    root: S.String,
    provider: S.String,
    status: S.Literal("running"),
    services: S.Array(serviceSchema),
    tooling: S.Record(S.String, S.String),
  });
  const services = Array.from({ length: SERVICE_COUNT }, (_, service) => ({
    name: `service${service}`,
    type: service % 2 === 0 ? "php:8.3" : "mariadb:10.11",
    version: service % 2 === 0 ? "8.3" : "10.11",
    image: service % 2 === 0 ? "lando/php:8.3" : "lando/mariadb:10.11",
    status: "running" as const,
    urls: [`https://service${service}.lndo.site`, `http://service${service}.lndo.site:8080`],
    environment: Object.fromEntries(
      Array.from({ length: ENV_ENTRIES }, (_, entry) =>
        entry % 5 === 0
          ? [`DB_PASSWORD_${entry}`, patternValue((service + entry) % 20)]
          : [`APP_VAR_${entry}`, `value-${service}-${entry}`],
      ),
    ),
    labels: Object.fromEntries(
      Array.from({ length: LABEL_ENTRIES }, (_, label) => [`label-${label}`, `service-${service}-${label}`]),
    ),
  }));
  return {
    resultSchema,
    value: {
      name: "bench-app",
      root: "/home/bench/app",
      provider: "lando",
      status: "running",
      services,
      tooling: { php: "php", composer: "composer", mysql: "mysql", node: "node" },
    },
  };
};
