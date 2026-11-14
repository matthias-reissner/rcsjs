import { chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  checkin,
  checkout,
  createArchive,
  deleteSymbol,
  lockRevision,
  parseArchive,
  serializeArchive,
  setStrictLocking,
  setSymbol,
  unlockRevision,
} from "./index.js";

async function writeFileAtomically(filePath, content) {
  const destination = resolve(filePath);
  const directory = dirname(destination);
  const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`);
  let mode = 0o666;
  try {
    mode = (await stat(destination)).mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  let handle;
  let renamed = false;
  let destinationMadeWritable = false;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform === "win32" && !(mode & 0o222)) {
      await chmod(destination, mode | 0o200);
      destinationMadeWritable = true;
    }
    await rename(temporary, destination);
    renamed = true;
  } finally {
    if (handle) {
      await handle.close();
    }
    if (!renamed) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    if (!renamed && destinationMadeWritable) {
      await chmod(destination, mode);
    }
  }
}

async function withArchiveLock(archivePath, operation) {
  const lockPath = `${resolve(archivePath)}.lock`;
  const token = randomUUID();
  let handle;
  let lockInitialized = false;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Archive update is already in progress for ${archivePath}`, { cause: error });
    }
    throw error;
  }

  try {
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      token,
    }), "utf8");
    await handle.sync();
    lockInitialized = true;
    return await operation();
  } finally {
    await handle.close();
    if (!lockInitialized) {
      try {
        await unlink(lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    } else {
      let lockContents;
      try {
        lockContents = await readFile(lockPath, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      let lockOwner;
      if (lockContents !== undefined) {
        try {
          lockOwner = JSON.parse(lockContents);
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
        }
      }
      if (!lockOwner || lockOwner.token !== token) {
        throw new Error(`Archive update lock ownership changed for ${archivePath}`);
      }
      await unlink(lockPath);
    }
  }
}

function parseLockOwner(contents) {
  try {
    const parsed = JSON.parse(contents);
    if (
      parsed
      && typeof parsed === "object"
      && Number.isSafeInteger(parsed.pid)
      && parsed.pid > 0
      && typeof parsed.hostname === "string"
    ) {
      return { pid: parsed.pid, hostname: parsed.hostname };
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    // Older versions wrote only the PID, so handle that representation below.
  }

  const pid = Number(contents.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, hostname: "" } : undefined;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    if (error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

export async function inspectArchiveLock(archivePath) {
  const lockPath = `${resolve(archivePath)}.lock`;
  let contents;
  try {
    contents = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { locked: false, stale: false };
    }
    throw error;
  }

  const owner = parseLockOwner(contents);
  const stale = Boolean(
    owner
    && owner.hostname === hostname()
    && !isProcessRunning(owner.pid),
  );
  return {
    locked: true,
    pid: owner?.pid,
    hostname: owner?.hostname || undefined,
    stale,
  };
}

export async function removeStaleArchiveLock(archivePath) {
  const lockPath = `${resolve(archivePath)}.lock`;
  const recoveryPath = `${lockPath}.recover`;
  let recoveryHandle;
  try {
    recoveryHandle = await open(recoveryPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Stale-lock recovery is already in progress for ${archivePath}`, { cause: error });
    }
    throw error;
  }

  try {
    const status = await inspectArchiveLock(archivePath);
    if (!status.locked) {
      return false;
    }
    if (!status.stale) {
      throw new Error(`Cannot safely remove the archive lock for ${archivePath}: its owner may still be running`);
    }

    const contents = await readFile(lockPath, "utf8");
    const owner = parseLockOwner(contents);
    if (
      !owner
      || owner.hostname !== hostname()
      || isProcessRunning(owner.pid)
    ) {
      throw new Error(`Archive lock for ${archivePath} changed during stale-lock recovery`);
    }
    await unlink(lockPath);
    return true;
  } finally {
    await recoveryHandle.close();
    try {
      await unlink(recoveryPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export async function readArchiveFile(filePath, { binary } = {}) {
  if (binary !== undefined && typeof binary !== "boolean") {
    throw new TypeError("binary option must be a boolean");
  }
  const bytes = await readFile(filePath);
  const byteArchive = parseArchive(bytes, { binary: true });
  const isBinary = binary ?? byteArchive.expand === "b";
  const archive = isBinary ? byteArchive : parseArchive(bytes, { binary: false });
  if (isBinary) {
    archive.binary = true;
  }
  return archive;
}

export async function writeArchiveFile(filePath, archive) {
  const source = serializeArchive(archive);
  const contents = archive.binary
    ? typeof source === "string"
      ? Buffer.from(source, "latin1")
      : Buffer.from(source)
    : source;
  await writeFileAtomically(
    filePath,
    contents,
  );
}

export async function checkinFile(archivePath, workingPath, options = {}) {
  if (resolve(archivePath) === resolve(workingPath)) {
    throw new Error("archive and working file paths must be different");
  }

  return withArchiveLock(archivePath, async () => {
    const { description = "", binary: requestedBinary, ...checkinOptions } = options;
    if (requestedBinary !== undefined && typeof requestedBinary !== "boolean") {
      throw new TypeError("binary option must be a boolean");
    }
    let archive;
    try {
      archive = await readArchiveFile(archivePath, { binary: requestedBinary });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      archive = createArchive({ description });
    }

    const binary = requestedBinary ?? archive.binary ?? false;
    if (binary) {
      archive = { ...archive, binary: true, expand: "b" };
    }
    const contentBytes = await readFile(workingPath);
    const content = contentBytes.toString(binary ? "latin1" : "utf8");
    const updated = checkin(archive, content, checkinOptions);
    await writeArchiveFile(archivePath, updated);
    return updated;
  });
}

export async function checkoutFile(archivePath, workingPath, revision, options = {}) {
  if (resolve(archivePath) === resolve(workingPath)) {
    throw new Error("archive and working file paths must be different");
  }

  const archive = await readArchiveFile(archivePath, { binary: options.binary });
  const binary = options.binary ?? archive.binary ?? false;
  if (typeof binary !== "boolean") {
    throw new TypeError("binary option must be a boolean");
  }
  const text = checkout(archive, revision, {
    ...options,
    keywordMode: options.keywordMode ?? (binary ? "b" : undefined),
    source: options.source ?? archivePath,
  });
  const content = text instanceof Uint8Array
    ? Buffer.from(text)
    : binary
      ? Buffer.from(text, "latin1")
      : text;
  await writeFileAtomically(workingPath, content);
  return content;
}

export async function setSymbolFile(archivePath, name, revision, options = {}) {
  return withArchiveLock(archivePath, async () => {
    const archive = await readArchiveFile(archivePath);
    const updated = setSymbol(archive, name, revision, options);
    await writeArchiveFile(archivePath, updated);
    return updated;
  });
}

export async function deleteSymbolFile(archivePath, name) {
  return withArchiveLock(archivePath, async () => {
    const archive = await readArchiveFile(archivePath);
    const updated = deleteSymbol(archive, name);
    await writeArchiveFile(archivePath, updated);
    return updated;
  });
}

export async function lockRevisionFile(archivePath, user, revision, options = {}) {
  return withArchiveLock(archivePath, async () => {
    const archive = await readArchiveFile(archivePath);
    const updated = lockRevision(archive, user, revision, options);
    await writeArchiveFile(archivePath, updated);
    return updated;
  });
}

export async function unlockRevisionFile(archivePath, user, revision) {
  return withArchiveLock(archivePath, async () => {
    const archive = await readArchiveFile(archivePath);
    const updated = unlockRevision(archive, user, revision);
    await writeArchiveFile(archivePath, updated);
    return updated;
  });
}

export async function setStrictLockingFile(archivePath, enabled) {
  return withArchiveLock(archivePath, async () => {
    const archive = await readArchiveFile(archivePath);
    const updated = setStrictLocking(archive, enabled);
    await writeArchiveFile(archivePath, updated);
    return updated;
  });
}
