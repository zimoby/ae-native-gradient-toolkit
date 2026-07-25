import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LIVE_PROOF_GLOBAL_KEY,
  createDispatch,
} from "../scripts/live-proof/create-dispatch.mjs";
import {
  matchesExpectedAeVersion,
  parseAndValidateLiveProofConfig,
  validateLiveProofConfig,
} from "../scripts/live-proof/validate-config.mjs";
import {
  buildLiveProofPreset,
  ensureLiveProofPreset,
} from "../scripts/live-proof/prepare-preset.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RUNNER = join(ROOT, "scripts/live-proof/run-proof.sh");
const APPLY_SCRIPT = join(ROOT, "scripts/live-proof/proof-apply.jsx");

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gradient(count = 3) {
  return {
    schemaVersion: 1,
    colorStops: Array.from({ length: count }, (_, index) => ({
      offset: index / (count - 1),
      midpoint: 0.2 + index * 0.1,
      rgb: [index / count, 0.5, 1 - index / count],
      extra: 1,
    })),
    alphaStops: Array.from({ length: count }, (_, index) => ({
      offset: index / (count - 1),
      midpoint: 0.3 + index * 0.05,
      alpha: 1 - index / (count * 2),
    })),
  };
}

function config(root: string) {
  const token = "T20260718ABC123";
  return {
    schemaVersion: 1,
    runToken: token,
    scratchRoot: root,
    projectPath: join(root, `ae-native-gradient-${token}.aep`),
    evidenceRoot: join(root, "evidence"),
    expectedAeVersion: "26.3",
    expectedTargetPresent: true,
    expectedCandidateCount: 1,
    phase: "apply",
    kind: "fill",
    stopCount: 3,
    gradient: gradient(3),
    presetPath: join(root, `ae-gradient-${token}-fill-3.ffx`),
    presetSha256: "a".repeat(64),
    target: {
      compCreatedByHarness: false,
      compId: 11,
      compName: `AE Native Gradient Proof ${token}`,
      layerId: 22,
      layerIndex: 1,
      layerName: `__AE_NG_${token}_fill__`,
      propertyIndexPath: [2, 1, 2, 2, 1],
      matchNamePath: [
        "ADBE Root Vectors Group",
        "ADBE Vector Group",
        "ADBE Vectors Group",
        "ADBE Vector Graphic - G-Fill",
        "ADBE Vector Grad Colors",
      ],
    },
  };
}

