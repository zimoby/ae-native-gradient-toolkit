import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validateGeneratedGradient } from "../../dist/gcky-gradient.js";

const MAX_CONFIG_BYTES = 256 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PHASES = new Set(["setup", "apply", "save-readback", "undo", "cleanup"]);
const KINDS = new Set(["fill", "stroke"]);
const CONFIG_KEYS = new Set([
  "schemaVersion",
  "runToken",
  "scratchRoot",
  "projectPath",
  "evidenceRoot",
  "expectedAeVersion",
  "expectedTargetPresent",
  "expectedCandidateCount",
  "phase",
  "kind",
  "stopCount",
  "gradient",
  "presetPath",
  "presetSha256",
  "target",
]);
const TARGET_KEYS = new Set([
  "compCreatedByHarness",
  "compId",
  "compName",
  "layerId",
  "layerIndex",
  "layerName",
  "propertyIndexPath",
  "matchNamePath",
]);

function fail(message) {
  throw new Error(`invalid live-proof config: ${message}`);
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unknown key ${JSON.stringify(key)}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`);
  return value;
}

function normalizeAbsolutePath(value, label) {
  const source = requireString(value, label);
  if (!isAbsolute(source)) fail(`${label} must be absolute`);
  if (/[\u0000-\u001f\u007f]/.test(source)) fail(`${label} contains a control character`);
  const normalized = resolve(source);
  if (normalized !== source) fail(`${label} must already be normalized`);
  return normalized;
}

function requireInside(root, candidate, label) {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    fail(`${label} must be a child of scratchRoot`);
  }
}

function validateTarget(value, kind, token) {
  const target = requirePlainObject(value, "target");
  rejectUnknownKeys(target, TARGET_KEYS, "target");

  const compCreatedByHarness = requireBoolean(target.compCreatedByHarness, "target.compCreatedByHarness");
  const compId = requirePositiveInteger(target.compId, "target.compId");
  const layerId = requirePositiveInteger(target.layerId, "target.layerId");
  const layerIndex = requirePositiveInteger(target.layerIndex, "target.layerIndex");
  const compName = requireString(target.compName, "target.compName");
  const layerName = requireString(target.layerName, "target.layerName");
  if (compName !== `AE Native Gradient Proof ${token}`) fail("target.compName does not match runToken");
  if (layerName !== `__AE_NG_${token}_${kind}__`) fail("target.layerName does not match runToken/kind");

  if (!Array.isArray(target.propertyIndexPath) || target.propertyIndexPath.length < 2 || target.propertyIndexPath.length > 32) {
    fail("target.propertyIndexPath must contain 2..32 indices");
  }
  const propertyIndexPath = target.propertyIndexPath.map((entry, index) =>
    requirePositiveInteger(entry, `target.propertyIndexPath[${index}]`));

  if (!Array.isArray(target.matchNamePath) || target.matchNamePath.length !== propertyIndexPath.length) {
    fail("target.matchNamePath must match propertyIndexPath length");
  }
  const matchNamePath = target.matchNamePath.map((entry, index) =>
    requireString(entry, `target.matchNamePath[${index}]`));
  const expectedParent = kind === "fill"
    ? "ADBE Vector Graphic - G-Fill"
    : "ADBE Vector Graphic - G-Stroke";
  if (matchNamePath.at(-2) !== expectedParent || matchNamePath.at(-1) !== "ADBE Vector Grad Colors") {
    fail("target match-name path has wrong gradient kind or terminal property");
  }

  return {
    compCreatedByHarness,
    compId,
    compName,
    layerId,
    layerIndex,
    layerName,
    propertyIndexPath,
    matchNamePath,
  };
}

export function validateLiveProofConfig(value, options = {}) {
  const source = requirePlainObject(value, "root");
  rejectUnknownKeys(source, CONFIG_KEYS, "root");
  if (source.schemaVersion !== 1) fail("schemaVersion must equal 1");

  const runToken = requireString(source.runToken, "runToken");
  if (!TOKEN_PATTERN.test(runToken)) fail("runToken must match the bounded token contract");

  const scratchRoot = normalizeAbsolutePath(source.scratchRoot, "scratchRoot");
  if (!basename(scratchRoot).includes(runToken)) fail("scratchRoot basename must contain runToken");
  const projectPath = normalizeAbsolutePath(source.projectPath, "projectPath");
  const evidenceRoot = normalizeAbsolutePath(source.evidenceRoot, "evidenceRoot");
  const presetPath = normalizeAbsolutePath(source.presetPath, "presetPath");
  requireInside(scratchRoot, projectPath, "projectPath");
  requireInside(scratchRoot, evidenceRoot, "evidenceRoot");
  requireInside(scratchRoot, presetPath, "presetPath");
  if (!projectPath.toLowerCase().endsWith(".aep")) fail("projectPath must end in .aep");

  const phase = requireString(source.phase, "phase");
  if (!PHASES.has(phase)) fail("phase is unsupported");
  const kind = requireString(source.kind, "kind");
  if (!KINDS.has(kind)) fail("kind must be fill or stroke");
  const stopCount = requirePositiveInteger(source.stopCount, "stopCount");
  if (![2, 3, 8].includes(stopCount)) fail("stopCount must be 2, 3, or 8 for the live matrix");

  let gradient;
  try {
    gradient = validateGeneratedGradient(source.gradient);
  } catch (error) {
    fail(`gradient failed generator validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (gradient.colorStops.length !== stopCount || gradient.alphaStops.length !== stopCount) {
    fail("gradient color/alpha counts must equal stopCount");
  }

  const expectedPresetName = `ae-gradient-${runToken}-${kind}-${stopCount}.ffx`;
  if (presetPath.slice(presetPath.lastIndexOf(sep) + 1) !== expectedPresetName) {
    fail("presetPath basename does not match token/kind/count");
  }
  const presetSha256 = requireString(source.presetSha256, "presetSha256");
  if (!SHA256_PATTERN.test(presetSha256)) fail("presetSha256 must be lowercase SHA-256 hex");
  const expectedAeVersion = requireString(source.expectedAeVersion, "expectedAeVersion");
  if (!/^26\.3(?:\.\d+)?(?:x\d+)?$/.test(expectedAeVersion)) {
    fail("expectedAeVersion must pin After Effects 26.3");
  }
  const expectedTargetPresent = requireBoolean(source.expectedTargetPresent, "expectedTargetPresent");
  const expectedCandidateCount = source.expectedCandidateCount;
  if (expectedCandidateCount !== 0 && expectedCandidateCount !== 1) {
    fail("expectedCandidateCount must equal 0 or 1");
  }

  const requireTarget = options.requireTarget ?? phase !== "setup";
  let target = null;
  if (source.target !== null && source.target !== undefined) {
    target = validateTarget(source.target, kind, runToken);
  } else if (requireTarget) {
    fail("target is required for this phase");
  }

  return {
    schemaVersion: 1,
    runToken,
    scratchRoot,
    projectPath,
    evidenceRoot,
    expectedAeVersion,
    expectedTargetPresent,
    expectedCandidateCount,
    phase,
    kind,
    stopCount,
    gradient,
    presetPath,
    presetSha256,
    target,
  };
}

export function matchesExpectedAeVersion(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  if (actual === expected) return true;
  return expected === "26.3" && /^26\.3(?:x|\.)/.test(actual);
}

export function parseAndValidateLiveProofConfig(text, options = {}) {
  if (typeof text !== "string") fail("config text must be a string");
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) fail("config exceeds byte limit");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateLiveProofConfig(parsed, options);
}

export async function readLiveProofConfig(path, options = {}) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail("config input must be a regular file");
    if (before.size > BigInt(MAX_CONFIG_BYTES)) fail("config exceeds byte limit");
    const size = Number(before.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (result.bytesRead === 0) fail("config changed or truncated during read");
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      fail("config changed during read");
    }
    return parseAndValidateLiveProofConfig(new TextDecoder("utf-8", { fatal: true }).decode(bytes), options);
  } finally {
    await handle.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--config") {
    throw new Error("usage: validate-config.mjs --config <absolute-config.json>");
  }
  const configPath = normalizeAbsolutePath(args[1], "config path");
  const validated = await readLiveProofConfig(configPath);
  process.stdout.write(`${JSON.stringify(validated, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
