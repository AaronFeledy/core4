import { createHash, randomBytes } from "node:crypto";

import { Effect, Schema } from "effect";

import type { EngineHttpRequest, PodmanApiClient } from "@lando/container-runtime/engine-api";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { fileSyncVolumeName } from "@lando/sdk/schema";

const TARGET_PATH = "/sync";
const ENTRYPOINT = ["sh", "-c"] as const;
const KEEP_ALIVE = ["while :; do sleep 3600; done"] as const;
const HELPER_USER = "0:0";
const ReceiptSchema = Schema.Struct({
  specDigest: Schema.String,
  volumeNonce: Schema.String,
  volumeCreatedAt: Schema.NullOr(Schema.String),
  helperNonce: Schema.String,
  containerId: Schema.NullOr(Schema.String),
  removing: Schema.optional(Schema.Boolean),
  volumeSpecDigest: Schema.optional(Schema.String),
  upgradingTo: Schema.optional(Schema.String),
});
type Receipt = typeof ReceiptSchema.Type;
const nonce = (): string => randomBytes(32).toString("hex");
const receiptKey = (spec: WindowsSyncHelperSpec): string =>
  `${createHash("sha256")
    .update(JSON.stringify([spec.appId, spec.service, spec.mountKey]))
    .digest("hex")}.json`;
const openReceipt = (stateStore: PluginStateStore, spec: WindowsSyncHelperSpec) =>
  stateStore.open({
    namespace: "windows-sync-helpers",
    key: receiptKey(spec),
    schema: ReceiptSchema,
    version: 1,
    codec: "json",
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "fail",
    onVersionMismatch: "discard",
  });
const stateFailure = (cause: unknown): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "syncHelper.receipt",
    message: "Unable to read or update the sync helper ownership receipt.",
    remediation: REMEDIATION,
    cause,
  });
const withReceiptLock = <A, E>(
  stateStore: PluginStateStore,
  spec: WindowsSyncHelperSpec,
  body: Effect.Effect<A, E>,
) =>
  stateStore
    .withLock(`windows-sync-helper-${receiptKey(spec)}`, body)
    .pipe(
      Effect.mapError((cause) => (cause instanceof ProviderUnavailableError ? cause : stateFailure(cause))),
    );

const REMEDIATION =
  "Inspect the named volume and sync helper in the managed Podman machine, then retry with resources owned by this app.";

export interface WindowsSyncHelperSpec {
  readonly appId: string;
  readonly appName: string;
  readonly service: string;
  readonly mountKey: string;
  /** Immutable image reference; the caller selects a helper image with a shell and sleep. */
  readonly image: string;
}

export interface WindowsSyncHelperEndpoint {
  readonly containerId: string;
  readonly containerName: string;
  readonly volumeName: string;
  readonly path: typeof TARGET_PATH;
}

type Api = Pick<PodmanApiClient, "request">;
type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;

const strings = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

const parse = (body: string): JsonRecord | undefined => {
  try {
    return record(JSON.parse(body));
  } catch {
    return undefined;
  }
};

const failure = (operation: string, message: string): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation,
    message,
    remediation: REMEDIATION,
  });

const request = (api: Api, input: EngineHttpRequest) =>
  api.request === undefined
    ? Effect.fail(failure("syncHelper", "The managed Podman API client cannot make requests."))
    : api.request(input);

const sameStrings = (actual: unknown, expected: ReadonlyArray<string>): boolean => {
  const entries = strings(actual);
  return (
    entries !== undefined &&
    entries.length === expected.length &&
    entries.every((entry, index) => entry === expected[index])
  );
};

const sameLabels = (actual: unknown, expected: Readonly<Record<string, string>>): boolean => {
  const labels = record(actual);
  return (
    labels !== undefined &&
    Object.keys(labels).filter((key) => key.startsWith("dev.lando.")).length ===
      Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => labels[key] === value)
  );
};

const emptyCollection = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (Array.isArray(value)
    ? value.length === 0
    : record(value) !== undefined && Object.keys(value).length === 0);

