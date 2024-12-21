export class NodeSetup {
  static setEnv(key: string, value: string, force?: boolean) {
    if (process.env[key] === undefined || force) {
      process.env[key] = value;
    }
  }

  static setupEnvironment(): void {
    if (process.env.NODE_ENV !== 'development') {
      this.setEnv('NODE_ENV', 'production', true);
    } else {
      // tslint:disable-next-line:no-var-requires
      const rebuildRequire = require('../util/requireRebuild').default;
      rebuildRequire();
    }
  }
}
