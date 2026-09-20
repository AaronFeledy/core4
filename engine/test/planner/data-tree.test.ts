import { describe, expect, test } from "bun:test";

import { DataTreeOwnershipCapabilityError } from "@lando/sdk/errors";

import { dataTreeOwnershipStep, resolveDataTreeOwnership } from "../../src/planner/data-tree.ts";

const solrIdentity = { defaultUser: "solr", homes: { solr: "/var/solr", root: "/root" } } as const;

const intent = (overrides: Record<string, unknown> = {}) => ({
  serviceName: "search",
  serviceType: "solr",
  identity: solrIdentity,
  hasCustomImage: false,
  trees: [{ target: "/var/solr", seededOwners: ["solr", "8983"] }],
  ...overrides,
});

describe("resolveDataTreeOwnership", () => {
  test("Given no planned user, When resolved, Then the image's own identity owns the tree and nothing is prepared", () => {
    expect(resolveDataTreeOwnership({ ...intent(), plannedUser: undefined })).toEqual([]);
  });

  test("Given root, When resolved, Then no preparation is needed", () => {
    expect(resolveDataTreeOwnership({ ...intent(), plannedUser: "root" })).toEqual([]);
    expect(resolveDataTreeOwnership({ ...intent(), plannedUser: "0:0" })).toEqual([]);
  });

  test("Given a principal the image already seeds, When resolved, Then no preparation is needed", () => {
    expect(resolveDataTreeOwnership({ ...intent(), plannedUser: "solr" })).toEqual([]);
    expect(resolveDataTreeOwnership({ ...intent(), plannedUser: "8983:8983" })).toEqual([]);
  });

  test("Given a numeric uid, When resolved, Then the tree is prepared for that uid", () => {
    const resolved = resolveDataTreeOwnership({ ...intent(), plannedUser: "10001:10001" });
    expect(resolved).toEqual([{ target: "/var/solr", owner: "10001" }]);
  });

  test("Given a user the service type declares, When resolved, Then the tree is prepared for it", () => {
    const resolved = resolveDataTreeOwnership({
      ...intent({ trees: [{ target: "/data", seededOwners: ["root", "0"] }] }),
      plannedUser: "solr",
    });
    expect(resolved).toEqual([{ target: "/data", owner: "solr" }]);
  });

  test("Given a user the service type does not declare, When resolved, Then it refuses and names the user option", () => {
    const resolved = resolveDataTreeOwnership({ ...intent(), plannedUser: "www-data" });
    expect(resolved).toBeInstanceOf(DataTreeOwnershipCapabilityError);
    const error = resolved as DataTreeOwnershipCapabilityError;
    expect(error.service).toBe("search");
    expect(error.serviceType).toBe("solr");
    expect(error.target).toBe("/var/solr");
    expect(error.option).toBe("services.search.user");
    expect(error.user).toBe("www-data");
    expect(error.message).toContain("/var/solr");
    expect(error.remediation).toContain("numeric");
  });

  test("Given a custom image and a named user, When resolved, Then it refuses and names the image option", () => {
    const resolved = resolveDataTreeOwnership({
      ...intent({ hasCustomImage: true, identity: undefined }),
      plannedUser: "solr",
    });
    expect(resolved).toBeInstanceOf(DataTreeOwnershipCapabilityError);
    expect((resolved as DataTreeOwnershipCapabilityError).option).toBe("services.search.image");
  });

  test("Given a custom image and a numeric uid, When resolved, Then the tree is still preparable", () => {
    const resolved = resolveDataTreeOwnership({
      ...intent({ hasCustomImage: true, identity: undefined }),
      plannedUser: "10001",
    });
    expect(resolved).toEqual([{ target: "/var/solr", owner: "10001" }]);
  });

  test("Given a service type with no declared identity, When resolved, Then it refuses and names the type option", () => {
    const resolved = resolveDataTreeOwnership({
      ...intent({ identity: undefined }),
      plannedUser: "www-data",
    });
    expect(resolved).toBeInstanceOf(DataTreeOwnershipCapabilityError);
    expect((resolved as DataTreeOwnershipCapabilityError).option).toBe("services.search.type");
  });
});

describe("dataTreeOwnershipStep", () => {
  test("Given resolved trees, When a step is built, Then it runs as root during the derived image build and prepares every tree once", () => {
    const step = dataTreeOwnershipStep([
      { target: "/var/solr", owner: "10001" },
      { target: "/data", owner: "10001" },
    ]);
    expect(step?.user).toBe("root");
    expect(step?.phase).toBe("build");
    expect(step?.id).toBe("lando.storage:own-data-trees");
    const command = Array.isArray(step?.command) ? step.command.join(" ") : String(step?.command);
    expect(command).toContain("mkdir -p '/var/solr'");
    expect(command).toContain("chown -R '10001' '/var/solr'");
    expect(command).toContain("chmod 0770 '/data'");
  });

  test("Given no resolved trees, When a step is built, Then nothing is emitted", () => {
    expect(dataTreeOwnershipStep([])).toBeUndefined();
  });
});
