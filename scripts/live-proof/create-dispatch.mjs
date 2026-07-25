import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readLiveProofConfig, validateLiveProofConfig } from "./validate-config.mjs";

export const LIVE_PROOF_GLOBAL_KEY = "__AE_NATIVE_GRADIENT_LIVE_PROOF_CONFIG__";
const IMPLEMENTATION_MARKER = "__AE_NATIVE_GRADIENT_PROOF_IMPLEMENTATION__";
const MAX_IMPLEMENTATION_BYTES = 256 * 1024;
const IMPLEMENTATION_PHASES = new Map([
  ["proof-setup.jsx", "setup"],
  ["proof-apply.jsx", "apply"],
  ["proof-save-readback.jsx", "save-readback"],
  ["proof-undo.jsx", "undo"],
  ["proof-cleanup.jsx", "cleanup"],
]);
const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireAbsoluteNormalized(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path.includes("\0")) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return path;
}

function requireChild(root, candidate, label) {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`${label} must be a child of scratchRoot`);
  }
}

async function readStableRegularFile(path, maxBytes, label) {
  const beforePath = await lstat(path);
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > BigInt(maxBytes)) throw new Error(`${label} exceeds byte limit`);
    const size = Number(before.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (result.bytesRead === 0) throw new Error(`${label} changed or truncated during read`);
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`${label} changed during read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function encodeForExtendScript(value) {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

async function assertReviewedImplementation(path, phase) {
  const normalized = requireAbsoluteNormalized(path, "implementationPath");
  const expectedPhase = IMPLEMENTATION_PHASES.get(basename(normalized));
  if (expectedPhase !== phase) {
    throw new Error("implementationPath is not the reviewed live-proof script for this phase");
  }
  const expectedRoot = await realpath(SCRIPT_ROOT);
  const actualRoot = await realpath(dirname(normalized));
  if (actualRoot !== expectedRoot) {
    throw new Error("implementationPath is outside the reviewed live-proof implementation directory");
  }
  return readStableRegularFile(normalized, MAX_IMPLEMENTATION_BYTES, "reviewed live-proof implementation");
}

async function publishNoClobber(path, bytes) {
  try {
    await lstat(path);
    throw new Error(`dispatch output already exists: ${path}`);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }

  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let temporaryExists = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        throw new Error(`dispatch output already exists: ${path}`);
      }
      throw error;
    }
    await unlink(temporaryPath);
    temporaryExists = false;
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => {});
  }
}

export async function createDispatch(options) {
  const phase = options?.config?.phase;
  const config = validateLiveProofConfig(options?.config, { requireTarget: phase !== "setup" });
  const implementationBytes = await assertReviewedImplementation(options.implementationPath, config.phase);
  const implementation = new TextDecoder("utf-8", { fatal: true }).decode(implementationBytes);
  const outputPath = requireAbsoluteNormalized(options.outputPath, "outputPath");
  requireChild(config.scratchRoot, outputPath, "outputPath");

  const configJson = encodeForExtendScript(config);
  const dispatch = `(function () {\n` +
    `  var key = ${JSON.stringify(LIVE_PROOF_GLOBAL_KEY)};\n` +
    `  if (typeof $.global[key] !== "undefined") { throw new Error("live-proof global already exists"); }\n` +
    `  try {\n` +
    `    $.global[key] = ${configJson};\n` +
    `    /* ${IMPLEMENTATION_MARKER} */\n` +
    `    return (\n${implementation}\n    );\n` +
    `  } finally {\n` +
    `    delete $.global[key];\n` +
    `  }\n` +
    `})()\n`;
  const bytes = Buffer.from(dispatch, "utf8");
  await publishNoClobber(outputPath, bytes);
  const readback = await readStableRegularFile(outputPath, bytes.byteLength, "dispatch output");
  if (!readback.equals(bytes)) throw new Error("dispatch output readback mismatch");

  return {
    schemaVersion: 1,
    phase: config.phase,
    runToken: config.runToken,
    outputPath,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    implementationSha256: sha256(implementationBytes),
    configSha256: sha256(Buffer.from(configJson, "utf8")),
  };
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--config", "--implementation", "--output"].includes(flag) || value === undefined) {
      throw new Error("usage: create-dispatch.mjs --config <config.json> --implementation <proof-phase.jsx> --output <dispatch.jsx>");
    }
    parsed[flag.slice(2)] = value;
  }
  if (!parsed.config || !parsed.implementation || !parsed.output) {
    throw new Error("usage: create-dispatch.mjs --config <config.json> --implementation <proof-phase.jsx> --output <dispatch.jsx>");
  }
  return parsed;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const configPath = requireAbsoluteNormalized(args.config, "config path");
  const config = await readLiveProofConfig(configPath, { requireTarget: false });
  const report = await createDispatch({
    config,
    implementationPath: requireAbsoluteNormalized(args.implementation, "implementation path"),
    outputPath: requireAbsoluteNormalized(args.output, "output path"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
