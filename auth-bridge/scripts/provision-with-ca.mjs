#!/usr/bin/env node

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "../lib/env.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = { ...process.env };
await loadDotEnv(resolve(projectRoot, ".env"), env);

const certificatePath = env.AUTHBRIDGE_CA_CERTIFICATE?.trim();
if (!certificatePath || !isAbsolute(certificatePath)) {
  throw new Error("AUTHBRIDGE_CA_CERTIFICATE must be an absolute PEM bundle path");
}
const certificate = await stat(certificatePath);
if (!certificate.isFile()) throw new Error("AUTHBRIDGE_CA_CERTIFICATE must point to a file");

const child = spawn(process.execPath, [resolve(projectRoot, "scripts/provision.mjs")], {
  cwd: projectRoot,
  env: { ...env, NODE_EXTRA_CA_CERTS: certificatePath },
  stdio: "inherit",
});

const exitCode = await new Promise((resolvePromise, rejectPromise) => {
  child.once("error", rejectPromise);
  child.once("close", (code, signal) => {
    if (signal) rejectPromise(new Error(`Provisioner stopped by ${signal}`));
    else resolvePromise(code ?? 1);
  });
});
process.exitCode = exitCode;
