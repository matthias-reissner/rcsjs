#!/usr/bin/env node

import { access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  checkoutFile,
  checkinFile,
  deleteSymbolFile,
  inspectArchiveLock,
  lockRevisionFile,
  readArchiveFile,
  removeStaleArchiveLock,
  setStrictLockingFile,
  setSymbolFile,
  unlockRevisionFile,
} from "./node.js";
import { checkout, createUnifiedDiff, mergeThreeWay } from "./index.js";

const HELP = `Usage:
  rcsjs ci [options] <working-file> [archive-file]
  rcsjs co [options] <archive-or-working-file> [working-file]
  rcsjs rcsdiff <archive-file> <from-revision> <to-revision>
  rcsjs rcsmerge <archive-file> <base-revision> <local-revision> <incoming-revision>
  rcsjs rlog <archive-file>
  rcsjs tag [--force] <archive-file> <name> <revision>
  rcsjs untag <archive-file> <name>
  rcsjs lock [--force] <archive-file> <user> <revision>
  rcsjs unlock <archive-file> <user> <revision>
  rcsjs strict <archive-file> <on|off>
  rcsjs lock-status <archive-file>
  rcsjs recover-lock <archive-file>

ci options:
  -w, --author <name>       Revision author (required)
  -m, --message <text>      Revision log message
  -d, --date <date>         Revision date (ISO date or date string)
  -b, --branch <revision>   Branch number to check in to
  -t, --description <text>  Archive description for a new archive
  -f, --force               Create a revision even if the file is unchanged
      --binary              Preserve arbitrary file bytes; disable keywords
  -q, --quiet               Suppress successful status messages

tag options:
  -f, --force               Move an existing symbol to another revision

lock options:
  -f, --force               Break an existing lock on the revision

co options:
  -r, --revision <revision> Revision or symbol to check out
  -k, --keyword-mode <mode> Keyword mode (kv, kvl, k, v, o, b)
  -s, --source <path>       Source path used for RCS keywords
  -f, --force               Overwrite an existing working file
  -p, --print               Write checkout content to standard output
      --binary              Preserve arbitrary file bytes; disable keywords
  -q, --quiet               Suppress successful status messages

Use --help to display this message.
`;

const VALUE_OPTIONS = new Map([
  ["-w", "author"],
  ["--author", "author"],
  ["-m", "message"],
  ["--message", "message"],
  ["-d", "date"],
  ["--date", "date"],
  ["-b", "branch"],
  ["--branch", "branch"],
  ["-t", "description"],
  ["--description", "description"],
  ["-r", "revision"],
  ["--revision", "revision"],
  ["-k", "keywordMode"],
  ["--keyword-mode", "keywordMode"],
  ["-s", "source"],
  ["--source", "source"],
]);

function parseArguments(args) {
  const options = {};
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true, options, positional };
    }
    if (argument === "-f" || argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--binary") {
      options.binary = true;
      continue;
    }
    if (argument === "-p" || argument === "--print") {
      options.print = true;
      continue;
    }
    if (argument === "-q" || argument === "--quiet") {
      options.quiet = true;
      continue;
    }

    let option = argument;
    let inlineValue;
    if (argument.startsWith("--") && argument.includes("=")) {
      const separator = argument.indexOf("=");
      option = argument.slice(0, separator);
      inlineValue = argument.slice(separator + 1);
    } else if (
      argument.startsWith("-")
      && !argument.startsWith("--")
      && argument.length > 2
      && VALUE_OPTIONS.has(argument.slice(0, 2))
    ) {
      option = argument.slice(0, 2);
      inlineValue = argument.slice(2);
    }
    const optionName = VALUE_OPTIONS.get(option);
    if (optionName) {
      const value = inlineValue ?? args[++index];
      if (value === undefined || value.startsWith("-") && inlineValue === undefined) {
        throw new Error(`Missing value for ${option}`);
      }
      options[optionName] = value;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    positional.push(argument);
  }

  return { help: false, options, positional };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function resolveArchivePath(inputPath, { forCheckin = false } = {}) {
  if (inputPath.endsWith(",v")) {
    return inputPath;
  }
  const siblingArchive = `${inputPath},v`;
  const rcsArchive = join(dirname(inputPath), "RCS", `${basename(inputPath)},v`);
  if (await pathExists(siblingArchive)) {
    return siblingArchive;
  }
  if (await pathExists(rcsArchive)) {
    return rcsArchive;
  }
  if (forCheckin && await pathExists(dirname(inputPath) === "." ? "RCS" : join(dirname(inputPath), "RCS"))) {
    return rcsArchive;
  }
  if (forCheckin) {
    return siblingArchive;
  }
  throw new Error(`RCS archive not found for ${inputPath}`);
}

