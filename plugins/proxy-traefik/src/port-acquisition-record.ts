import { PortNumber } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { acquisitionStateFile } from "./proxy-paths.ts";
import type { ProxyFileSystem, ProxyPaths } from "./proxy-types.ts";

const AcquisitionFingerprintSchema = Schema.Struct({
  http: Schema.Array(PortNumber),
  https: Schema.Array(PortNumber),
  bindAddress: Schema.String,
});

const commonFields = {
  httpPort: PortNumber,
  httpsPort: PortNumber,
  notices: Schema.Array(Schema.String),
  fingerprint: AcquisitionFingerprintSchema,
  appliedFingerprint: Schema.optionalKey(AcquisitionFingerprintSchema),
};
const inactiveFields = {
  ...commonFields,
  helperInstalled: Schema.optionalKey(Schema.Boolean),
  socketsActive: Schema.optionalKey(Schema.Literal(false)),
  bindHttpPort: Schema.optionalKey(Schema.Never),
  bindHttpsPort: Schema.optionalKey(Schema.Never),
};

export const AcquisitionState = Schema.Union([
  Schema.Struct({ ...inactiveFields, mode: Schema.Literal("direct") }),
  Schema.Struct({ ...inactiveFields, mode: Schema.Literal("occupied-hop") }),
  Schema.Struct({ ...inactiveFields, mode: Schema.Literal("needs-helper") }),
  Schema.Struct({
    ...commonFields,
    mode: Schema.Literal("socket-helper"),
    helperInstalled: Schema.Literal(true),
    socketsActive: Schema.Literal(true),
    bindHttpPort: PortNumber,
    bindHttpsPort: PortNumber,
  }),
]);
export type AcquisitionState = typeof AcquisitionState.Type;

export const writeAcquisitionState = (
  fileSystem: ProxyFileSystem,
  paths: ProxyPaths,
  decision: AcquisitionState,
): Effect.Effect<void, unknown> =>
  fileSystem.writeAtomic(acquisitionStateFile(paths), `${JSON.stringify(decision)}\n`);

export const readAcquisitionState = (
  fileSystem: ProxyFileSystem,
  paths: ProxyPaths,
): Effect.Effect<AcquisitionState | undefined> =>
  fileSystem.readText(acquisitionStateFile(paths)).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(AcquisitionState)(JSON.parse(text)),
        catch: (error) => error,
      }),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );
