import { describe, expect, test } from "bun:test";
import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";
import { createConfigFingerprint } from "@lando/container-runtime/create-fingerprint";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { STOCK_NGINX_IMAGE } from "../src/services/nginx-config.ts";
import { acquireTempAppRoot } from "./support/live-app-scope.ts";
import { planOwnershipFixture, requireWeb } from "./support/php-ownership-stack.ts";

const capabilities = buildProviderCapabilities({
  artifactBuild: true,
  bindMounts: true,
  serviceHealth: "native",
  bindMountPerformance: "native",
  tlsCertificates: "lando",
  rootless: true,
  projectUserMapping: "userns-keep-id",
  bindOwnership: "root-is-host-user",
  composeSpec: "native",
  providerExtensions: [],
});
const worker = { name: "nginx", uid: 101, gid: 101 };
const fpm = ServiceName.make("fpm");

const plan = (
  service: Readonly<Record<string, unknown>>,
  options: { readonly fpm?: boolean; readonly mapping?: "userns-keep-id" | "unsupported" } = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const root = yield* acquireTempAppRoot("nginx-ownership-");
      return yield* planOwnershipFixture(
        root,
        {
          id: "nginx-ownership",
          services: {
            web: { type: "nginx", ...service },
            ...(options.fpm ? { [fpm]: { type: "php:8.3", via: "fpm", port: 9070 } } : {}),
          },
        },
        { ...capabilities, projectUserMapping: options.mapping ?? "userns-keep-id" },
      );
    }).pipe(Effect.scoped),
  );

describe("stock nginx ownership through AppPlanner", () => {
  test.each(["nginx", "static", "static:nginx"])(
    "maps the request worker, not the %s master",
    async (type) => {
      const web = requireWeb(await plan({ type }));
      expect(web.projectUser).toEqual(worker);
      expect(web.user).toBeUndefined();
      expect(web.home).toMatchObject({ state: "unknown", reason: "undeclared-user", user: "nginx" });
      expect(web.mounts.find((mount) => mount.target === "/app")).toMatchObject({
        type: "bind",
        readOnly: type !== "nginx",
      });
    },
  );

  test("maps the nginx edge and PHP worker separately", async () => {
    const planned = await plan({ backend: "fpm" }, { fpm: true });
    const web = requireWeb(planned);
    expect(web.command?.[2]).toContain("fastcgi_pass fpm:9070;");
    expect(web.projectUser).toEqual(worker);
    expect(planned.services[fpm]?.projectUser).toEqual({ name: "www-data", uid: 33, gid: 33 });
  });

  test.each([
    ["Caddy", { type: "static:caddy" }, "unresolved"],
    ["custom image", { image: "nginx:1.27-alpine" }, "unresolved"],
    ["explicit unversioned image equal to stock", { image: STOCK_NGINX_IMAGE }, "unresolved"],
    ["replacement build", { build: { context: "." } }, "unresolved"],
    ["authored command", { command: ["nginx", "-g", "daemon off;"] }, "unresolved"],
    ["authored entrypoint", { type: "static:nginx", entrypoint: ["custom-entrypoint"] }, "unresolved"],
    ["opt-out", { projectUser: false }, "opted-out"],
    ["different named process user", { user: "nobody" }, "unresolved"],
    ["no app bind", { appMount: false, webroot: "/srv/site" }, "not-applicable"],
  ] as const)("keeps %s outside the implicit mapping", async (_label, service, state) => {
    const web = requireWeb(await plan(service));
    expect(web.projectUser).toBeUndefined();
    expect(web.projectUserExplanation?.state).toBe(state);
  });

  test.each([
    ["nginx", worker],
    ["1001:1002", { name: "1001", uid: 1001, gid: 1002 }],
  ])("keeps the authored master user %s and selects the correct command identity", async (user, identity) => {
    const web = requireWeb(await plan({ user }));
    expect(web.user).toBe(user);
    expect(web.projectUser).toEqual(identity);
  });

  test("keeps the root home when implicit mapping is unsupported", async () => {
    const web = requireWeb(await plan({}, { mapping: "unsupported" }));
    expect(web.projectUser).toBeUndefined();
    expect(web.projectUserExplanation?.state).toBe("provider-unsupported");
    expect(web.home).toMatchObject({ state: "persisted", target: "/root", user: "root" });
  });

  test("keeps the same create identity on replay and changes it when mapping is removed", async () => {
    // Plan again in the same app root so only the intended config can change the create identity.
    const [stock, replay, optedOut] = await Effect.runPromise(
      Effect.gen(function* () {
        const root = yield* acquireTempAppRoot("nginx-fingerprint-");
        const service = { type: "nginx", home: false };
        const fixture = { id: "nginx-fingerprint", services: { web: service } };
        return yield* Effect.all([
          planOwnershipFixture(root, fixture, capabilities),
          planOwnershipFixture(root, fixture, capabilities),
          planOwnershipFixture(
            root,
            { ...fixture, services: { web: { ...service, projectUser: false } } },
            capabilities,
          ),
        ]);
      }).pipe(Effect.scoped),
    );
    const fingerprint = createConfigFingerprint(stock, requireWeb(stock), {});
    expect(createConfigFingerprint(replay, requireWeb(replay), {})).toBe(fingerprint);
    expect(createConfigFingerprint(optedOut, requireWeb(optedOut), {})).not.toBe(fingerprint);
  });
});
