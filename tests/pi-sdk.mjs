import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = new URL('../package.json', import.meta.url);
export const piRoot = process.env.PI_PACKAGE_DIR ?? dirname(findPackageJSON('@earendil-works/pi-coding-agent', pkg));
const sdk = pathToFileURL(join(piRoot, 'package.json'));
export const piDependency = (name, file) => new URL(file, pathToFileURL(findPackageJSON(name, sdk)));
