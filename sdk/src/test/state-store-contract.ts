import { dirname } from "node:path";

import { Cause, Effect, Either, Option, Schema } from "effect";

import { StateStoreError } from "../errors/index.ts";

import { AbsolutePath } from "../schema/index.ts";
import type { StateBucketSpec, StateStoreShape } from "../services/index.ts";
import { ContractFailure, bytesEqual, decodeUtf8, utf8 } from "./_shared.ts";
const stateStoreContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `StateStore contract failed: ${assertion}`, assertion, details });

const requireStateStoreContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(stateStoreContractFailure(assertion, details));

/**
 * A backend-agnostic view of a `StateStore` implementation that the state-store
 * contract suite drives. `store` is the implementation under test, `root` is a
 * fresh isolated `{ path }` root stamped onto every bucket spec, and the raw
 * hooks expose just enough storage inspection to assert durable framing,
 * atomicity, quarantine sidecars, and optional disk-only stale lock takeover.
 */
export interface StateStoreContractHarness {
  readonly name?: string;
  readonly store: StateStoreShape;
  readonly root: AbsolutePath;
  readonly readRaw: (file: AbsolutePath) => Effect.Effect<Uint8Array | null>;
  readonly list: (dir: AbsolutePath) => Effect.Effect<ReadonlyArray<string>>;
  readonly writeRaw: (file: AbsolutePath, bytes: Uint8Array | string) => Effect.Effect<void>;
  readonly plantStaleLock?: (file: AbsolutePath) => Effect.Effect<void>;
}

const StateStoreContractDoc = Schema.Struct({ count: Schema.Number, label: Schema.String });
type StateStoreContractDoc = typeof StateStoreContractDoc.Type;

const StateStoreContractLine = Schema.Struct({ value: Schema.String });
type StateStoreContractLine = typeof StateStoreContractLine.Type;

const StateStoreContractLegacyDoc = Schema.Struct({ n: Schema.Number });

const StateStoreContractMigratedDoc = Schema.Struct({
  count: Schema.Number,
  label: Schema.String,
  from: Schema.Number,
});
type StateStoreContractMigratedDoc = typeof StateStoreContractMigratedDoc.Type;

const stateStoreDocSpec = (
  harness: StateStoreContractHarness,
  key: string,
  overrides: Partial<StateBucketSpec<StateStoreContractDoc, StateStoreContractDoc>> = {},
): StateBucketSpec<StateStoreContractDoc, StateStoreContractDoc> => ({
  root: { path: harness.root },
  key,
  schema: StateStoreContractDoc,
  version: 1,
  ...overrides,
});

const stateStoreMigratedDocSpec = (
  harness: StateStoreContractHarness,
  key: string,
  overrides: Partial<StateBucketSpec<StateStoreContractMigratedDoc, StateStoreContractMigratedDoc>> = {},
): StateBucketSpec<StateStoreContractMigratedDoc, StateStoreContractMigratedDoc> => ({
  root: { path: harness.root },
  key,
  schema: StateStoreContractMigratedDoc,
  version: 2,
  ...overrides,
});

const encodeStateStoreContractLine = (value: StateStoreContractLine): string => `LANDO-RAW\n${value.value}\n`;

const stateStoreLineSpec = (
  harness: StateStoreContractHarness,
  key: string,
): StateBucketSpec<StateStoreContractLine, StateStoreContractLine> => ({
  root: { path: harness.root },
  key,
  schema: StateStoreContractLine,
  version: 1,
  codec: {
    encode: encodeStateStoreContractLine,
    decode: (raw) => ({ value: decodeUtf8(raw).split("\n")[1] ?? "" }),
  },
});

const stateStoreJsonEnvelopeBytes = (version: number, data: unknown): Uint8Array =>
  utf8(`${JSON.stringify({ version, data }, null, 2)}\n`);

const stateStoreDirname = (file: AbsolutePath): AbsolutePath =>
  Schema.decodeUnknownSync(AbsolutePath)(dirname(file));

const stateStoreRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : null;

const requireStateStoreRaw = (
  raw: Uint8Array | null,
  assertion: string,
): Effect.Effect<Uint8Array, ContractFailure> =>
  raw === null ? Effect.fail(stateStoreContractFailure(assertion, raw)) : Effect.succeed(raw);

const parseStateStoreJson = (raw: Uint8Array, assertion: string): Effect.Effect<unknown, ContractFailure> =>
  Effect.try({
    try: () => JSON.parse(decodeUtf8(raw)) as unknown,
    catch: (cause) => stateStoreContractFailure(assertion, cause),
  });