function defaultWorkingPath(inputPath, archivePath) {
  if (!inputPath.endsWith(",v")) {
    return inputPath;
  }
  const archiveDirectory = dirname(archivePath);
  const name = basename(inputPath).slice(0, -2);
  if (basename(archiveDirectory) === "RCS") {
    return join(dirname(archiveDirectory), name);
  }
  return inputPath.slice(0, -2);
}

function formatRevisionDate(value) {
  return value.replace(
    /^(\d{2}|\d{4})\.(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})$/,
    "$1/$2/$3 $4:$5:$6",
  );
}

function formatLog(archive, filePath) {
  const lines = [
    `RCS file: ${filePath}`,
    `head: ${archive.head || "(none)"}`,
  ];
  if (archive.branch) {
    lines.push(`default branch: ${archive.branch}`);
  }
  lines.push("", "description:", archive.description, "");

  if (archive.revisions.length === 0) {
    lines.push("no revisions present");
  }

  for (const revision of archive.revisions) {
    lines.push(
      `----------------------------`,
      `revision ${revision.revision}`,
      `date: ${formatRevisionDate(revision.date)}; author: ${revision.author}; state: ${revision.state};`,
    );
    if (revision.branches.length) {
      lines.push(`branches: ${revision.branches.join(", ")}`);
    }
    if (revision.next) {
      lines.push(`next: ${revision.next}`);
    }
    lines.push("", revision.log, "");
  }
  return `${lines.join("\n")}\n`;
}