test("live-proof config validation returns a normalized detached config", () => {
  const root = mkdtempSync(join(tmpdir(), "ae-ng-live-config-T20260718ABC123-"));
  try {
    const source = config(root);
    const sourceSnapshot = structuredClone(source);
    const validated = validateLiveProofConfig(source, { requireTarget: true });
    assert.deepEqual(source, sourceSnapshot);
    assert.notEqual(validated, source);
    assert.notEqual(validated.target, source.target);
    assert.notEqual(validated.gradient, source.gradient);
    assert.equal(validated.gradient.colorStops[1].rgb[0], Math.fround(source.gradient.colorStops[1].rgb[0]));
    assert.deepEqual(parseAndValidateLiveProofConfig(JSON.stringify(source), { requireTarget: true }), validated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AE version matching accepts the observed 26.3 build format and rejects drift", () => {
  assert.equal(matchesExpectedAeVersion("26.3x87", "26.3"), true);
  assert.equal(matchesExpectedAeVersion("26.3x87", "26.3x87"), true);
  assert.equal(matchesExpectedAeVersion("26.3x88", "26.3x87"), false);
  assert.equal(matchesExpectedAeVersion("26.4x1", "26.3"), false);
});

test("live-proof config validation rejects path escape, token drift, descriptor drift, and malformed gradients", () => {
  const root = mkdtempSync(join(tmpdir(), "ae-ng-live-invalid-T20260718ABC123-"));
  try {
    const cases: Array<[string, unknown]> = [
      ["unknown key", { ...config(root), surprise: true }],
      ["unsafe token", { ...config(root), runToken: "../escape" }],
      ["unmarked scratch root", { ...config(root), scratchRoot: tmpdir() }],
      ["project outside root", { ...config(root), projectPath: join(tmpdir(), "outside.aep") }],
      ["preset outside root", { ...config(root), presetPath: join(tmpdir(), "outside.ffx") }],
      ["wrong preset token", { ...config(root), presetPath: join(root, "ae-gradient-other-fill-3.ffx") }],
      ["wrong preset kind", { ...config(root), presetPath: join(root, "ae-gradient-T20260718ABC123-stroke-3.ffx") }],
      ["wrong stop count", { ...config(root), stopCount: 2 }],
      ["bad hash", { ...config(root), presetSha256: "abc" }],
      ["invalid target-presence flag", { ...config(root), expectedTargetPresent: "yes" }],
      ["negative candidate count", { ...config(root), expectedCandidateCount: -1 }],
      ["excess candidate count", { ...config(root), expectedCandidateCount: 2 }],
      ["empty property path", { ...config(root), target: { ...config(root).target, propertyIndexPath: [] } }],
      ["wrong terminal match name", {
        ...config(root),
        target: { ...config(root).target, matchNamePath: ["ADBE Vector Grad Colors"] },
      }],
      ["non-finite gradient", {
        ...config(root),
        gradient: { ...gradient(3), colorStops: [{ ...gradient(3).colorStops[0], offset: Number.NaN }, ...gradient(3).colorStops.slice(1)] },
      }],
    ];
    for (const [label, candidate] of cases) {
      assert.throws(() => validateLiveProofConfig(candidate, { requireTarget: true }), Error, label);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch generation embeds one reviewed script and removes the temporary global in finally", async () => {
  const root = mkdtempSync(join(tmpdir(), "ae-ng-live-dispatch-T20260718ABC123-"));
  try {
    const outputPath = join(root, "dispatch.jsx");
    const result = await createDispatch({
      config: config(root),
      implementationPath: APPLY_SCRIPT,
      outputPath,
    });
    const text = readFileSync(outputPath, "utf8");
    assert.equal(result.outputPath, outputPath);
    assert.equal(result.sha256, sha256(text));
    assert.match(text, new RegExp(LIVE_PROOF_GLOBAL_KEY));
    assert.match(text, /proof-apply/);
    assert.match(text, /finally/);
    assert.match(text, /delete \$\.global\[/);
    assert.equal((text.match(/__AE_NATIVE_GRADIENT_PROOF_IMPLEMENTATION__/g) ?? []).length, 1);
    const syntax = spawnSync(process.execPath, ["--check", "--input-type=commonjs"], {
      encoding: "utf8",
      input: text,
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch generation rejects symlinked implementation and existing output", async () => {
  const root = mkdtempSync(join(tmpdir(), "ae-ng-live-symlink-T20260718ABC123-"));
  try {
    const linked = join(root, "linked.jsx");
    symlinkSync(APPLY_SCRIPT, linked);
    await assert.rejects(createDispatch({
      config: config(root),
      implementationPath: linked,
      outputPath: join(root, "dispatch.jsx"),
    }), /reviewed live-proof (implementation|script)|symlink|regular/i);

    const output = join(root, "existing.jsx");
    writeFileSync(output, "owned");
    await assert.rejects(createDispatch({
      config: config(root),
      implementationPath: APPLY_SCRIPT,
      outputPath: output,
    }), /already exists/i);
    assert.equal(readFileSync(output, "utf8"), "owned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live-proof preset preparation creates once, resumes exactly, and rejects tampering", async () => {
  const root = mkdtempSync(join(tmpdir(), "ae-ng-live-preset-T20260718ABC123-"));
  try {
    const source = config(root);
    const explained = buildLiveProofPreset(source);
    source.presetSha256 = explained.presetSha256;
    assert.match(explained.presetSha256, /^[a-f0-9]{64}$/);
    assert.equal(explained.report.verification.outputGradient, true);

    const created = await ensureLiveProofPreset(source);
    assert.equal(created.created, true);
    assert.equal(sha256(readFileSync(source.presetPath)), explained.presetSha256);

    const resumed = await ensureLiveProofPreset(source);
    assert.equal(resumed.created, false);
    writeFileSync(source.presetPath, "tampered");
    await assert.rejects(ensureLiveProofPreset(source), /does not exactly match/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-proof validate-only creates evidence without invoking AE", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ae-ng-live-runner-T20260718ABC123-")));
  try {
    mkdirSync(join(root, "evidence"));
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify(config(root), null, 2)}\n`);
    chmodSync(RUNNER, 0o755);
    const result = spawnSync(RUNNER, [
      "--config", configPath,
      "--phase", "apply",
      "--validate-only",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        AE_HELPERS: join(root, "must-not-be-read.sh"),
      },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.executed, false);
    assert.equal(report.phase, "apply");
    assert.equal(report.runToken, config(root).runToken);
    assert.match(report.dispatchSha256, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run-proof validate-only rejects symlinked scratch and evidence roots before dispatch writes", () => {
  const realScratch = realpathSync(mkdtempSync(join(tmpdir(), "ae-ng-live-real-T20260718ABC123-")));
  const linkedScratch = join(tmpdir(), `ae-ng-live-link-T20260718ABC123-${process.pid}-${Date.now()}`);
  const evidenceTarget = mkdtempSync(join(tmpdir(), "ae-ng-live-evidence-target-"));
  try {
    symlinkSync(realScratch, linkedScratch);
    const linkedConfigPath = join(linkedScratch, "config.json");
    writeFileSync(linkedConfigPath, `${JSON.stringify(config(linkedScratch), null, 2)}\n`);
    const linkedResult = spawnSync(RUNNER, [
      "--config", linkedConfigPath,
      "--phase", "apply",
      "--validate-only",
    ], { cwd: ROOT, encoding: "utf8", timeout: 10_000 });
    assert.notEqual(linkedResult.status, 0);
    assert.match(linkedResult.stderr, /scratchRoot.*(symlink|realpath)/i);
    assert.equal(existsSync(join(realScratch, "evidence")), false);
    assert.equal(readdirSync(realScratch).some((name) => name.startsWith("dispatch-")), false);

    const normalScratch = realpathSync(mkdtempSync(join(tmpdir(), "ae-ng-live-evidence-T20260718ABC123-")));
    try {
      symlinkSync(evidenceTarget, join(normalScratch, "evidence"));
      const normalConfigPath = join(normalScratch, "config.json");
      writeFileSync(normalConfigPath, `${JSON.stringify(config(normalScratch), null, 2)}\n`);
      const evidenceResult = spawnSync(RUNNER, [
        "--config", normalConfigPath,
        "--phase", "apply",
        "--validate-only",
      ], { cwd: ROOT, encoding: "utf8", timeout: 10_000 });
      assert.notEqual(evidenceResult.status, 0);
      assert.match(evidenceResult.stderr, /evidenceRoot.*symlink/i);
      assert.equal(readdirSync(normalScratch).some((name) => name.startsWith("dispatch-")), false);
      assert.equal(readdirSync(evidenceTarget).length, 0);
    } finally {
      rmSync(normalScratch, { recursive: true, force: true });
    }
  } finally {
    unlinkSync(linkedScratch);
    rmSync(realScratch, { recursive: true, force: true });
    rmSync(evidenceTarget, { recursive: true, force: true });
  }
});

test("run-proof execute fails before reading helpers without a matching approval token", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ae-ng-live-gate-T20260718ABC123-")));
  try {
    mkdirSync(join(root, "evidence"));
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify(config(root), null, 2)}\n`);
    chmodSync(RUNNER, 0o755);
    const result = spawnSync(RUNNER, [
      "--config", configPath,
      "--phase", "apply",
      "--execute",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        AE_NATIVE_GRADIENT_LIVE_APPROVED: "wrong-token",
        AE_HELPERS: join(root, "must-not-be-read.sh"),
      },
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approval token|LIVE_APPROVED|runToken/i);
    assert.doesNotMatch(result.stderr, /helpers path|ENOENT/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
