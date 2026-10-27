import { expect, test } from "bun:test";
import { type EngineHttpRequest, buildContainerRemoveRequest } from "@lando/container-runtime/engine-api";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makePodmanApiClient } from "@lando/provider-lando";
import type { ServiceImageIdentity } from "@lando/sdk/services";
import { Effect, Schema, Stream } from "effect";
import { serviceTypes } from "../src/index.ts";
import { PHP_VIA_MODES, phpImageFor } from "../src/services/php-via.ts";
import { STATIC_SERVER_IMAGES } from "../src/services/static.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const socket = resolveLiveProviderSocket();
const imageTimeout = 300_000;
const imageConfig = Schema.Struct({ Config: Schema.Struct({ User: Schema.optional(Schema.String) }) });
const createdContainer = Schema.Struct({ Id: Schema.String });
const catalog = [...serviceTypes].flatMap(([id, type]) => {
  if (type.identity === undefined) return [];
  const version = id.split(":")[1] ?? type.versions?.[0];
  const artifact = version === undefined ? undefined : type.artifacts?.[version];
  const staticServer =
    id === "static:caddy" ? "caddy" : id === "static" || id === "static:nginx" ? "nginx" : undefined;
  // These single-image types select their artifact in the feature, not an artifacts map.
  if (artifact === undefined && staticServer === undefined && id !== "apache" && id !== "nginx") return [];
  const images =
    artifact !== undefined
      ? [artifact]
      : staticServer !== undefined
        ? [STATIC_SERVER_IMAGES[staticServer]]
        : [];
  if (id.startsWith("php:") && version !== undefined) {
    images.push(...PHP_VIA_MODES.map((via) => phpImageFor(version, via)));
  }
  return [{ id, type, identity: type.identity, images: [...new Set(images)] }];
});

type PasswdEntry = { readonly name: string; readonly uid: number; readonly home: string };
type HomeHeader = { readonly uid: number; readonly mode: number; readonly type: string };
type ImageFacts = {
  readonly user: string;
  readonly passwd: readonly PasswdEntry[];
  readonly homes: ReadonlyMap<string, HomeHeader>;
  readonly alreadyPresent: boolean;
};
const observations = new Map<string, Promise<ImageFacts>>();
const field = (bytes: Uint8Array, start: number, size: number): string =>
  new TextDecoder()
    .decode(bytes.subarray(start, start + size))
    .replace(/\0.*$/su, "")
    .trim();

const inspectImage = async (image: string, identity: ServiceImageIdentity): Promise<ImageFacts> => {
  if (socket === undefined) throw new Error("A live Podman socket is required");
  const api = makePodmanApiClient(socket.socketPath);
  const request = api.request;
  const stream = api.stream;
  if (request === undefined || stream === undefined) throw new Error("Podman HTTP APIs are required");
  const signal = AbortSignal.timeout(imageTimeout);
  const call = async (input: EngineHttpRequest) => {
    const response = await Effect.runPromise(request({ ...input, signal: input.signal ?? signal }));
    expect(response.status, `${image}: ${input.method} ${input.path}: ${response.body}`).toBeLessThan(300);
    expect(response.status, image).toBeGreaterThanOrEqual(200);
    return response;
  };
  const imagePath = `/images/${encodeURIComponent(image)}` as const;
  const existing = await Effect.runPromise(request({ method: "GET", path: `${imagePath}/json`, signal }));
  expect([200, 404], `${image}: inspect before pull: ${existing.body}`).toContain(existing.status);
  const alreadyPresent = existing.status === 200;
  let container: string | undefined;
  try {
    if (!alreadyPresent) {
      const pulled = await call({
        method: "POST",
        path: `/images/create?fromImage=${encodeURIComponent(image)}`,
      });
      // The compat pull endpoint can report a registry failure inside an HTTP 200 stream.
      for (const line of pulled.body.trim().split("\n").filter(Boolean)) {
        const event = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.optional(Schema.String) }))(
          JSON.parse(line),
        );
        expect(event.error, `${image}: image pull failed`).toBeUndefined();
      }
    }
    const inspected = await call({ method: "GET", path: `${imagePath}/json` });
    const config = Schema.decodeUnknownSync(imageConfig)(JSON.parse(inspected.body));
    container = `lando-identity-${crypto.randomUUID()}`;
    const created = await call({
      method: "POST",
      path: `/containers/create?name=${container}`,
      // Never start the image, and do not require it to contain a shell or runnable default command.
      body: { Image: image, Cmd: ["lando-identity-inspect"], NetworkDisabled: true },
    });
    container = Schema.decodeUnknownSync(createdContainer)(JSON.parse(created.body)).Id;
    const archivePath = (path: string): `/containers/${string}` =>
      `/containers/${encodeURIComponent(container ?? "")}/archive?path=${encodeURIComponent(path)}`;
    const passwdChunks = await Effect.runPromise(
      stream({ method: "GET", path: archivePath("/etc/passwd"), signal }).pipe(Stream.runCollect),
    );
    const archive = Buffer.concat([...passwdChunks]);
    let passwdText: string | undefined;
    for (let offset = 0; offset + 512 <= archive.length; ) {
      const size = Number.parseInt(field(archive, offset + 124, 12), 8) || 0;
      if (field(archive, offset, 100).replace(/^.*\//u, "") === "passwd") {
        passwdText = archive.subarray(offset + 512, offset + 512 + size).toString();
        break;
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(passwdText, `${image}: archive must contain /etc/passwd`).toBeDefined();
    const passwd = (passwdText ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name = "", , uid = "", , , home = ""] = line.split(":");
        return { name, uid: Number(uid), home };
      });
    const homes = new Map<string, HomeHeader>();
    const claims = catalog.filter((entry) => entry.images.includes(image)).map((entry) => entry.identity);
    claims.push(identity);
    const wanted = new Set(
      claims.flatMap((claim) =>
        Object.entries(claim.homes)
          .filter(
            ([principal]) =>
              principal !== "root" && principal !== "0" && !claim.preparedHomes?.includes(principal),
          )
          .map(([, home]) => home),
      ),
    );
    if (wanted.size > 0) {
      // Podman /archive chowns tar headers to the configured user. /export preserves actual inode ownership.
      // Keep only one header in memory, skip file bodies, and cancel as soon as all home headers are found.
      const header = Buffer.alloc(512);
      let filled = 0;
      let skip = 0;
      rootfs: for await (const chunk of Stream.toAsyncIterable(
        stream({
          method: "GET",
          path: `/containers/${container}/export`,
          signal,
        }),
      )) {
        let offset = 0;
        while (offset < chunk.length) {
          if (skip > 0) {
            const count = Math.min(skip, chunk.length - offset);
            skip -= count;
            offset += count;
            continue;
          }
          const count = Math.min(512 - filled, chunk.length - offset);
          header.set(chunk.subarray(offset, offset + count), filled);
          filled += count;
          offset += count;
          if (filled < 512) continue;
          const prefix = field(header, 345, 155);
          const path = `/${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`.replace(/\/$/u, "");
          if (wanted.has(path) && !homes.has(path)) {
            homes.set(path, {
              uid: Number.parseInt(field(header, 108, 8), 8),
              mode: Number.parseInt(field(header, 100, 8), 8),
              type: field(header, 156, 1),
            });
            if (homes.size === wanted.size) break rootfs;
          }
          skip = Math.ceil((Number.parseInt(field(header, 124, 12), 8) || 0) / 512) * 512;
          filled = 0;
        }
      }
    }
    return { user: config.Config.User || "root", passwd, homes, alreadyPresent };
  } finally {
    // Separate deadlines keep cleanup possible even when the per-image deadline expires.
    try {
      if (container !== undefined) {
        const removed = await Effect.runPromise(
          request({
            ...buildContainerRemoveRequest(container),
            signal: AbortSignal.timeout(30_000),
          }),
        );
        expect([200, 204, 404], `${image}: container cleanup: ${removed.body}`).toContain(removed.status);
      }
    } finally {
      if (!alreadyPresent) {
        // Do not force removal: another process may now be using this image.
        const removed = await Effect.runPromise(
          request({
            method: "DELETE",
            path: imagePath,
            signal: AbortSignal.timeout(30_000),
          }),
        );
        expect([200, 204, 404], `${image}: cleanup newly pulled image: ${removed.body}`).toContain(
          removed.status,
        );
      }
    }
  }
};

