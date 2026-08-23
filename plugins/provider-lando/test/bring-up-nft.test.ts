import { describe, expect, test } from "bun:test";

import { isManagedNftMissingMessage, startFailureRemediation } from "../src/bring-up.ts";
import {
  LEFTOVER_PROXY_PORT_REMEDIATION,
  isLeftoverProxyPortBindMessage,
} from "../src/leftover-proxy-port.ts";

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

  test("address already in use on proxy port 38080 remediates leftover proxy, not destroy", () => {
    // Given: Podman body reports address already in use on the proxy HTTP port
    const details = { body: "address already in use 38080" };
    // When: startFailureRemediation classifies the failure
    const remediation = startFailureRemediation("Podman container start failed with HTTP 500.", details);
    // Then: leftover-proxy guidance, not destroy
    expect(isLeftoverProxyPortBindMessage(`${details.body}`)).toBe(true);
    expect(remediation).toMatch(/lando global:stop/u);
    expect(remediation).toMatch(/rootlessport/u);
    expect(remediation).toMatch(/lando setup/u);
    expect(remediation).not.toMatch(/lando destroy/u);
  });

  test("EADDRINUSE on proxy port 38443 is leftover proxy bind", () => {
    // Given: message mentions EADDRINUSE and the proxy HTTPS port
    const message = "EADDRINUSE 38443";
    // When
    const remediation = startFailureRemediation(message);
    // Then
    expect(isLeftoverProxyPortBindMessage(message)).toBe(true);
    expect(remediation).toMatch(/lando global:stop/u);
    expect(remediation).toMatch(/rootlessport/u);
    expect(remediation).toMatch(/lando setup/u);
    expect(remediation).not.toMatch(/lando destroy/u);
  });

  test("rootlessport plus 38080 without English phrase is leftover proxy bind", () => {
    // Given: rootlessport and proxy port with no "address already in use" phrase
    const message = "rootlessport 38080";
    // When
    const remediation = startFailureRemediation(message);
    // Then
    expect(isLeftoverProxyPortBindMessage(message)).toBe(true);
    expect(remediation).toMatch(/lando global:stop/u);
    expect(remediation).toMatch(/rootlessport/u);
    expect(remediation).toMatch(/lando setup/u);
    expect(remediation).not.toMatch(/lando destroy/u);
  });

  test("address already in use on app port 8080 keeps destroy remediation", () => {
    // Given: bind failure on a non-proxy port only
    const message = "address already in use 8080";
    // When
    const remediation = startFailureRemediation(message);
    // Then: still generic destroy path, not leftover proxy
    expect(isLeftoverProxyPortBindMessage(message)).toBe(false);
    expect(remediation).toMatch(/lando destroy/u);
    expect(remediation).not.toMatch(/lando global:stop/u);
  });

  test("nft-missing body that also mentions 38080 stays NFT remediation", () => {
    // Given: nft-missing body that happens to mention a proxy port
    const message =
      'netavark: nftables error: unable to execute "nft": No such file or directory (os error 2) 38080';
    // When
    const remediation = startFailureRemediation("Podman container start failed with HTTP 500.", {
      body: message,
    });
    // Then: NFT wins over leftover-proxy and destroy
    expect(isManagedNftMissingMessage(message)).toBe(true);
    expect(remediation).toMatch(/lando setup/u);
    expect(remediation).toMatch(/do not set network_backend=pasta/u);
    expect(remediation).not.toMatch(/lando destroy/u);
    expect(remediation).not.toMatch(/lando global:stop/u);
  });

  test("LEFTOVER_PROXY_PORT_REMEDIATION names global stop, rootlessport, and setup", () => {
    // Given / When: the exported remediation constant
    // Then: it contains the three required guidance fragments
    expect(LEFTOVER_PROXY_PORT_REMEDIATION).toContain("lando global:stop");
    expect(LEFTOVER_PROXY_PORT_REMEDIATION).toContain("rootlessport");
    expect(LEFTOVER_PROXY_PORT_REMEDIATION).toContain("lando setup");
  });
});