const defaultNamespace = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  value === "private" ||
  value === "shareable" ||
  value === "auto";

const safeHostConfig = (host: JsonRecord | undefined): boolean =>
  host !== undefined &&
  (host.Privileged === undefined || host.Privileged === false) &&
  (host.PublishAllPorts === undefined || host.PublishAllPorts === false) &&
  (host.AutoRemove === undefined || host.AutoRemove === false) &&
  emptyCollection(host.Devices) &&
  emptyCollection(host.DeviceRequests) &&
  emptyCollection(host.PortBindings) &&
  emptyCollection(host.CapAdd) &&
  emptyCollection(host.SecurityOpt) &&
  emptyCollection(host.Sysctls) &&
  emptyCollection(host.VolumesFrom) &&
  defaultNamespace(host.PidMode) &&
  defaultNamespace(host.IpcMode) &&
  defaultNamespace(host.UTSMode) &&
  defaultNamespace(host.UsernsMode) &&
  defaultNamespace(host.CgroupnsMode);

const validSpec = (spec: WindowsSyncHelperSpec): boolean =>
  [spec.appId, spec.appName, spec.service, spec.mountKey].every(
    (part) => part.length > 0 && !part.includes("/") && !part.includes("\0"),
  ) && /@sha256:[a-f0-9]{64}$/u.test(spec.image);

const containerNameForDigest = (spec: WindowsSyncHelperSpec, digest: string): string => {
  const safeApp = spec.appId.replace(/[^a-zA-Z0-9_.-]/gu, "-").slice(0, 32);
  return `lando-sync-${safeApp}-${digest.slice(0, 16)}`;
};

const identity = (spec: WindowsSyncHelperSpec) => {
  const volumeName = fileSyncVolumeName(spec.appName, spec.service, spec.mountKey);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        spec.appId,
        spec.appName,
        spec.service,
        spec.mountKey,
        volumeName,
        spec.image,
        ENTRYPOINT,
        KEEP_ALIVE,
        HELPER_USER,
        TARGET_PATH,
      ]),
    )
    .digest("hex");
  const safeApp = spec.appId.replace(/[^a-zA-Z0-9_.-]/gu, "-").slice(0, 32);
  return {
    volumeName,
    containerName: `lando-sync-${safeApp}-${digest.slice(0, 16)}`,
    digest,
  };
};

const labelsFor = (
  spec: WindowsSyncHelperSpec,
  digest: string,
  kind: "volume" | "helper",
  resourceNonce: string,
): Readonly<Record<string, string>> => ({
  "dev.lando.provider": "lando",
  "dev.lando.app": spec.appId,
  "dev.lando.sync.service": spec.service,
  "dev.lando.sync.mount-key": spec.mountKey,
  "dev.lando.sync.kind": kind,
  "dev.lando.sync.spec-sha256": digest,
  "dev.lando.sync.nonce": resourceNonce,
});

const inspectVolume = (api: Api, name: string) =>
  request(api, { method: "GET", path: `/volumes/${encodeURIComponent(name)}` }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 404) return Effect.succeed(undefined);
      if (response.status !== 200) {
        return Effect.fail(
          failure("syncHelper.volume.inspect", `Podman volume inspect failed with HTTP ${response.status}.`),
        );
      }
      const body = parse(response.body);
      if (body === undefined) {
        return Effect.fail(
          failure("syncHelper.volume.inspect", "Podman returned malformed volume inspect JSON."),
        );
      }
      return Effect.succeed(body);
    }),
  );

const requireOwnedVolume = (
  body: JsonRecord,
  name: string,
  labels: Readonly<Record<string, string>>,
  createdAt: string,
) =>
  body.Name === name &&
  body.Driver === "local" &&
  body.CreatedAt === createdAt &&
  emptyCollection(body.Options) &&
  sameLabels(body.Labels, labels)
    ? Effect.void
    : Effect.fail(
        failure(
          "syncHelper.volume",
          "The sync volume exists with foreign ownership or a different specification.",
        ),
      );