async function ensureOutputDoesNotExist(path) {
  try {
    await access(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`working file already exists: ${path} (use --force to overwrite)`);
}

async function main(args) {
  const [command, ...commandArgs] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (
    command !== "ci"
    && command !== "co"
    && command !== "rlog"
    && command !== "rcsdiff"
    && command !== "rcsmerge"
    && command !== "tag"
    && command !== "untag"
    && command !== "lock"
    && command !== "unlock"
    && command !== "strict"
    && command !== "lock-status"
    && command !== "recover-lock"
  ) {
    throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }

  const { help, options, positional } = parseArguments(commandArgs);
  if (help) {
    console.log(HELP);
    return;
  }

  if (command === "rlog") {
    if (positional.length !== 1 || Object.keys(options).length > 0) {
      throw new Error("rlog expects an archive file and takes no options");
    }
    const [archivePath] = positional;
    const archive = await readArchiveFile(archivePath);
    process.stdout.write(formatLog(archive, archivePath));
    return;
  }

  if (command === "lock-status") {
    if (positional.length !== 1 || Object.keys(options).length > 0) {
      throw new Error("lock-status expects an archive file and takes no options");
    }
    const [archivePath] = positional;
    const status = await inspectArchiveLock(archivePath);
    if (!status.locked) {
      console.log(`no archive update lock for ${archivePath}`);
    } else if (status.stale) {
      console.log(`stale archive update lock for ${archivePath} (process ${status.pid} is not running)`);
    } else if (status.pid) {
      console.log(`archive update lock for ${archivePath} is owned by process ${status.pid}`);
    } else {
      console.log(`archive update lock for ${archivePath} exists; owner cannot be verified`);
    }
    return;
  }

  if (command === "recover-lock") {
    if (positional.length !== 1 || Object.keys(options).length > 0) {
      throw new Error("recover-lock expects an archive file and takes no options");
    }
    const [archivePath] = positional;
    const removed = await removeStaleArchiveLock(archivePath);
    console.log(removed
      ? `removed stale archive update lock for ${archivePath}`
      : `no archive update lock for ${archivePath}`);
    return;
  }

  if (command === "tag") {
    if (positional.length !== 3 || (Object.keys(options).some((key) => key !== "force"))) {
      throw new Error("tag expects an archive, symbol name, and revision");
    }
    const [archivePath, name, revision] = positional;
    await setSymbolFile(archivePath, name, revision, { force: options.force ?? false });
    console.log(`set symbol ${name} to ${revision}`);
    return;
  }

  if (command === "untag") {
    if (positional.length !== 2 || Object.keys(options).length > 0) {
      throw new Error("untag expects an archive and symbol name");
    }
    const [archivePath, name] = positional;
    await deleteSymbolFile(archivePath, name);
    console.log(`deleted symbol ${name}`);
    return;
  }

  if (command === "lock") {
    if (positional.length !== 3 || Object.keys(options).some((key) => key !== "force")) {
      throw new Error("lock expects an archive, user, and revision");
    }
    const [archivePath, user, revision] = positional;
    await lockRevisionFile(archivePath, user, revision, { force: options.force ?? false });
    console.log(`locked ${revision} for ${user}`);
    return;
  }

  if (command === "unlock") {
    if (positional.length !== 3 || Object.keys(options).length > 0) {
      throw new Error("unlock expects an archive, user, and revision");
    }
    const [archivePath, user, revision] = positional;
    await unlockRevisionFile(archivePath, user, revision);
    console.log(`unlocked ${revision} for ${user}`);
    return;
  }

  if (command === "strict") {
    if (positional.length !== 2 || Object.keys(options).length > 0) {
      throw new Error("strict expects an archive and on or off");
    }
    const [archivePath, setting] = positional;
    if (setting !== "on" && setting !== "off") {
      throw new Error("strict setting must be on or off");
    }
    await setStrictLockingFile(archivePath, setting === "on");
    console.log(`strict locking ${setting}`);
    return;
  }

  if (command === "rcsdiff") {
    if (positional.length !== 3 || Object.keys(options).length > 0) {
      throw new Error("rcsdiff expects an archive file and two revisions");
    }
    const [archivePath, fromRevision, toRevision] = positional;
    const archive = await readArchiveFile(archivePath);
    const before = checkout(archive, fromRevision);
    const after = checkout(archive, toRevision);
    if (before instanceof Uint8Array || after instanceof Uint8Array) {
      if (
        before instanceof Uint8Array
        && after instanceof Uint8Array
        && Buffer.compare(Buffer.from(before), Buffer.from(after)) === 0
      ) {
        return;
      }
      process.stdout.write(`Binary files ${archivePath}@${fromRevision} and ${archivePath}@${toRevision} differ\n`);
      process.exitCode = 1;
      return;
    }
    const diff = createUnifiedDiff(
      before,
      after,
      `${archivePath}@${fromRevision}`,
      `${archivePath}@${toRevision}`,
    );
    if (diff) {
      process.stdout.write(diff);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "rcsmerge") {
    if (positional.length !== 4 || Object.keys(options).length > 0) {
      throw new Error("rcsmerge expects an archive file and three revisions");
    }
    const [archivePath, baseRevision, localRevision, incomingRevision] = positional;
    const archive = await readArchiveFile(archivePath);
    const base = checkout(archive, baseRevision, { keywordMode: "k" });
    const local = checkout(archive, localRevision, { keywordMode: "k" });
    const incoming = checkout(archive, incomingRevision, { keywordMode: "k" });
    if ([base, local, incoming].some((content) => content instanceof Uint8Array)) {
      throw new Error("rcsmerge does not support binary revisions");
    }
    const result = mergeThreeWay(base, local, incoming);
    process.stdout.write(result.content);
    if (result.conflicts > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "ci") {
    if (positional.length < 1 || positional.length > 2) {
      throw new Error("ci expects a working file and an optional archive file");
    }
    const [workingPath, explicitArchivePath] = positional;
    const archivePath = explicitArchivePath ?? await resolveArchivePath(workingPath, { forCheckin: true });
    const allowed = new Set(["author", "message", "date", "branch", "description", "force", "binary", "quiet"]);
    if (Object.keys(options).some((key) => !allowed.has(key))) {
      throw new Error("ci received an option that it does not support");
    }
    const checkinOptions = {
      author: options.author,
      log: options.message,
      date: options.date,
      branch: options.branch,
      description: options.description,
      force: options.force,
      binary: options.binary,
    };
    for (const key of Object.keys(checkinOptions)) {
      if (checkinOptions[key] === undefined) {
        delete checkinOptions[key];
      }
    }
    await checkinFile(archivePath, workingPath, checkinOptions);
    if (!options.quiet) {
      console.log(`checked in ${archivePath}`);
    }
    return;
  }

  if (positional.length < 1 || positional.length > 2) {
    throw new Error("co expects an archive file and an optional working file");
  }
  const [inputPath, explicitWorkingPath] = positional;
  const archivePath = await resolveArchivePath(inputPath);
  const allowed = new Set(["revision", "keywordMode", "source", "force", "binary", "print", "quiet"]);
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    throw new Error("co received an option that it does not support");
  }
  if (options.print) {
    if (explicitWorkingPath) {
      throw new Error("co --print does not accept a working-file path");
    }
    const archive = await readArchiveFile(archivePath, { binary: options.binary });
    const binary = options.binary ?? (options.keywordMode === "b" || archive.binary === true);
    const content = checkout(archive, options.revision, {
      keywordMode: options.keywordMode ?? (binary ? "b" : undefined),
      source: options.source ?? archivePath,
    });
    process.stdout.write(content instanceof Uint8Array
      ? Buffer.from(content)
      : binary
        ? Buffer.from(content, "latin1")
        : content);
    return;
  }
  const workingPath = explicitWorkingPath ?? defaultWorkingPath(inputPath, archivePath);
  if (!options.force) {
    await ensureOutputDoesNotExist(workingPath);
  }
  await checkoutFile(archivePath, workingPath, options.revision, {
    keywordMode: options.keywordMode,
    source: options.source,
    binary: options.binary ?? options.keywordMode === "b",
  });
  if (!options.quiet) {
    console.log(`checked out ${workingPath}`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`rcsjs: ${error.message}`);
  process.exitCode = 1;
});
