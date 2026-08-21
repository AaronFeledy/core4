import { describe, expect, test } from "bun:test";

import { isManagedNftMissingMessage, startFailureRemediation } from "../src/bring-up.ts";

describe("startFailureRemediation", () => {
  test("nft-missing copy tells the user to run lando setup, not destroy or apt-get", () => {
    const message =
      'netavark: nftables error: unable to execute "nft": No such file or directory (os error 2)';
    expect(isManagedNftMissingMessage(message)).toBe(true);
    const remediation = startFailureRemediation("Podman container start failed with HTTP 500.", {
      body: message,
    });
    expect(remediation).toMatch(/lando setup/u);
    expect(remediation).not.toMatch(/lando destroy/u);
    expect(remediation).not.toMatch(/apt-get install/u);
    expect(remediation).toMatch(/do not set network_backend=pasta/u);
  });

  test("nft-missing network-create copy tells the user to run lando setup, not destroy", () => {
    const message =
      'Podman network create failed with HTTP 500. netavark: nftables error: unable to execute "nft": No such file or directory (os error 2)';
    expect(isManagedNftMissingMessage(message)).toBe(true);
    const remediation = startFailureRemediation(message, { body: message });
    expect(remediation).toMatch(/lando setup/u);
    expect(remediation).not.toMatch(/lando destroy/u);
    expect(remediation).not.toMatch(/apt-get install/u);
    expect(remediation).toMatch(/do not set network_backend=pasta/u);
  });

  test("generic start failures keep the destroy remediation", () => {
    expect(isManagedNftMissingMessage("forced start failure")).toBe(false);
    expect(startFailureRemediation("forced start failure")).toMatch(/lando destroy/u);
  });
});