const inspectContainer = (api: Api, name: string) =>
  request(api, { method: "GET", path: `/containers/${encodeURIComponent(name)}/json` }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 404) return Effect.succeed(undefined);
      if (response.status !== 200) {
        return Effect.fail(
          failure(
            "syncHelper.container.inspect",
            `Podman container inspect failed with HTTP ${response.status}.`,
          ),
        );
      }
      const body = parse(response.body);
      if (body === undefined) {
        return Effect.fail(
          failure("syncHelper.container.inspect", "Podman returned malformed container inspect JSON."),
        );
      }
      return Effect.succeed(body);
    }),
  );

const ownedContainerId = (
  body: JsonRecord,
  name: string,
  spec: WindowsSyncHelperSpec,
  volumeName: string,
  labels: Readonly<Record<string, string>>,
  expectedId: string,
): Effect.Effect<string, ProviderUnavailableError> => {
  const config = record(body.Config);
  const host = record(body.HostConfig);
  const policy = record(host?.RestartPolicy);
  const mounts = Array.isArray(body.Mounts) ? body.Mounts : [];
  const mount = mounts.length === 1 ? record(mounts[0]) : undefined;
  const id = body.Id;
  const exact =
    typeof id === "string" &&
    id === expectedId &&
    (body.Name === name || body.Name === `/${name}`) &&
    config?.Image === spec.image &&
    sameStrings(config.Entrypoint, ENTRYPOINT) &&
    sameStrings(config.Cmd, KEEP_ALIVE) &&
    config.User === HELPER_USER &&
    sameLabels(config.Labels, labels) &&
    safeHostConfig(host) &&
    host?.NetworkMode === "none" &&
    policy?.Name === "unless-stopped" &&
    mount?.Type === "volume" &&
    mount.Name === volumeName &&
    mount.Destination === TARGET_PATH &&
    mount.RW === true;
  return exact
    ? Effect.succeed(id)
    : Effect.fail(
        failure(
          "syncHelper.container",
          "The sync helper exists with foreign ownership or a different specification.",
        ),
      );
};

const requireCreatedAt = (body: JsonRecord): Effect.Effect<string, ProviderUnavailableError> =>
  typeof body.CreatedAt === "string" && body.CreatedAt.length > 0
    ? Effect.succeed(body.CreatedAt)
    : Effect.fail(failure("syncHelper.volume", "The sync volume has no durable instance fingerprint."));

const saveReceipt = (stateStore: PluginStateStore, spec: WindowsSyncHelperSpec, receipt: Receipt) =>
  openReceipt(stateStore, spec).pipe(
    Effect.flatMap((bucket) => bucket.set(receipt)),
    Effect.mapError(stateFailure),
  );

const loadReceipt = (stateStore: PluginStateStore, spec: WindowsSyncHelperSpec) =>
  openReceipt(stateStore, spec).pipe(
    Effect.flatMap((bucket) =>
      bucket.exists.pipe(
        Effect.flatMap((exists) => {
          if (!exists) return Effect.succeed<Receipt | null>(null);
          return bucket.get.pipe(
            Effect.flatMap((receipt) =>
              receipt === null
                ? Effect.fail(
                    failure(
                      "syncHelper.receipt",
                      "The sync helper ownership receipt has an unknown version.",
                    ),
                  )
                : Effect.succeed(receipt),
            ),
          );
        }),
      ),
    ),
    Effect.mapError((cause) => (cause instanceof ProviderUnavailableError ? cause : stateFailure(cause))),
  );

const collision = (kind: string) =>
  failure("syncHelper", `The ${kind} exists without a complete matching ownership receipt.`);

const volumeSpecDigest = (receipt: Receipt): string => receipt.volumeSpecDigest ?? receipt.specDigest;

