import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateGradientFfx } from "../dist/index.js";

const USAGE = "Usage: ae-native-gradient generate --kind <fill|stroke> --config <gradient.json> [--template <template.ffx>] [--write <output.ffx> [--force]]";
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_TEMPLATE_BYTES = 256 * 1024 * 1024;
const bundledTemplates = Object.freeze({
  fill: fileURLToPath(new URL("../fixtures/native-gradient/fill-template.ffx", import.meta.url)),
  stroke: fileURLToPath(new URL("../fixtures/native-gradient/stroke-template.ffx", import.meta.url)),
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(args) {
  let kind = null;
  let config = null;
  let template = null;
  let output = null;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--force") {
      if (force) throw new Error(`duplicate option --force\n${USAGE}`);
      force = true;
      continue;
    }
    if (!["--kind", "--config", "--template", "--write"].includes(argument)) {
      throw new Error(`unknown option ${argument}\n${USAGE}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}\n${USAGE}`);
    }
    index += 1;
    if (argument === "--kind") {
      if (kind !== null) throw new Error(`duplicate option --kind\n${USAGE}`);
      if (value !== "fill" && value !== "stroke") throw new Error(`kind must be fill or stroke\n${USAGE}`);
      kind = value;
    } else if (argument === "--config") {
      if (config !== null) throw new Error(`duplicate option --config\n${USAGE}`);
      config = value;
    } else if (argument === "--template") {
      if (template !== null) throw new Error(`duplicate option --template\n${USAGE}`);
      template = value;
    } else {
      if (output !== null) throw new Error(`duplicate option --write\n${USAGE}`);
      output = value;
    }
  }
  if (kind === null) throw new Error(`missing --kind\n${USAGE}`);
  if (config === null) throw new Error(`missing --config\n${USAGE}`);
  if (force && output === null) throw new Error(`--force requires --write\n${USAGE}`);
  return { kind, config, template: template ?? bundledTemplates[kind], output, force };
}

async function readBoundedRegularFile(path, maximum, label) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
    if (before.size > BigInt(maximum)) {
      throw new RangeError(`${label} byte limit exceeded: ${before.size} > ${maximum}`);
    }
    const source = new Uint8Array(Number(before.size));
    let offset = 0;
    while (offset < source.byteLength) {
      const { bytesRead } = await handle.read(source, offset, source.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} changed while reading: ${path}`);
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error(`${label} changed while reading: ${path}`);
    }
    return source;
  } finally {
    await handle.close();
  }
}

async function outputState(path) {
  try {
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink()) {
      throw new Error(`existing output must be a regular non-symlink file: ${path}`);
    }
    return "file";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function writeVerifiedOutput(path, bytes, force) {
  const absolute = resolve(path);
  const state = await outputState(absolute);
  if (state === "file" && !force) throw new Error(`output already exists; use --force to replace it: ${absolute}`);

  const temporary = resolve(dirname(absolute), `.${basename(absolute)}.${process.pid}.${randomUUID()}.tmp`);
  let temporaryExists = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const readback = await readBoundedRegularFile(temporary, MAX_TEMPLATE_BYTES, "temporary output");
    if (readback.byteLength !== bytes.byteLength || sha256(readback) !== sha256(bytes)) {
      throw new Error("temporary output verification failed");
    }
    if (force) {
      await rename(temporary, absolute);
      temporaryExists = false;
    } else {
      try {
        await link(temporary, absolute);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new Error(`output already exists; use --force to replace it: ${absolute}`);
        }
        throw error;
      }
      await unlink(temporary);
      temporaryExists = false;
    }
  } finally {
    if (temporaryExists) await unlink(temporary).catch(() => {});
  }
}

export async function runGenerate(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = parseArguments(args);
  const templatePath = resolve(options.template);
  const configPath = resolve(options.config);
  const [templateRealPath, configRealPath] = await Promise.all([
    realpath(templatePath),
    realpath(configPath),
  ]);
  if (options.output !== null) {
    const outputPath = resolve(options.output);
    if (outputPath === templatePath || outputPath === configPath) {
      throw new Error("output must not replace the template or config input");
    }
    try {
      const state = await lstat(outputPath);
      if (state.isFile() && !state.isSymbolicLink()) {
        const outputRealPath = await realpath(outputPath);
        if (outputRealPath === templateRealPath || outputRealPath === configRealPath) {
          throw new Error("output must not replace the template or config input");
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const [templateBytes, configBytes] = await Promise.all([
    readBoundedRegularFile(templatePath, MAX_TEMPLATE_BYTES, "template input"),
    readBoundedRegularFile(configPath, MAX_CONFIG_BYTES, "config input"),
  ]);
  const configText = new TextDecoder("utf-8", { fatal: true }).decode(configBytes);
  let gradient;
  try {
    gradient = JSON.parse(configText);
  } catch (error) {
    throw new Error(`invalid gradient config JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const generated = generateGradientFfx(templateBytes, options.kind, gradient);
  if (options.output !== null) await writeVerifiedOutput(options.output, generated.bytes, options.force);

  const report = {
    schemaVersion: 1,
    command: "generate",
    kind: options.kind,
    template: {
      byteLength: templateBytes.byteLength,
      sha256: sha256(templateBytes),
    },
    config: {
      byteLength: configBytes.byteLength,
      sha256: sha256(configBytes),
    },
    output: {
      byteLength: generated.bytes.byteLength,
      sha256: sha256(generated.bytes),
    },
    write: {
      requested: options.output !== null,
      completed: options.output !== null,
    },
    structure: generated.report,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
