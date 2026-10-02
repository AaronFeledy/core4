import {
  type MachineSshBridgeHost,
  makeMachineSshBridge,
} from "@lando/container-runtime/podman/machine-ssh-bridge";

export type {
  MachineSshBridgeHost as HostProxyBridgeHost,
  MachineSshBridgeProcess as HostProxyBridgeProcess,
} from "@lando/container-runtime/podman/machine-ssh-bridge";

export interface WindowsHostProxyBridgeOptions {
  readonly podmanBin: string;
  readonly stateDir: string;
  readonly machineName: string;
  readonly host?: MachineSshBridgeHost;
}

export const makeWindowsHostProxyBridge = (options: WindowsHostProxyBridgeOptions) =>
  makeMachineSshBridge({ ...options, sshBinary: "ssh.exe", providerId: "lando" }).openHostProxyBridge;