for (const entry of catalog) {
  test.skipIf(socket === undefined)(
    `${entry.id} image identity and home ownership`,
    async () => {
      // Given the registered type's default artifact(s).
      const images = entry.id.includes(":") ? [...entry.images] : [];
      if (images.length === 0) {
        const plan = await composeServicePlan({
          serviceType: entry.type,
          service: { type: entry.id },
          appRoot: import.meta.dirname,
          metadata: { resolvedAt: "2026-01-01T00:00:00.000Z", source: "identity-live", runtime: 4 },
        });
        expect(plan.artifact?.kind, entry.id).toBe("ref");
        if (plan.artifact?.kind === "ref") images.push(plan.artifact.ref);
      }
      expect(images.length, entry.id).toBeGreaterThan(0);
      // When each distinct image is inspected, with at most two images in flight.
      const failures: unknown[] = [];
      for (let index = 0; index < images.length; index += 2) {
        const results = await Promise.allSettled(
          images.slice(index, index + 2).map(async (image) => {
            let observation = observations.get(image);
            if (observation === undefined) {
              observation = inspectImage(image, entry.identity);
              observations.set(image, observation);
            }
            const facts = await observation;
            const context = `${entry.id} (${image}, alreadyPresent=${facts.alreadyPresent}): update identity / preparedHomes`;
            const uidFor = (user: string) => {
              const principal = user.split(":")[0] ?? "";
              return /^\d+$/u.test(principal)
                ? Number(principal)
                : facts.passwd.find((row) => row.name === principal)?.uid;
            };
            // Then image defaults and passwd homes agree with the catalog.
            expect(uidFor(facts.user), `${context}; image User=${facts.user}`).toBeDefined();
            expect(uidFor(facts.user), `${context}; defaultUser=${entry.identity.defaultUser}`).toBe(
              uidFor(entry.identity.defaultUser),
            );
            for (const [principal, home] of Object.entries(entry.identity.homes)) {
              const account = facts.passwd.find(
                (row) => row.name === principal || String(row.uid) === principal,
              );
              expect(account, `${context}; missing passwd principal ${principal}`).toBeDefined();
              expect(account?.home, `${context}; passwd home for ${principal}`).toBe(home);
              if (account?.uid === 0 || entry.identity.preparedHomes?.includes(principal)) continue;
              const header = facts.homes.get(home);
              expect(header?.type, `${context}; ${home} must be a directory`).toBe("5");
              expect(header?.uid, `${context}; ${home} owner for ${principal}`).toBe(account?.uid);
              expect(
                (header?.mode ?? 0) & 0o300,
                `${context}; ${home} must allow its owner to write and search`,
              ).toBe(0o300);
            }
          }),
        );
        for (const result of results) {
          if (result.status === "rejected") failures.push(result.reason);
        }
      }
      if (failures.length > 0)
        throw new AggregateError(failures, `${entry.id}: image identity / preparedHomes mismatch`);
    },
    3 * imageTimeout + 120_000,
  );
}
