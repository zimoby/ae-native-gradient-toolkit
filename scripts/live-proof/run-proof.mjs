import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createDispatch } from "./create-dispatch.mjs";
import { ensureLiveProofPreset } from "./prepare-preset.mjs";
import { matchesExpectedAeVersion, readLiveProofConfig } from "./validate-config.mjs";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const PHASE_IMPLEMENTATIONS = new Map([
  ["setup", "proof-setup.jsx"],
  ["apply", "proof-apply.jsx"],
  ["save-readback", "proof-save-readback.jsx"],
  ["undo", "proof-undo.jsx"],
  ["cleanup", "proof-cleanup.jsx"],
]);
const GLOBAL_LOCK = "/private/tmp/ae-native-gradient-live-proof.lock";

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function shellQuote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
function sleep(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

function parseArguments(args) {
  const parsed = { execute: false, validateOnly: false, timeoutMs: 60_000 };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--execute") parsed.execute = true;
    else if (flag === "--validate-only") parsed.validateOnly = true;
    else if (["--config", "--phase", "--helpers", "--home", "--timeout-ms"].includes(flag)) {
      const value = args[index + 1];
      if (value === undefined) fail(`missing value for ${flag}`);
      parsed[flag.slice(2).replace("-ms", "Ms")] = value;
      index += 1;
    } else fail(`unknown argument: ${flag}`);
  }
  if (!parsed.config || !parsed.phase) {
    fail("usage: run-proof.sh --config <absolute.json> --phase <phase> [--validate-only | --execute] [--helpers <absolute.sh>] [--home <absolute>] [--timeout-ms <ms>]");
  }
  if (parsed.execute === parsed.validateOnly) fail("choose exactly one of --validate-only or --execute");
  parsed.timeoutMs = Number(parsed.timeoutMs);
  if (!Number.isSafeInteger(parsed.timeoutMs) || parsed.timeoutMs < 1_000 || parsed.timeoutMs > 300_000) {
    fail("--timeout-ms must be an integer from 1000 to 300000");
  }
  return parsed;
}

function requireAbsoluteNormalized(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f\u007f]/.test(path)) {
    fail(`${label} must be an absolute normalized path without control characters`);
  }
  return path;
}

function requireChild(root, candidate, label) {
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail(`${label} must be a child of scratchRoot`);
  }
}

async function assertRealPath(path, label, type) {
  const state = lstatSync(path);
  if (state.isSymbolicLink()) fail(`${label} must not be a symlink`);
  if (type === "file" && !state.isFile()) fail(`${label} must be a regular file`);
  if (type === "directory" && !state.isDirectory()) fail(`${label} must be a directory`);
  const resolved = await realpath(path);
  if (resolved !== path) fail(`${label} realpath mismatch`);
}

