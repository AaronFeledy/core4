const appRoots = new WeakMap<object, string>();

export const rememberLandofileAppRoot = <T extends object>(landofile: T, appRoot: string): T => {
  appRoots.set(landofile, appRoot);
  return landofile;
};

export const getLandofileAppRoot = (landofile: object): string | undefined => appRoots.get(landofile);