/** Move a verified helper to a new immutable image while retaining its volume. */
const upgradeHelper = (
  api: Api,
  stateStore: PluginStateStore,
  spec: WindowsSyncHelperSpec,
  receipt: Receipt,
  volume: JsonRecord | undefined,
  digest: string,
  volumeName: string,
) =>
  Effect.gen(function* () {
    if (
      receipt.removing === true ||
      receipt.volumeCreatedAt === null ||
      (receipt.upgradingTo !== undefined && receipt.upgradingTo !== spec.image) ||
      receipt.specDigest === digest
    ) {
      return yield* Effect.fail(collision("sync specification"));
    }
    if (volume === undefined) return yield* Effect.fail(collision("sync volume"));
    yield* requireOwnedVolume(
      volume,
      volumeName,
      labelsFor(spec, volumeSpecDigest(receipt), "volume", receipt.volumeNonce),
      receipt.volumeCreatedAt,
    );

    const oldName = containerNameForDigest(spec, receipt.specDigest);
    const oldContainer = yield* inspectContainer(api, oldName);
    if (oldContainer === undefined && receipt.containerId !== null && receipt.upgradingTo === undefined) {
      return yield* Effect.fail(collision("sync helper"));
    }
    if (oldContainer !== undefined) {
      if (receipt.containerId === null) return yield* Effect.fail(collision("sync helper"));
      const oldImage = record(oldContainer.Config)?.Image;
      if (typeof oldImage !== "string" || !validSpec({ ...spec, image: oldImage })) {
        return yield* Effect.fail(collision("sync helper"));
      }
      const oldSpec = { ...spec, image: oldImage };
      if (identity(oldSpec).digest !== receipt.specDigest) {
        return yield* Effect.fail(collision("sync helper"));
      }
      yield* ownedContainerId(
        oldContainer,
        oldName,
        oldSpec,
        volumeName,
        labelsFor(spec, receipt.specDigest, "helper", receipt.helperNonce),
        receipt.containerId,
      );
    }
    const newName = containerNameForDigest(spec, digest);
    if ((yield* inspectContainer(api, newName)) !== undefined) {
      return yield* Effect.fail(collision("sync helper"));
    }
    if (receipt.upgradingTo === undefined) {
      yield* saveReceipt(stateStore, spec, { ...receipt, upgradingTo: spec.image });
    }
    if (oldContainer !== undefined && receipt.containerId !== null) {
      const removed = yield* request(api, {
        method: "DELETE",
        path: `/containers/${encodeURIComponent(receipt.containerId)}?force=true`,
      });
      if (removed.status !== 200 && removed.status !== 204 && removed.status !== 404) {
        return yield* Effect.fail(
          failure("syncHelper.container.remove", `Podman helper remove failed with HTTP ${removed.status}.`),
        );
      }
      if ((yield* inspectContainer(api, oldName)) !== undefined) {
        return yield* Effect.fail(collision("sync helper"));
      }
    }
    const upgraded: Receipt = {
      ...receipt,
      specDigest: digest,
      volumeSpecDigest: volumeSpecDigest(receipt),
      helperNonce: nonce(),
      containerId: null,
      removing: false,
      upgradingTo: undefined,
    };
    yield* saveReceipt(stateStore, spec, upgraded);
    return upgraded;
  });

