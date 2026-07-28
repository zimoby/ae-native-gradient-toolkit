#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const relativeTypeScriptSpecifier = /(\bfrom\s+|\bimport\s*\(\s*)(["'])(\.\.?\/[^"']+)\.ts\2/g;
let rewrittenFiles = 0;

for (const name of readdirSync(DIST_ROOT).filter((entry) => entry.endsWith(".d.ts"))) {
  const path = join(DIST_ROOT, name);
  const source = readFileSync(path, "utf8");
  const rewritten = source.replace(
    relativeTypeScriptSpecifier,
    (_match, prefix, quote, specifier) => `${prefix}${quote}${specifier}.js${quote}`,
  );
  if (rewritten === source) continue;
  writeFileSync(path, rewritten, "utf8");
  rewrittenFiles += 1;
}

console.log(`Rewrote declaration specifiers in ${rewrittenFiles} file(s).`);
