import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isMainModule(moduleUrl, argvPath = process.argv[1]) {
  return typeof argvPath === 'string' && pathToFileURL(resolve(argvPath)).href === moduleUrl;
}
