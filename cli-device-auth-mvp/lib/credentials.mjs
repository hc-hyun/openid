import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOCK_WAIT_MS = 50;
const LOCK_TIMEOUT_MS = 75_000;
const STALE_LOCK_MS = 60_000;

export function credentialsPath() {
  const directory =
    process.env.SKILLSCTL_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "skillsctl-mvp");
  return join(directory, "credentials.json");
}

export async function saveCredentials(credentials) {
  const file = credentialsPath();
  const directory = dirname(file);
  const temporaryFile = `${file}.${process.pid}.tmp`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(temporaryFile, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporaryFile, 0o600);
  await rename(temporaryFile, file);
  await chmod(file, 0o600);
}

export async function loadCredentials() {
  try {
    return JSON.parse(await readFile(credentialsPath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`Could not read stored credentials: ${error.message}`);
  }
}

export async function deleteCredentials() {
  try {
    await unlink(credentialsPath());
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeStaleLock(lockFile) {
  try {
    const details = await stat(lockFile);
    if (Date.now() - details.mtimeMs <= STALE_LOCK_MS) return false;
    await unlink(lockFile);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

export async function withCredentialsLock(callback) {
  const file = credentialsPath();
  const directory = dirname(file);
  const lockFile = `${file}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  while (true) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await removeStaleLock(lockFile);
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the credential refresh lock");
      }
      await wait(LOCK_WAIT_MS);
    }
  }

  try {
    return await callback();
  } finally {
    try {
      const owner = JSON.parse(await readFile(lockFile, "utf8"));
      if (owner.token === token) await unlink(lockFile);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`warning: could not remove credential lock: ${error.message}`);
      }
    }
  }
}
