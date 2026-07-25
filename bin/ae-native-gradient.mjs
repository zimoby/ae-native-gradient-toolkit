#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import {
  enumerateAepGradientCandidates,
  parseRifx,
  requireUniqueAepGradientCandidate,
} from "../dist/index.js";
import { runGenerate } from "./generate.mjs";

const INSPECT_USAGE = "Usage: ae-native-gradient inspect [--unique] <input.aep|input.ffx>";
const USAGE = `${INSPECT_USAGE}\n       ae-native-gradient generate --kind <fill|stroke> --config <gradient.json> [--template <template.ffx>] [--write <output.ffx> [--force]]`;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;

function parseArguments(args) {
  let unique = false;
  let input = null;
  for (const argument of args) {
    if (argument === "--unique") {
      if (unique) throw new Error(`duplicate option --unique\n${INSPECT_USAGE}`);
      unique = true;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`unknown option ${argument}\n${INSPECT_USAGE}`);
    if (input !== null) throw new Error(`expected exactly one input file\n${INSPECT_USAGE}`);
    input = argument;
  }
  if (input === null || input.length === 0) throw new Error(`missing input file\n${INSPECT_USAGE}`);
  return { input, unique };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundedRegularFile(input) {
  const handle = await open(input, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`input must be a regular file: ${input}`);
    if (before.size > BigInt(MAX_INPUT_BYTES)) {
      throw new RangeError(`input byte limit exceeded: ${before.size} > ${MAX_INPUT_BYTES}`);
    }

    const source = new Uint8Array(Number(before.size));
    let offset = 0;
    while (offset < source.byteLength) {
      const { bytesRead } = await handle.read(source, offset, source.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error(`input changed while reading: ${input}`);
      offset += bytesRead;
    }

    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error(`input changed while reading: ${input}`);
    }
    return source;
  } finally {
    await handle.close();
  }
}

function normalizeCandidate(source, candidate) {
  return {
    sourceOrder: candidate.sourceOrder,
    status: candidate.status,
    list: candidate.list,
    utf8Count: candidate.utf8Count,
    utf8Candidates: candidate.utf8Candidates,
    utf8IdentitiesTruncated: candidate.utf8IdentitiesTruncated,
    utf8: candidate.utf8,
    gradient: candidate.gradient,
    error: candidate.error,
    context: candidate.context,
    payloads: candidate.utf8Candidates.map((identity) => ({
      sha256: sha256(source.subarray(identity.span.dataStart, identity.span.dataEnd)),
    })),
  };
}

async function main() {
  const command = process.argv[2];
  if (command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "generate") {
    await runGenerate(process.argv.slice(3));
    return;
  }
  if (command !== "inspect") {
    throw new Error(`${command === undefined ? "missing command" : `unknown command ${command}`}\n${USAGE}`);
  }
  const inspectArgs = process.argv.slice(3);
  if (inspectArgs.length === 1 && (inspectArgs[0] === "--help" || inspectArgs[0] === "-h")) {
    process.stdout.write(`${INSPECT_USAGE}\n`);
    return;
  }
  const { input, unique } = parseArguments(inspectArgs);
  const source = await readBoundedRegularFile(input);
  const doc = parseRifx(source);
  const candidates = enumerateAepGradientCandidates(doc);
  const uniqueCandidate = unique ? requireUniqueAepGradientCandidate(candidates) : null;
  const report = {
    schemaVersion: 1,
    file: {
      byteLength: source.byteLength,
      sha256: sha256(source),
    },
    riff: {
      formType: doc.root.formType,
      declaredEnd: doc.declaredEnd,
      trailerStart: doc.trailerStart,
      trailerByteLength: source.byteLength - doc.trailerStart,
    },
    candidates: candidates.map((candidate) => normalizeCandidate(source, candidate)),
    ...(uniqueCandidate === null
      ? {}
      : { uniqueProof: { passed: true, sourceOrder: uniqueCandidate.sourceOrder } }),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