async function writeJsonNoClobber(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function invokeZsh({ command, home, timeoutMs }) {
  const execution = spawnSync("/bin/zsh", ["-lc", command], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, AE_RUN_TIMEOUT: String(Math.ceil(timeoutMs / 1000)) },
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (execution.error) fail(`AE helper invocation failed: ${execution.error.message}`);
  if (execution.status !== 0) fail(`AE helper exited ${execution.status}: ${execution.stderr.trim()}`);
  const stdout = execution.stdout.trim();
  try {
    return { parsed: JSON.parse(stdout), stdout, stderr: execution.stderr, command };
  } catch (error) {
    fail(`AE helper returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function helperCommand(helpers, functionName, argument) {
  return `source ${shellQuote(helpers)} && ${functionName} ${shellQuote(argument)}`;
}

function probeExpression() {
  return "(function(){var p=app.project;if(p==null){return {ok:false,error:'no project'};}var a=p.activeItem;var sl=0;var sp=0;if(a!=null && (a instanceof CompItem)){sl=a.selectedLayers.length;for(var i=0;i<a.selectedLayers.length;i+=1){sp+=a.selectedLayers[i].selectedProperties.length;}}return {ok:true,version:app.version,projectPath:p.file==null?null:p.file.fsName,dirty:p.dirty,numItems:p.numItems,activeItem:a==null?null:{id:a.id,name:a.name,typeName:a.typeName},selectedLayers:sl,selectedProperties:sp};})()";
}

function runProbe(context) {
  const invocation = invokeZsh({
    command: helperCommand(context.helpers, "ae_run", probeExpression()),
    home: context.home,
    timeoutMs: context.timeoutMs,
  });
  const probe = invocation.parsed;
  if (probe == null || probe.ok !== true) fail(`read-only AE probe failed: ${JSON.stringify(probe)}`);
  if (!matchesExpectedAeVersion(probe.version, context.config.expectedAeVersion)) {
    fail(`read-only AE probe version mismatch: expected ${context.config.expectedAeVersion}, got ${probe.version}`);
  }
  if (probe.projectPath !== context.config.projectPath) fail("read-only AE probe project path mismatch");
  if (context.config.target != null && context.config.expectedTargetPresent) {
    if (probe.activeItem == null || probe.activeItem.id !== context.config.target.compId || probe.activeItem.name !== context.config.target.compName) {
      fail("read-only AE probe active comp identity mismatch");
    }
  }
  return { probe, command: invocation.command };
}

async function waitForStableProbe(context) {
  await sleep(1_000);
  let previous = null;
  const observations = [];
  const deadline = Date.now() + Math.min(15_000, context.timeoutMs);
  while (Date.now() < deadline) {
    const current = runProbe(context).probe;
    observations.push(current);
    const key = JSON.stringify(current);
    if (previous === key) return { stable: true, observations };
    previous = key;
    await sleep(250);
  }
  fail("AE state did not stabilize after mutation");
}

async function acquireLock(runToken) {
  try {
    await mkdir(GLOBAL_LOCK, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      let owner = "unreadable";
      try { owner = await readFile(join(GLOBAL_LOCK, "owner.json"), "utf8"); } catch {}
      fail(`live-proof lock already exists: ${owner.trim()}`);
    }
    throw error;
  }
  const owner = { pid: process.pid, runToken, createdAt: new Date().toISOString() };
  try {
    await writeJsonNoClobber(join(GLOBAL_LOCK, "owner.json"), owner);
  } catch (error) {
    await rm(GLOBAL_LOCK, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return owner;
}

async function releaseLock(owner) {
  try {
    const current = JSON.parse(await readFile(join(GLOBAL_LOCK, "owner.json"), "utf8"));
    if (current.pid === owner.pid && current.runToken === owner.runToken) {
      await rm(GLOBAL_LOCK, { recursive: true, force: false });
    }
  } catch {}
}

async function inventorySavedProject(projectPath, expectedCandidateCount) {
  const cli = join(dirname(SCRIPT_ROOT), "..", "bin", "ae-native-gradient.mjs");
  const inspectArgs = [cli, "inspect", projectPath];
  if (expectedCandidateCount === 1) inspectArgs.push("--unique");
  const execution = spawnSync(process.execPath, inspectArgs, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (execution.error) fail(`saved-AEP inventory failed: ${execution.error.message}`);
  if (execution.status !== 0) fail(`saved-AEP inventory rejected readback: ${execution.stderr.trim()}`);
  const report = JSON.parse(execution.stdout);
  if (report.candidates.length !== expectedCandidateCount) {
    fail(`saved-AEP inventory expected ${expectedCandidateCount} candidates, got ${report.candidates.length}`);
  }
  return report;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const configPath = requireAbsoluteNormalized(args.config, "config path");
  if (lstatSync(configPath).isSymbolicLink()) fail("config path must not be a symlink");
  const config = await readLiveProofConfig(configPath, { requireTarget: args.phase !== "setup" });
  requireChild(config.scratchRoot, configPath, "config path");
  if (config.phase !== args.phase) fail("--phase does not match config.phase");
  const implementationName = PHASE_IMPLEMENTATIONS.get(config.phase);
  if (!implementationName) fail("unsupported phase");

  await assertRealPath(config.scratchRoot, "scratchRoot", "directory");
  await mkdir(config.evidenceRoot, { recursive: true, mode: 0o700 });
  await assertRealPath(config.evidenceRoot, "evidenceRoot", "directory");
  const nonce = `${Date.now()}-${process.pid}`;
  const dispatchPath = join(config.scratchRoot, `dispatch-${config.runToken}-${config.phase}-${nonce}.jsx`);
  const dispatch = await createDispatch({
    config,
    implementationPath: join(SCRIPT_ROOT, implementationName),
    outputPath: dispatchPath,
  });
  const baseReport = {
    schemaVersion: 1,
    executed: false,
    phase: config.phase,
    runToken: config.runToken,
    configPath,
    configSha256: sha256(readFileSync(configPath)),
    dispatchPath,
    dispatchSha256: dispatch.sha256,
    implementationSha256: dispatch.implementationSha256,
    node: process.version,
    nodePath: process.execPath,
  };

  if (args.validateOnly) {
    process.stdout.write(`${JSON.stringify(baseReport, null, 2)}\n`);
    return;
  }

  if (process.env.AE_NATIVE_GRADIENT_LIVE_APPROVED !== config.runToken) {
    fail("live execution requires AE_NATIVE_GRADIENT_LIVE_APPROVED to equal runToken for this session");
  }
  const home = requireAbsoluteNormalized(args.home ?? process.env.HOME, "real user HOME");
  const helpers = requireAbsoluteNormalized(args.helpers ?? process.env.AE_HELPERS, "AE helpers path");
  await assertRealPath(config.projectPath, "projectPath", "file");
  await assertRealPath(helpers, "AE helpers path", "file");
  requireChild(config.scratchRoot, config.projectPath, "projectPath");

  let presetEvidence = null;
  if (config.phase === "apply") {
    presetEvidence = await ensureLiveProofPreset(config);
    await assertRealPath(config.presetPath, "presetPath", "file");
    requireChild(config.scratchRoot, config.presetPath, "presetPath");
    const presetBytes = readFileSync(config.presetPath);
    const actualHash = sha256(presetBytes);
    if (actualHash !== config.presetSha256) fail("preset SHA-256 mismatch immediately before dispatch");
    presetEvidence = { ...presetEvidence, path: config.presetPath, byteLength: presetBytes.byteLength, sha256: actualHash };
  }

  const owner = await acquireLock(config.runToken);
  const context = { config, helpers, home, timeoutMs: args.timeoutMs };
  const evidencePath = join(config.evidenceRoot, `${config.phase}-${nonce}.json`);
  let report = { ...baseReport, approvalMatched: true, lockOwner: owner, preset: presetEvidence };
  try {
    const before = runProbe(context);
    const command = helperCommand(helpers, "ae_file_json", dispatchPath);
    const host = invokeZsh({ command, home, timeoutMs: args.timeoutMs });
    report = { ...report, executed: true, probeBefore: before.probe, probeCommand: before.command, hostCommand: command, hostResult: host.parsed, hostStderr: host.stderr };
    if (host.parsed == null || host.parsed.success !== true) {
      fail(`host phase returned failure: ${JSON.stringify(host.parsed)}`);
    }
    if (config.phase === "apply" || config.phase === "undo") {
      report.stabilization = await waitForStableProbe(context);
    }
    if (config.phase === "save-readback") {
      report.savedAepInventory = await inventorySavedProject(config.projectPath, config.expectedCandidateCount);
    }
    report.completedAt = new Date().toISOString();
    await writeJsonNoClobber(evidencePath, report);
    process.stdout.write(`${JSON.stringify({ ...report, evidencePath }, null, 2)}\n`);
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
    report.failedAt = new Date().toISOString();
    try { await writeJsonNoClobber(evidencePath, report); } catch {}
    throw error;
  } finally {
    await releaseLock(owner);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