const stateStoreContractCauseFailure = (assertion: string, cause: Cause.Cause<unknown>): ContractFailure => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    return failure.value instanceof ContractFailure
      ? failure.value
      : stateStoreContractFailure(assertion, failure.value);
  }
  return stateStoreContractFailure(assertion, Cause.pretty(cause));
};

/**
 * Run the `StateStore` contract assertions against a harness. Asserts (in
 * order): json, binary, and custom codec round-trips plus observable framing;
 * successful `set` leaves no temp file and fully replaces prior content;
 * version-mismatch `discard` and migrator behavior; corruption quarantine and
 * fail behavior; key/namespace containment rejection; and advisory-lock
 * concurrent update serialization plus optional stale lock takeover.
 */
export const runStateStoreContract = (
  harness: StateStoreContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const store = harness.store;
    const failWith =
      (assertion: string) =>
      (cause: unknown): ContractFailure =>
        stateStoreContractFailure(assertion, cause);

    // 1. Codec round-trip: json, binary, and custom raw codec.
    const jsonBucket = yield* store
      .open(stateStoreDocSpec(harness, "codec-json.json"))
      .pipe(Effect.mapError(failWith("open resolves for a json bucket")));
    yield* jsonBucket.set({ count: 3, label: "json" }).pipe(Effect.mapError(failWith("json set resolves")));
    const jsonValue = yield* jsonBucket.get.pipe(Effect.mapError(failWith("json get resolves")));
    yield* requireStateStoreContract(
      jsonValue?.count === 3 && jsonValue.label === "json",
      "json codec set/get round-trips a schema value",
      jsonValue,
    );
    const jsonRaw = yield* requireStateStoreRaw(
      yield* harness.readRaw(jsonBucket.path),
      "json codec writes a file",
    );
    const jsonEnvelope = stateStoreRecord(
      yield* parseStateStoreJson(jsonRaw, "json codec writes a parseable envelope"),
    );
    const jsonEnvelopeData = stateStoreRecord(jsonEnvelope?.data);
    yield* requireStateStoreContract(
      jsonEnvelope?.version === 1 && jsonEnvelopeData?.count === 3 && jsonEnvelopeData.label === "json",
      "json codec writes a { version, data } envelope",
      jsonEnvelope,
    );

    const binaryBucket = yield* store
      .open(stateStoreDocSpec(harness, "codec-binary.bin", { codec: "binary" }))
      .pipe(Effect.mapError(failWith("open resolves for a binary bucket")));
    yield* binaryBucket
      .set({ count: 4, label: "binary" })
      .pipe(Effect.mapError(failWith("binary set resolves")));
    const binaryValue = yield* binaryBucket.get.pipe(Effect.mapError(failWith("binary get resolves")));
    yield* requireStateStoreContract(
      binaryValue?.count === 4 && binaryValue.label === "binary",
      "binary codec set/get round-trips a schema value",
      binaryValue,
    );
    const binaryRaw = yield* requireStateStoreRaw(
      yield* harness.readRaw(binaryBucket.path),
      "binary codec writes a file",
    );
    yield* requireStateStoreContract(
      binaryRaw.byteLength >= 8 &&
        binaryRaw[0] === 0x4c &&
        binaryRaw[1] === 0x53 &&
        binaryRaw[2] === 0x42 &&
        binaryRaw[3] === 0x31,
      "binary codec writes the LSB1 magic header",
      Array.from(binaryRaw.slice(0, 4)),
    );
    const binaryVersion = new DataView(binaryRaw.buffer, binaryRaw.byteOffset + 4, 4).getUint32(0, false);
    const binaryEnvelopeData = stateStoreRecord(
      yield* parseStateStoreJson(binaryRaw.slice(8), "binary codec writes a JSON payload"),
    );
    yield* requireStateStoreContract(
      binaryVersion === 1 && binaryEnvelopeData?.count === 4 && binaryEnvelopeData.label === "binary",
      "binary codec writes a versioned JSON body after the magic header",
      { version: binaryVersion, data: binaryEnvelopeData },
    );

    const customBucket = yield* store
      .open(stateStoreLineSpec(harness, "codec-custom.raw"))
      .pipe(Effect.mapError(failWith("open resolves for a custom-codec bucket")));
    yield* customBucket.set({ value: "custom" }).pipe(Effect.mapError(failWith("custom-codec set resolves")));
    const customValue = yield* customBucket.get.pipe(Effect.mapError(failWith("custom-codec get resolves")));
    yield* requireStateStoreContract(
      customValue?.value === "custom",
      "custom codec set/get round-trips a decoded value",
      customValue,
    );
    const customRaw = yield* requireStateStoreRaw(
      yield* harness.readRaw(customBucket.path),
      "custom codec writes a file",
    );
    yield* requireStateStoreContract(
      bytesEqual(customRaw, utf8(encodeStateStoreContractLine({ value: "custom" }))),
      "custom codec writes the raw encode() bytes without a frame",
      decodeUtf8(customRaw),
    );

    // 2. Atomic replace: no temp leftovers and replacement is complete.
    const atomicBucket = yield* store
      .open(stateStoreDocSpec(harness, "atomic.json"))
      .pipe(Effect.mapError(failWith("open resolves for an atomic bucket")));
    yield* atomicBucket
      .set({ count: 1, label: "old" })
      .pipe(Effect.mapError(failWith("atomic first set resolves")));
    yield* atomicBucket
      .set({ count: 2, label: "new" })
      .pipe(Effect.mapError(failWith("atomic replacement set resolves")));
    const atomicEntries = yield* harness.list(stateStoreDirname(atomicBucket.path));
    yield* requireStateStoreContract(
      atomicEntries.every((entry) => !entry.includes(".tmp-")),
      "a successful set leaves no *.tmp-* file behind",
      atomicEntries,
    );
    const atomicRaw = yield* requireStateStoreRaw(
      yield* harness.readRaw(atomicBucket.path),
      "atomic replacement writes the destination file",
    );
    const atomicEnvelope = stateStoreRecord(
      yield* parseStateStoreJson(atomicRaw, "atomic replacement leaves a complete JSON envelope"),
    );
    const atomicData = stateStoreRecord(atomicEnvelope?.data);
    yield* requireStateStoreContract(
      atomicEnvelope?.version === 1 && atomicData?.count === 2 && atomicData.label === "new",
      "a replacement set fully replaces the prior value",
      atomicEnvelope,
    );

    // 3. Version mismatch: discard returns default; migrator receives raw data and source version.
    const discardSeed = yield* store
      .open(stateStoreDocSpec(harness, "version-discard.json"))
      .pipe(Effect.mapError(failWith("open resolves for the discard seed bucket")));
    yield* harness.writeRaw(discardSeed.path, stateStoreJsonEnvelopeBytes(1, { count: 1, label: "old" }));
    const discardBucket = yield* store
      .open(
        stateStoreDocSpec(harness, "version-discard.json", {
          version: 2,
          onVersionMismatch: "discard",
          default: { count: 0, label: "default" },
        }),
      )
      .pipe(Effect.mapError(failWith("open resolves for version discard")));
    const discarded = yield* discardBucket.get.pipe(
      Effect.mapError(failWith("version discard get resolves")),
    );
    yield* requireStateStoreContract(
      discarded?.count === 0 && discarded.label === "default",
      "onVersionMismatch discard returns the declared default",
      discarded,
    );

    const migrateSeed = yield* store
      .open(stateStoreMigratedDocSpec(harness, "version-migrate.json", { version: 1 }))
      .pipe(Effect.mapError(failWith("open resolves for the migrate seed bucket")));
    yield* harness.writeRaw(migrateSeed.path, stateStoreJsonEnvelopeBytes(1, { n: 4 }));
    const migrateBucket = yield* store
      .open(
        stateStoreMigratedDocSpec(harness, "version-migrate.json", {
          version: 2,
          onVersionMismatch: (raw, fromVersion) => {
            const legacy = Schema.decodeUnknownSync(StateStoreContractLegacyDoc)(raw);
            return { count: legacy.n, label: "migrated", from: fromVersion };
          },
        }),
      )
      .pipe(Effect.mapError(failWith("open resolves for version migration")));
    const migrated = yield* migrateBucket.get.pipe(
      Effect.mapError(failWith("version migrator get resolves")),
    );
    yield* requireStateStoreContract(
      migrated?.count === 4 && migrated.label === "migrated" && migrated.from === 1,
      "a StateMigrator receives the raw payload and source version",
      migrated,
    );

    // 4. Corruption handling: quarantine sidecar and fail mode.
    const quarantineSeed = yield* store
      .open(stateStoreDocSpec(harness, "corrupt-quarantine.json"))
      .pipe(Effect.mapError(failWith("open resolves for the quarantine seed bucket")));
    yield* harness.writeRaw(quarantineSeed.path, "{ this is not json");
    const quarantineBucket = yield* store
      .open(
        stateStoreDocSpec(harness, "corrupt-quarantine.json", {
          onCorrupt: "quarantine",
          default: { count: 9, label: "quarantined" },
        }),
      )
      .pipe(Effect.mapError(failWith("open resolves for corruption quarantine")));
    const quarantined = yield* quarantineBucket.get.pipe(
      Effect.mapError(failWith("corruption quarantine get resolves")),
    );
    yield* requireStateStoreContract(
      quarantined?.count === 9 && quarantined.label === "quarantined",
      "onCorrupt quarantine returns the declared default",
      quarantined,
    );
    const quarantineEntries = yield* harness.list(stateStoreDirname(quarantineBucket.path));
    yield* requireStateStoreContract(
      quarantineEntries.some((entry) => entry.startsWith("corrupt-quarantine.json.corrupt-")) &&
        !quarantineEntries.includes("corrupt-quarantine.json"),
      "onCorrupt quarantine renames the bad file to a sidecar and removes the original key",
      quarantineEntries,
    );

    const corruptFailSeed = yield* store
      .open(stateStoreDocSpec(harness, "corrupt-fail.json"))
      .pipe(Effect.mapError(failWith("open resolves for the fail seed bucket")));
    yield* harness.writeRaw(corruptFailSeed.path, "not-json-at-all");
    const corruptFailBucket = yield* store
      .open(stateStoreDocSpec(harness, "corrupt-fail.json", { onCorrupt: "fail" }))
      .pipe(Effect.mapError(failWith("open resolves for corruption fail mode")));
    const corruptFail = yield* Effect.either(corruptFailBucket.get);
    yield* requireStateStoreContract(
      Either.isLeft(corruptFail) &&
        corruptFail.left instanceof StateStoreError &&
        corruptFail.left.reason === "decode" &&
        corruptFail.left.operation === "get",
      'onCorrupt "fail" surfaces a StateStoreError with reason decode',
      corruptFail,
    );

    // 5. Path containment: reject escaping key and namespace during open.
    const keyEscape = yield* Effect.either(store.open(stateStoreDocSpec(harness, "../escape.json")));
    yield* requireStateStoreContract(
      Either.isLeft(keyEscape) && keyEscape.left.reason === "path" && keyEscape.left.operation === "open",
      "a key escaping the state root is rejected with reason path",
      keyEscape,
    );
    const namespaceEscape = yield* Effect.either(
      store.open(stateStoreDocSpec(harness, "inside.json", { namespace: "../up" })),
    );
    yield* requireStateStoreContract(
      Either.isLeft(namespaceEscape) &&
        namespaceEscape.left.reason === "path" &&
        namespaceEscape.left.operation === "open",
      "a namespace escaping the state root is rejected with reason path",
      namespaceEscape,
    );

    // 6. Advisory lock: concurrent updates serialize; stale lock takeover is optional.
    const lockedBucket = yield* store
      .open(
        stateStoreDocSpec(harness, "locked.json", {
          lock: "advisory",
          default: { count: 0, label: "locked" },
        }),
      )
      .pipe(Effect.mapError(failWith("open resolves for an advisory bucket")));
    yield* Effect.all(
      Array.from({ length: 20 }, () =>
        lockedBucket
          .update((cur) => ({ count: (cur?.count ?? 0) + 1, label: "locked" }))
          .pipe(Effect.mapError(failWith("advisory update resolves"))),
      ),
      { concurrency: "unbounded" },
    );
    const locked = yield* lockedBucket.get.pipe(Effect.mapError(failWith("advisory final get resolves")));
    yield* requireStateStoreContract(
      locked?.count === 20,
      "an advisory bucket serializes concurrent updates without lost writes",
      locked,
    );
    if (harness.plantStaleLock !== undefined) {
      yield* harness.plantStaleLock(lockedBucket.path);
      const afterStale = yield* lockedBucket
        .update((cur) => ({ count: (cur?.count ?? 0) + 1, label: "locked" }))
        .pipe(Effect.mapError(failWith("advisory stale-lock takeover update resolves")));
      yield* requireStateStoreContract(
        afterStale.count === 21,
        "an advisory bucket takes over a stale lock and completes the update",
        afterStale,
      );
    }
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.fail(stateStoreContractCauseFailure("StateStore contract completes without defects", cause)),
    ),
  );
