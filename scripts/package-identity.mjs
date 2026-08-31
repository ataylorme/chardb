export const CHARDB_PACKAGE_NAME = "@chardb/core";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function npmPackFilename(name, version) {
    if (!PACKAGE_NAME.test(name)) throw new Error(`invalid npm package name ${String(name)}`);
    if (!PACKAGE_VERSION.test(version)) throw new Error(`invalid npm package version ${String(version)}`);
    const stem = name.startsWith("@") ? name.slice(1).replaceAll("/", "-") : name;
    return `${stem}-${version}.tgz`;
}