/** Prepare a persistent Docker-transport target inside the managed Podman machine. */
export const ensureWindowsSyncHelper = (
  api: Api,
  stateStore: PluginStateStore,
  spec: WindowsSyncHelperSpec,
) =>
  withReceiptLock(
    stateStore,
    spec,
    Effect.gen(function* () {
      if (!validSpec(spec)) {
        return yield* Effect.fail(
          failure("syncHelper", "Sync helper identity is invalid or its image is not digest-pinned."),
        );
      }
      const { volumeName, containerName, digest } = identity(spec);
      let receipt = yield* loadReceipt(stateStore, spec);
      let volume = yield* inspectVolume(api, volumeName);
      if (receipt === null) {
        if (volume !== undefined) return yield* Effect.fail(collision("sync volume"));
        const existingHelper = yield* inspectContainer(api, containerName);
        if (existingHelper !== undefined) return yield* Effect.fail(collision("sync helper"));
        receipt = {
          specDigest: digest,
          volumeNonce: nonce(),
          volumeCreatedAt: null,
          helperNonce: nonce(),
          containerId: null,
          removing: false,
        };
        yield* saveReceipt(stateStore, spec, receipt);
      }
      if (receipt.specDigest !== digest || receipt.upgradingTo !== undefined) {
        receipt = yield* upgradeHelper(api, stateStore, spec, receipt, volume, digest, volumeName);
      }
      if (receipt.removing === true) return yield* Effect.fail(collision("sync helper removal"));
      if (volume === undefined) {
        if (receipt.volumeCreatedAt !== null) return yield* Effect.fail(collision("sync volume"));
        const created = yield* request(api, {
          method: "POST",
          path: "/volumes/create",
          body: {
            Name: volumeName,
            Driver: "local",
            Labels: labelsFor(spec, digest, "volume", receipt.volumeNonce),
          },
        });
        if (created.status !== 201 && created.status !== 200) {
          return yield* Effect.fail(
            failure("syncHelper.volume.create", `Podman volume create failed with HTTP ${created.status}.`),
          );
        }
        volume = yield* inspectVolume(api, volumeName);
        if (volume === undefined) return yield* Effect.fail(collision("sync volume"));
        const createdAt = yield* requireCreatedAt(volume);
        yield* requireOwnedVolume(
          volume,
          volumeName,
          labelsFor(spec, digest, "volume", receipt.volumeNonce),
          createdAt,
        );
        receipt = { ...receipt, volumeCreatedAt: createdAt };
        yield* saveReceipt(stateStore, spec, receipt);
      } else {
        if (receipt.volumeCreatedAt === null) return yield* Effect.fail(collision("sync volume"));
        yield* requireOwnedVolume(
          volume,
          volumeName,
          labelsFor(spec, volumeSpecDigest(receipt), "volume", receipt.volumeNonce),
          receipt.volumeCreatedAt,
        );
      }

      let container = yield* inspectContainer(api, containerName);
      if (container === undefined) {
        if (receipt.containerId !== null) {
          return yield* Effect.fail(collision("sync helper"));
        }
        const created = yield* request(api, {
          method: "POST",
          path: `/containers/create?name=${encodeURIComponent(containerName)}`,
          body: {
            Image: spec.image,
            Entrypoint: ENTRYPOINT,
            Cmd: KEEP_ALIVE,
            User: HELPER_USER,
            Labels: labelsFor(spec, digest, "helper", receipt.helperNonce),
            HostConfig: {
              Binds: [`${volumeName}:${TARGET_PATH}:rw`],
              NetworkMode: "none",
              RestartPolicy: { Name: "unless-stopped" },
            },
          },
        });
        if (created.status !== 201 && created.status !== 200) {
          return yield* Effect.fail(
            failure(
              "syncHelper.container.create",
              `Podman helper create failed with HTTP ${created.status}.`,
            ),
          );
        }
        const responseId = parse(created.body)?.Id;
        if (typeof responseId !== "string" || responseId.length === 0) {
          return yield* Effect.fail(collision("sync helper"));
        }
        receipt = { ...receipt, containerId: responseId };
        yield* saveReceipt(stateStore, spec, receipt);
        container = yield* inspectContainer(api, containerName);
        if (container === undefined) return yield* Effect.fail(collision("sync helper"));
        yield* ownedContainerId(
          container,
          containerName,
          spec,
          volumeName,
          labelsFor(spec, digest, "helper", receipt.helperNonce),
          responseId,
        );
      } else if (receipt.containerId === null) {
        return yield* Effect.fail(collision("sync helper"));
      }
      if (receipt.containerId === null) return yield* Effect.fail(collision("sync helper"));
      const containerId = yield* ownedContainerId(
        container,
        containerName,
        spec,
        volumeName,
        labelsFor(spec, digest, "helper", receipt.helperNonce),
        receipt.containerId,
      );
      if (record(container.State)?.Running !== true) {
        const started = yield* request(api, {
          method: "POST",
          path: `/containers/${encodeURIComponent(containerId)}/start`,
        });
        if (started.status !== 204 && started.status !== 304) {
          return yield* Effect.fail(
            failure("syncHelper.container.start", `Podman helper start failed with HTTP ${started.status}.`),
          );
        }
        container = yield* inspectContainer(api, containerName);
        if (container === undefined) return yield* Effect.fail(collision("sync helper"));
        yield* ownedContainerId(
          container,
          containerName,
          spec,
          volumeName,
          labelsFor(spec, digest, "helper", receipt.helperNonce),
          containerId,
        );
        if (record(container.State)?.Running !== true) {
          return yield* Effect.fail(
            failure("syncHelper.container", "The sync helper is not running after start."),
          );
        }
      }
      return {
        containerId,
        containerName,
        volumeName,
        path: TARGET_PATH,
      } satisfies WindowsSyncHelperEndpoint;
    }),
  );

