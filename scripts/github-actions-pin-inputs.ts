// Reviewed upstream receipts. Repins require independent byte and platform verification.
export const GITHUB_ACTIONS_PIN_INPUTS = {
  nodeArchives: [
    {
      url: "https://nodejs.org/dist/v20.20.2/node-v20.20.2-linux-x64.tar.gz",
      file: "node-v20.20.2-linux-x64.tar.gz",
      sizeBytes: 47175721,
      sha256: "19e56f0825510207dd904f087fe52faa0a4eb6b2aab5f0ea7a33830d04888b8b",
    },
    {
      url: "https://nodejs.org/dist/v20.20.2/node-v20.20.2-linux-arm64.tar.gz",
      file: "node-v20.20.2-linux-arm64.tar.gz",
      sizeBytes: 46976715,
      sha256: "47ef73d543ecf6eb19435f6c03a0ac4809b3bf0dd6b26c7c571efc2a6572a74d",
    },
    {
      url: "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz",
      file: "node-v24.22.1-linux-x64.tar.gz",
      sizeBytes: 58290700,
      sha256: "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
    },
    {
      url: "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.gz",
      file: "node-v24.22.1-linux-arm64.tar.gz",
      sizeBytes: 58021129,
      sha256: "33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3",
    },
  ],
  runnerArchives: [
    {
      url: "https://github.com/actions/runner/releases/download/v2.338.1/actions-runner-linux-x64-2.338.1.tar.gz",
      file: "actions-runner-linux-x64-2.338.1.tar.gz",
      sizeBytes: 227944224,
      sha256: "08e9ccb3604d2462c24b5e33604dc30810296ca15cc65f23cffd4317eb144c37",
    },
    {
      url: "https://github.com/actions/runner/releases/download/v2.338.1/actions-runner-linux-arm64-2.338.1.tar.gz",
      file: "actions-runner-linux-arm64-2.338.1.tar.gz",
      sizeBytes: 140117973,
      sha256: "475e0c149fd3b611610127b9664ba5bacf5c6928795cc448ab520bb5f324bede",
    },
  ],
  members: [
    {
      archive: "node-v24.22.1-linux-x64.tar.gz",
      members: [
        {
          member: "node-v24.22.1-linux-x64/bin/node",
          sizeBytes: 126879696,
          sha256: "e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb",
          elfMachine: 62,
        },
      ],
    },
    {
      archive: "actions-runner-linux-x64-2.338.1.tar.gz",
      members: [
        {
          member: "./externals/node24_alpine/bin/node",
          sizeBytes: 132576224,
          sha256: "570430eb952b879e9af4d1403a76639c3dd4e36bf6bc0d775001191e9960774d",
          elfMachine: 62,
        },
        {
          member: "./externals/node24/bin/node",
          sizeBytes: 126879696,
          sha256: "e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb",
          elfMachine: 62,
        },
        {
          member: "./externals/node20_alpine/bin/node",
          sizeBytes: 104735312,
          sha256: "9d1bf97678655401b9b9192e98e5f769214b47f56d51ca8c9bbc30eb95c83efe",
          elfMachine: 62,
        },
        {
          member: "./externals/node20/bin/node",
          sizeBytes: 98932688,
          sha256: "6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd",
          elfMachine: 62,
        },
        {
          member: "./bin/Runner.Listener",
          sizeBytes: 72504,
          sha256: "91af14c889c07b7090365e28fa977781e76e311720f05914fe6a4ea88b8bf2ea",
          elfMachine: 62,
        },
      ],
    },
    {
      archive: "node-v20.20.2-linux-arm64.tar.gz",
      members: [
        {
          member: "node-v20.20.2-linux-arm64/bin/node",
          sizeBytes: 98875896,
          sha256: "05a69ccdcb795f2a8b86c145e71a6a37cce84fccef5aaf25a8fe38bc9423e732",
          elfMachine: 183,
        },
      ],
    },
    {
      archive: "actions-runner-linux-arm64-2.338.1.tar.gz",
      members: [
        {
          member: "./externals/node24/bin/node",
          sizeBytes: 123377224,
          sha256: "c8c5721679d8d1a09e9987e345d5f9a64899bb85f7a384783ba8a93e6e62348a",
          elfMachine: 183,
        },
        {
          member: "./externals/node20/bin/node",
          sizeBytes: 98875896,
          sha256: "05a69ccdcb795f2a8b86c145e71a6a37cce84fccef5aaf25a8fe38bc9423e732",
          elfMachine: 183,
        },
        {
          member: "./bin/Runner.Listener",
          sizeBytes: 72680,
          sha256: "b191999b850997d72f8a652d793ecfa6a3bd9a106a48c390f890502595ae140e",
          elfMachine: 183,
        },
      ],
    },
    {
      archive: "node-v20.20.2-linux-x64.tar.gz",
      members: [
        {
          member: "node-v20.20.2-linux-x64/bin/node",
          sizeBytes: 98932688,
          sha256: "6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd",
          elfMachine: 62,
        },
      ],
    },
    {
      archive: "node-v24.22.1-linux-arm64.tar.gz",
      members: [
        {
          member: "node-v24.22.1-linux-arm64/bin/node",
          sizeBytes: 123377224,
          sha256: "c8c5721679d8d1a09e9987e345d5f9a64899bb85f7a384783ba8a93e6e62348a",
          elfMachine: 183,
        },
      ],
    },
  ],
  notices: [
    {
      id: "runner",
      path: "pins-notices/runner-LICENSE",
      sourceUrl:
        "https://raw.githubusercontent.com/actions/runner/e78522a9a7b01c3bcd7ac0da6e3a9bb6cd513a76/LICENSE",
      sha256: "621a1e0b6163b9d63fe780b9d6f5a7f775a5781065024a1ebf8010726c44cec1",
      scope: "upstream-runner-source",
      license: "MIT",
    },
    {
      id: "node20",
      path: "pins-notices/node20-LICENSE",
      sourceUrl:
        "https://raw.githubusercontent.com/nodejs/node/3626fea570e44896ad99aaf3bf6e59def5adede5/LICENSE",
      sha256: "70c7a59521f41ccfe5bb0193677b77a44ed43ad4fe59203fa408afa538214949",
      scope: "nodejs-distribution",
      license: "MIT-with-third-party-notices",
    },
    {
      id: "node24",
      path: "pins-notices/node24-LICENSE",
      sourceUrl:
        "https://raw.githubusercontent.com/nodejs/node/ce7aaf1cee78b8cf0ce17364260535c418d3ed26/LICENSE",
      sha256: "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace",
      scope: "nodejs-distribution",
      license: "MIT-with-third-party-notices",
    },
  ],
  images: [
    {
      arch: "x64",
      indexDigest: "sha256:e275409999c37162649aa050ca573f03eab2eabcb3a1e7fcc47548de6b4f9690",
      manifestDigest: "sha256:c6955f4adccbf1ba5164c1336cff2c4b6dd30574e599afd1a02edf762b71467b",
      configDigest: "sha256:c49b99e577f332dbf2c1445478629aa7836919e75098fd22ebe001f5e4a3ce4e",
    },
    {
      arch: "arm64",
      indexDigest: "sha256:e275409999c37162649aa050ca573f03eab2eabcb3a1e7fcc47548de6b4f9690",
      manifestDigest: "sha256:ee680dc9fe83da474e3c51d642f8bfac0d920da26735e3d5e4171ab8f2f45a87",
      configDigest: "sha256:d67e1812cba1b4e08ba38d40925b85bca2ceea9dfb78c66666a0fab85cbe39d6",
    },
  ],
  sourceFiles: [
    {
      path: "src/Misc/externals.sh",
      sha256: "47799959381d07ec421b5804241d45f09cd9f8b7db6a54a8cc5ddb1dc45bac2d",
    },
    {
      path: "images/Dockerfile",
      sha256: "417aa58cc49685b60033ec00b95a589f804d9ae2b7a94f3656f31b07ba120ee5",
    },
  ],
} as const;
