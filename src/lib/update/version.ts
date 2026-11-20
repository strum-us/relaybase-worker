import pkg from "../../../package.json";

/**
 * The version this bundle was built from. It travels with the code, so it is
 * right however the Worker was deployed (installer, self-update, or wrangler).
 */
export const BUILD_VERSION: string = pkg.version;

export { compareVersions, isVersion } from "./semver";