/** Remove only the recorded helper container ID. Named-volume deletion is unsafe through Podman's name-only API. */
export const removeWindowsSyncHelper = (
  api: Api,
  stateStore: PluginStateStore,
  spec: WindowsSyncHelperSpec,
  options: { readonly removeVolume?: boolean } = {},
) =>
  withReceiptLock(
    stateStore,
    spec,
    Effect.gen(function* () {
      if (!validSpec(spec)) {
        return yield* Effect.fail(
          failure("syncHelper.remove", "Sync helper identity is invalid or its image is not digest-pinned."),
        );
      }
      if (options.removeVolume === true) {
        return yield* Effect.fail(
          failure(
            "syncHelper.volume.remove",
            "Automatic sync volume removal requires an instance-conditional Podman API.",
          ),
        );
      }
      const { volumeName, containerName, digest } = identity(spec);
      const receipt = yield* loadReceipt(stateStore, spec);
      const volume = yield* inspectVolume(api, volumeName);
      const container = yield* inspectContainer(api, containerName);
      if (receipt === null) {
        if (volume !== undefined || container !== undefined)
          return yield* Effect.fail(collision("sync resources"));
        return false;
      }
      if (
        receipt.specDigest !== digest ||
        receipt.volumeCreatedAt === null ||
        receipt.upgradingTo !== undefined
      ) {
        return yield* Effect.fail(collision("sync volume"));
      }
      if (volume !== undefined) {
        yield* requireOwnedVolume(
          volume,
          volumeName,
          labelsFor(spec, volumeSpecDigest(receipt), "volume", receipt.volumeNonce),
          receipt.volumeCreatedAt,
        );
      }
      if (container === undefined && receipt.removing !== true) {
        if (receipt.containerId !== null) return yield* Effect.fail(collision("sync helper"));
        return false;
      }
      if (volume === undefined) return yield* Effect.fail(collision("sync volume"));
      if (receipt.containerId === null) return yield* Effect.fail(collision("sync helper"));
      if (container !== undefined) {
        const id = yield* ownedContainerId(
          container,
          containerName,
          spec,
          volumeName,
          labelsFor(spec, digest, "helper", receipt.helperNonce),
          receipt.containerId,
        );
        if (receipt.removing !== true) {
          yield* saveReceipt(stateStore, spec, { ...receipt, removing: true });
        }
        const removed = yield* request(api, {
          method: "DELETE",
          path: `/containers/${encodeURIComponent(id)}?force=true`,
        });
        if (removed.status !== 200 && removed.status !== 204 && removed.status !== 404) {
          return yield* Effect.fail(
            failure(
              "syncHelper.container.remove",
              `Podman helper remove failed with HTTP ${removed.status}.`,
            ),
          );
        }
        if ((yield* inspectContainer(api, containerName)) !== undefined) {
          return yield* Effect.fail(collision("sync helper"));
        }
      }
      yield* saveReceipt(stateStore, spec, {
        ...receipt,
        containerId: null,
        helperNonce: nonce(),
        removing: false,
      });
      return true;
    }),
  );
