const REVISION_PATTERN = /^\d+(?:\.\d+)+$/;

export { createUnifiedDiff, mergeThreeWay } from "./diff.js";

function bytesToByteString(bytes) {
  let value = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return value;
}

function byteStringToBytes(value) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const byte = value.charCodeAt(index);
    if (byte > 0xff) {
      throw new TypeError("Binary RCS archives can only contain byte-range characters");
    }
    bytes[index] = byte;
  }
  return bytes;
}

function canonicalizeBranchNumber(revision) {
  const components = revision.split(".");
  if (
    components.length >= 4
    && components.length % 2 === 0
    && components[components.length - 2] === "0"
  ) {
    components.splice(components.length - 2, 1);
    return components.join(".");
  }
  return revision;
}

function tokenize(source) {
  const tokens = [];
  let position = 0;

  while (position < source.length) {
    if (/\s/.test(source[position])) {
      position += 1;
      continue;
    }

    if (source[position] === "@") {
      position += 1;
      let value = "";
      let closed = false;

      while (position < source.length) {
        if (source[position] !== "@") {
          value += source[position];
          position += 1;
        } else if (source[position + 1] === "@") {
          value += "@";
          position += 2;
        } else {
          position += 1;
          closed = true;
          break;
        }
      }

      if (!closed) {
        throw new Error("Unterminated @-quoted string in RCS archive");
      }
      tokens.push({ type: "string", value });
      continue;
    }

    if (source[position] === ";" || source[position] === ":") {
      tokens.push({ type: source[position], value: source[position] });
      position += 1;
      continue;
    }

    const start = position;
    while (
      position < source.length
      && !/\s/.test(source[position])
      && source[position] !== ";"
      && source[position] !== ":"
      && source[position] !== "@"
    ) {
      position += 1;
    }
    tokens.push({ type: "word", value: source.slice(start, position) });
  }

  return tokens;
}

class ArchiveParser {
  constructor(source) {
    this.tokens = tokenize(source);
    this.position = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.position + offset];
  }

  take(type, expected = type) {
    const token = this.peek();
    if (!token || token.type !== type) {
      throw new Error(`Expected ${expected} in RCS archive`);
    }
    this.position += 1;
    return token.value;
  }

  word(expected) {
    return this.take("word", expected);
  }

  string(expected) {
    return this.take("string", expected);
  }

  semicolon() {
    this.take(";", "';'");
  }

  scalar(name, allowEmpty = false) {
    this.word(name);
    const value = this.peek()?.type === ";" ? "" : this.word(`${name} value`);
    if (!allowEmpty && !value) {
      throw new Error(`Missing ${name} value in RCS archive`);
    }
    this.semicolon();
    return value;
  }

  list(name) {
    this.word(name);
    const values = [];
    while (this.peek()?.type !== ";") {
      values.push(this.word(`${name} value`));
    }
    this.semicolon();
    return values;
  }

  pairs(name) {
    this.word(name);
    const values = {};
    while (this.peek()?.type !== ";") {
      const key = this.word(`${name} name`);
      this.take(":", "':'");
      Object.defineProperty(values, key, {
        value: this.word(`${name} revision`),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    this.semicolon();
    return values;
  }

  parse() {
    const head = this.scalar("head", true);
    let branch = "";
    if (this.peek()?.value === "branch") {
      branch = this.scalar("branch", true);
    }

    const access = this.list("access");
    const symbols = this.pairs("symbols");
    const locks = this.pairs("locks");
    let strict = false;
    if (this.peek()?.value === "strict") {
      this.word("strict");
      this.semicolon();
      strict = true;
    }

    let comment = "";
    if (this.peek()?.value === "comment") {
      this.word("comment");
      comment = this.string("comment string");
      this.semicolon();
    }

    let expand = "kv";
    if (this.peek()?.value === "expand") {
      this.word("expand");
      expand = this.string("expand mode");
      this.semicolon();
    }

    const revisions = [];
    while (
      this.peek()?.type === "word"
      && REVISION_PATTERN.test(this.peek().value)
      && this.peek(1)?.value === "date"
    ) {
      const revision = this.word("revision number");
      const date = this.scalar("date");
      const author = this.scalar("author");
      const state = this.scalar("state", true);
      const branches = this.list("branches");
      const next = this.scalar("next", true);
      revisions.push({
        revision,
        date,
        author,
        state,
        branches,
        next,
        log: "",
        text: "",
      });
    }

    this.word("desc");
    const description = this.string("description");
    const byRevision = new Map(revisions.map((entry) => [entry.revision, entry]));
    const seenDeltatexts = new Set();

    while (this.peek()) {
      const revision = this.word("deltatext revision");
      const delta = byRevision.get(revision);
      if (!delta) {
        throw new Error(`Deltatext references unknown revision ${revision}`);
      }
      if (seenDeltatexts.has(revision)) {
        throw new Error(`Duplicate deltatext for revision ${revision}`);
      }
      seenDeltatexts.add(revision);
      this.word("log");
      delta.log = this.string("log message");
      this.word("text");
      delta.text = this.string("revision text");
    }

    for (const delta of revisions) {
      if (!seenDeltatexts.has(delta.revision)) {
        throw new Error(`Missing deltatext for revision ${delta.revision}`);
      }
    }
    if (head && !byRevision.has(head)) {
      throw new Error(`Head revision ${head} is missing from the archive`);
    }

    return {
      head,
      branch,
      access,
      symbols,
      locks,
      strict,
      comment,
      expand,
      description,
      revisions,
    };
  }
}

function quote(value) {
  if (typeof value !== "string") {
    throw new TypeError("RCS string values must be strings");
  }
  return `@${value.replaceAll("@", "@@")}@`;
}

function formatPairs(name, values) {
  const entries = Object.entries(values);
  return entries.length
    ? `${name}\n${entries.map(([key, value]) => `\t${key}:${value}`).join("\n")};`
    : `${name};`;
}

function formatList(name, values) {
  return values.length
    ? `${name}\n${values.map((value) => `\t${value}`).join("\n")};`
    : `${name};`;
}

export function createArchive({ description = "", binary = false } = {}) {
  if (typeof description !== "string") {
    throw new TypeError("description must be a string");
  }
  if (typeof binary !== "boolean") {
    throw new TypeError("binary option must be a boolean");
  }
  return {
    head: "",
    branch: "",
    access: [],
    symbols: {},
    locks: {},
    strict: false,
    comment: "",
    expand: binary ? "b" : "kv",
    description,
    revisions: [],
    ...(binary ? { binary: true } : {}),
  };
}

export function parseArchive(source, { binary } = {}) {
  if (binary !== undefined && typeof binary !== "boolean") {
    throw new TypeError("binary option must be a boolean");
  }
  let archive;
  if (source instanceof Uint8Array) {
    const byteArchive = new ArchiveParser(bytesToByteString(source)).parse();
    const isBinary = binary ?? byteArchive.expand === "b";
    archive = isBinary
      ? byteArchive
      : new ArchiveParser(new TextDecoder("utf-8", { ignoreBOM: true }).decode(source)).parse();
  } else if (typeof source === "string") {
    archive = new ArchiveParser(source).parse();
  } else {
    throw new TypeError("RCS archive source must be a string or Uint8Array");
  }
  if (binary ?? archive.expand === "b") {
    archive.binary = true;
  }
  if (archive.binary && typeof source === "string") {
    byteStringToBytes(source);
  }
  return archive;
}

export function setSymbol(archive, name, revision, { force = false } = {}) {
  if (!archive || !Array.isArray(archive.revisions)) {
    throw new TypeError("archive must be an RCS archive object");
  }
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    throw new TypeError("symbol name must start with a letter or underscore and contain only letters, numbers, _ or -");
  }
  if (typeof revision !== "string" || !/^\d+(?:\.\d+)+$/.test(revision)) {
    throw new TypeError("symbol target must be an RCS revision or branch number");
  }
  if (typeof force !== "boolean") {
    throw new TypeError("force must be a boolean");
  }

  const symbolicTarget = Object.hasOwn(archive.symbols ?? {}, revision)
    ? archive.symbols[revision]
    : revision;
  const target = canonicalizeBranchNumber(symbolicTarget);
  const components = target.split(".");
  const isBranch = components.length % 2 === 1;
  const parentRevision = isBranch ? components.slice(0, -1).join(".") : "";
  const validRevision = !isBranch
    ? archive.revisions.some((entry) => entry.revision === target)
    : archive.revisions.some((entry) => entry.revision === parentRevision
      && entry.branches.includes(`${target}.1`));
  if (!validRevision) {
    throw new Error(`Unknown RCS revision or branch: ${revision}`);
  }

  const existing = Object.hasOwn(archive.symbols ?? {}, name) ? archive.symbols[name] : undefined;
  if (existing && existing !== target && !force) {
    throw new Error(`Symbol ${name} already points to ${existing}; use force to move it`);
  }
  return {
    ...archive,
    symbols: { ...(archive.symbols ?? {}), [name]: target },
  };
}

export function deleteSymbol(archive, name) {
  if (!archive || !Array.isArray(archive.revisions)) {
    throw new TypeError("archive must be an RCS archive object");
  }
  if (typeof name !== "string" || !Object.hasOwn(archive.symbols ?? {}, name)) {
    throw new Error(`Unknown RCS symbol: ${name}`);
  }
  const symbols = { ...archive.symbols };
  delete symbols[name];
  return { ...archive, symbols };
}

export function lockRevision(archive, user, requestedRevision, { force = false } = {}) {
  if (!archive || !Array.isArray(archive.revisions)) {
    throw new TypeError("archive must be an RCS archive object");
  }
  if (typeof user !== "string" || !user.trim() || /[\s:@;]/.test(user)) {
    throw new TypeError("lock owner must be a non-empty name without whitespace or RCS delimiters");
  }
  if (typeof requestedRevision !== "string" || !requestedRevision) {
    throw new TypeError("lock requires a revision or branch");
  }
  if (typeof force !== "boolean") {
    throw new TypeError("force must be a boolean");
  }

  const revision = resolveRevision(archive, requestedRevision);
  const locks = { ...(archive.locks ?? {}) };
  const conflicts = Object.entries(locks)
    .filter(([owner, lockedRevision]) => lockedRevision === revision && owner !== user);
  const existing = Object.hasOwn(locks, user) ? locks[user] : undefined;
  if ((conflicts.length || (existing && existing !== revision)) && !force) {
    const owner = conflicts[0]?.[0];
    throw new Error(owner
      ? `Revision ${revision} is already locked by ${owner}`
      : `${user} already has revision ${existing} locked`);
  }
  for (const [owner] of conflicts) {
    delete locks[owner];
  }
  locks[user] = revision;
  return { ...archive, locks };
}

export function unlockRevision(archive, user, requestedRevision) {
  if (!archive || !Array.isArray(archive.revisions)) {
    throw new TypeError("archive must be an RCS archive object");
  }
  if (typeof user !== "string" || !user.trim()) {
    throw new TypeError("unlock requires a non-empty user name");
  }
  const revision = resolveRevision(archive, requestedRevision);
  if (!Object.hasOwn(archive.locks ?? {}, user) || archive.locks[user] !== revision) {
    throw new Error(`${user} does not hold a lock on revision ${revision}`);
  }
  const locks = { ...archive.locks };
  delete locks[user];
  return { ...archive, locks };
}

export function setStrictLocking(archive, enabled) {
  if (!archive || !Array.isArray(archive.revisions)) {
    throw new TypeError("archive must be an RCS archive object");
  }
  if (typeof enabled !== "boolean") {
    throw new TypeError("strict-locking setting must be a boolean");
  }
  return { ...archive, strict: enabled };
}

export function serializeArchive(archive) {
  if (!archive || !Array.isArray(archive.revisions)) {
    throw new TypeError("archive must be an RCS archive object");
  }

  const admin = [
    `head\t${archive.head || ""};`,
    ...(archive.branch ? [`branch\t${archive.branch};`] : []),
    formatList("access", archive.access ?? []),
    formatPairs("symbols", archive.symbols ?? {}),
    formatPairs("locks", archive.locks ?? {}),
    ...(archive.strict ? ["strict;"] : []),
    `comment\t${quote(archive.comment ?? "")};`,
    `expand\t${quote(archive.expand ?? "kv")};`,
  ].join("\n");

  const deltas = archive.revisions.map((entry) => [
    entry.revision,
    `date\t${entry.date};`,
    `author\t${entry.author};`,
    `state\t${entry.state ?? ""};`,
    formatList("branches", entry.branches ?? []),
    `next\t${entry.next ?? ""};`,
  ].join("\n")).join("\n\n");

  const deltatexts = archive.revisions.map((entry) => [
    entry.revision,
    "log",
    quote(entry.log ?? ""),
    "text",
    quote(entry.text ?? ""),
  ].join("\n")).join("\n\n");

  const source = `${admin}\n\n\n${deltas}\n\n\ndesc\n${quote(archive.description ?? "")}\n\n\n${deltatexts}\n`;
  return archive.binary ? byteStringToBytes(source) : source;
}

function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function createDiffScript(sourceText, targetText) {
  if (sourceText === targetText) {
    return "";
  }

  const source = splitLines(sourceText);
  const target = splitLines(targetText);
  let prefix = 0;
  while (prefix < source.length && prefix < target.length && source[prefix] === target[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < source.length - prefix
    && suffix < target.length - prefix
    && source[source.length - suffix - 1] === target[target.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const removedCount = source.length - prefix - suffix;
  const addedLines = target.slice(prefix, target.length - suffix);
  let script = "";

  if (removedCount) {
    script += `d${prefix + 1} ${removedCount}\n`;
  }
  if (addedLines.length) {
    const addLine = prefix + removedCount;
    script += `a${addLine} ${addedLines.length}\n${addedLines.join("")}`;
  }
  return script;
}

function applyDiffScript(source, script) {
  const lines = splitLines(source);
  const output = [];
  let cursor = 0;
  let position = 0;

  function readScriptLine() {
    const end = script.indexOf("\n", position);
    if (end === -1) {
      throw new Error("Malformed RCS diff -n script");
    }
    const line = script.slice(position, end);
    position = end + 1;
    return line;
  }

  while (position < script.length) {
    const command = readScriptLine();
    const match = /^([ad])(\d+)\s+(\d+)$/.exec(command);
    if (!match) {
      throw new Error(`Malformed RCS diff -n command: ${command}`);
    }
    const [, operation, lineValue, countValue] = match;
    const line = Number(lineValue);
    const count = Number(countValue);

    if (operation === "a") {
      const index = line;
      if (index < cursor || index > lines.length) {
        throw new Error("RCS diff -n add command is out of order");
      }
      output.push(...lines.slice(cursor, index));
      cursor = index;
      for (let added = 0; added < count; added += 1) {
        const end = script.indexOf("\n", position);
        if (end === -1) {
          if (added !== count - 1 || position === script.length) {
            throw new Error("Malformed RCS diff -n added lines");
          }
          output.push(script.slice(position));
          position = script.length;
        } else {
          output.push(script.slice(position, end + 1));
          position = end + 1;
        }
      }
    } else {
      const index = line - 1;
      if (index < cursor || index + count > lines.length) {
        throw new Error("RCS diff -n delete command is out of range");
      }
      output.push(...lines.slice(cursor, index));
      cursor = index + count;
    }
  }

  output.push(...lines.slice(cursor));
  return output.join("");
}

function resolveRevision(archive, requested) {
  const revision = requested ?? (archive.branch || archive.head);
  if (!revision) {
    throw new Error("The RCS archive has no head revision");
  }
  const symbolic = Object.hasOwn(archive.symbols ?? {}, revision) ? archive.symbols[revision] : undefined;
  const resolved = canonicalizeBranchNumber(symbolic ?? revision);
  const exact = archive.revisions.find((entry) => entry.revision === resolved);
  if (exact) {
    return resolved;
  }

  const parts = resolved.split(".");
  if (parts.length >= 3 && parts.length % 2 === 1 && parts.every((part) => /^\d+$/.test(part))) {
    const branchPoint = parts.slice(0, -1).join(".");
    const firstRevision = `${resolved}.1`;
    const parent = archive.revisions.find((entry) => entry.revision === branchPoint);
    if (!parent?.branches.includes(firstRevision)) {
      throw new Error(`Unknown RCS branch: ${revision}`);
    }

    let tip = archive.revisions.find((entry) => entry.revision === firstRevision);
    const seen = new Set();
    while (tip?.next) {
      if (seen.has(tip.revision)) {
        throw new Error(`Cycle in RCS branch ${resolved}`);
      }
      seen.add(tip.revision);
      if (!tip.next.startsWith(`${resolved}.`)) {
        throw new Error(`Invalid next revision ${tip.next} in branch ${resolved}`);
      }
      tip = archive.revisions.find((entry) => entry.revision === tip.next);
      if (!tip) {
        throw new Error(`Missing revision ${firstRevision} in RCS archive`);
      }
    }
    return tip.revision;
  }
  throw new Error(`Unknown RCS revision or symbol: ${revision}`);
}

function checkoutExact(archive, target) {
  const components = target.split(".");
  if (components.length > 2) {
    const branchPoint = components.slice(0, -2).join(".");
    const branchNumber = components.slice(0, -1).join(".");
    const firstRevision = `${branchNumber}.1`;
    const parent = archive.revisions.find((entry) => entry.revision === branchPoint);
    if (!parent?.branches.includes(firstRevision)) {
      throw new Error(`Branch ${branchNumber} is not attached to revision ${branchPoint}`);
    }

    let content = checkoutExact(archive, branchPoint);
    let current = archive.revisions.find((entry) => entry.revision === firstRevision);
    const seen = new Set();
    while (current) {
      if (seen.has(current.revision)) {
        throw new Error(`Cycle in RCS branch ${branchNumber}`);
      }
      seen.add(current.revision);
      content = applyDiffScript(content, current.text);
      if (current.revision === target) {
        return content;
      }
      if (!current.next || !current.next.startsWith(`${branchNumber}.`)) {
        break;
      }
      current = archive.revisions.find((entry) => entry.revision === current.next);
    }
    throw new Error(`Revision ${target} is not reachable on branch ${branchNumber}`);
  }

  let current = archive.head;
  let content = archive.revisions.find((entry) => entry.revision === current)?.text;

  if (typeof content !== "string") {
    throw new Error(`Missing deltatext for head revision ${current}`);
  }

  const seen = new Set();
  while (current !== target) {
    if (seen.has(current)) {
      throw new Error(`Cycle in trunk revisions at ${current}`);
    }
    seen.add(current);
    const currentDelta = archive.revisions.find((entry) => entry.revision === current);
    if (!currentDelta?.next) {
      throw new Error(`Revision ${target} is not reachable from head ${archive.head}`);
    }
    const olderDelta = archive.revisions.find((entry) => entry.revision === currentDelta.next);
    if (!olderDelta) {
      throw new Error(`Missing revision ${currentDelta.next} in RCS archive`);
    }
    content = applyDiffScript(content, olderDelta.text);
    current = olderDelta.revision;
  }

  return content;
}

function formatKeywordDate(value) {
  const match = /^(\d{2}|\d{4})\.(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})\.(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid RCS revision date: ${value}`);
  }
  let year = Number(match[1]);
  if (match[1].length === 2) {
    year += year < 69 ? 2000 : 1900;
  }
  const [, , month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(year, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
    || date.getUTCHours() !== Number(hour)
    || date.getUTCMinutes() !== Number(minute)
    || date.getUTCSeconds() !== Number(second)
  ) {
    throw new Error(`Invalid RCS revision date: ${value}`);
  }

  const datePart = `${year}/${match[2]}/${match[3]}`;
  const timePart = `${match[4]}:${match[5]}:${match[6]}`;
  const monthName = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  return { date: `${datePart} ${timePart}`, mdocdate: `${monthName} ${Number(day)}, ${year}` };
}

function expandKeywords(content, archive, revision, delta, requestedRevision, options) {
  const mode = options.keywordMode ?? archive.expand ?? "kv";
  if (!["kv", "kvl", "k", "v", "o", "b"].includes(mode)) {
    throw new Error(`Unsupported RCS keyword expansion mode: ${mode}`);
  }
  if (mode === "o" || mode === "b") {
    return content;
  }

  const source = options.source ?? archive.source ?? "";
  const normalizedSource = source.replaceAll("\\", "/");
  const fileName = normalizedSource.split("/").pop();
  const name = options.name
    ?? (Object.hasOwn(archive.symbols ?? {}, requestedRevision) ? requestedRevision : "");
  const locker = Object.entries(archive.locks ?? {})
    .find(([, lockedRevision]) => lockedRevision === revision)?.[0] ?? "";
  const date = formatKeywordDate(delta.date);
  const values = {
    Author: delta.author,
    Date: date.date,
    Header: [source, revision, date.date, delta.author, delta.state].filter(Boolean).join(" "),
    Id: [fileName, revision, date.date, delta.author, delta.state].filter(Boolean).join(" "),
    Locker: mode === "kvl" ? locker : "",
    Mdocdate: date.mdocdate,
    Name: name,
    OpenBSD: [fileName, revision, date.date, delta.author, delta.state].filter(Boolean).join(" "),
    RCSfile: fileName,
    Revision: revision,
    Source: source,
    State: delta.state,
  };
  const keywordPattern = /\$(Author|Date|Header|Id|Locker|Log|Mdocdate|Name|OpenBSD|RCSfile|Revision|Source|State)(?:\s*:\s*[^$]*)?\$/g;

  return content.replace(keywordPattern, (token, keyword) => {
    if (keyword === "Log") {
      if (mode === "k") {
        return "$Log$";
      }
      const leader = archive.comment ?? "";
      const logText = (delta.log ?? "").replace(/(?:\r?\n)+$/, "");
      const logLines = logText ? logText.split(/\r?\n/).map((line) => `${leader}${line}`) : [];
      const header = `${leader}Revision ${revision}  ${date.date}  ${delta.author}`;
      const separator = leader.replace(/\s+$/, "");
      const logBody = logLines.length ? `\n${logLines.join("\n")}` : "";
      const expanded = `$Log: ${fileName} $\n${header}${logBody}\n${separator}`;
      return mode === "v" ? `${header}${logBody}` : expanded;
    }

    if (!(keyword in values)) {
      return token;
    }
    if (mode === "k") {
      return `$${keyword}$`;
    }
    const value = values[keyword] ?? "";
    return mode === "v" ? value : `$${keyword}: ${value} $`;
  });
}

function checkoutText(archive, requestedRevision, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("checkout options must be an object");
  }
  const revision = resolveRevision(archive, requestedRevision);
  const delta = archive.revisions.find((entry) => entry.revision === revision);
  const content = checkoutExact(archive, revision);
  return expandKeywords(content, archive, revision, delta, requestedRevision, options);
}

export function checkout(archive, requestedRevision, options = {}) {
  const content = checkoutText(archive, requestedRevision, options);
  return archive.binary ? byteStringToBytes(content) : content;
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("date must be a valid Date or date string");
  }
  const [day, time] = date.toISOString().split("T");
  const [year, month, dayOfMonth] = day.split("-");
  const [hour, minute, seconds] = time.slice(0, 8).split(":");
  return `${year}.${month}.${dayOfMonth}.${hour}.${minute}.${seconds}`;
}

function releaseCheckinLock(archive, locks, author, previousRevision) {
  if (!previousRevision) {
    return locks;
  }

  const owner = Object.entries(locks)
    .find(([, lockedRevision]) => lockedRevision === previousRevision)?.[0];
  if (archive.strict && owner !== author) {
    throw new Error(`Strict locking requires ${author} to lock revision ${previousRevision}`);
  }

  const updated = { ...locks };
  if (updated[author] === previousRevision) {
    delete updated[author];
  }
  return updated;
}

function matchesRevisionContent(archive, revision, content) {
  return content === checkoutText(archive, revision, { keywordMode: "o" })
    || content === checkoutText(archive, revision);
}

export function checkin(
  archive,
  content,
  { author, log = "", date = new Date(), state = "Exp", branch, force = false } = {},
) {
  const binary = archive?.binary === true;
  if (binary && content instanceof Uint8Array) {
    content = bytesToByteString(content);
  }
  if (typeof content !== "string") {
    throw new TypeError("checked-in content must be a string");
  }
  if (binary) {
    byteStringToBytes(content);
  }
  if (typeof author !== "string" || !author.trim()) {
    throw new TypeError("checkin requires a non-empty author");
  }
  if (typeof log !== "string" || typeof state !== "string") {
    throw new TypeError("log and state must be strings");
  }
  if (typeof force !== "boolean") {
    throw new TypeError("force must be a boolean");
  }

  const revisions = archive.revisions.map((entry) => ({ ...entry, branches: [...entry.branches] }));
  const revisionDate = formatDate(date);
  const selectedBranch = branch ?? archive.branch;

  if (selectedBranch) {
    const branchRevision = archive.symbols?.[selectedBranch] ?? selectedBranch;
    const components = branchRevision.split(".");
    if (
      components.length < 3
      || components.length % 2 !== 1
      || !components.every((part) => /^\d+$/.test(part))
    ) {
      throw new Error(`Invalid RCS branch number: ${selectedBranch}`);
    }

    const branchNumber = components.join(".");
    const branchPoint = components.slice(0, -1).join(".");
    const parent = revisions.find((entry) => entry.revision === branchPoint);
    if (!parent) {
      throw new Error(`Branch point revision ${branchPoint} does not exist`);
    }

    const firstRevision = `${branchNumber}.1`;
    let tip = parent.branches.includes(firstRevision)
      ? revisions.find((entry) => entry.revision === firstRevision)
      : undefined;
    if (parent.branches.includes(firstRevision) && !tip) {
      throw new Error(`Missing first revision ${firstRevision} in RCS archive`);
    }

    if (!tip) {
      if (revisions.some((entry) => entry.revision.startsWith(`${branchNumber}.`))) {
        throw new Error(`Branch ${branchNumber} is not linked from ${branchPoint}`);
      }
      const locks = releaseCheckinLock(archive, archive.locks ?? {}, author.trim(), branchPoint);
      const baseContent = checkoutText(archive, branchPoint);
      if (!force && matchesRevisionContent(archive, branchPoint, content)) {
        return { ...archive, locks };
      }
      parent.branches.push(firstRevision);
      const firstBranchRevision = {
        revision: firstRevision,
        date: revisionDate,
        author: author.trim(),
        state,
        branches: [],
        next: "",
        log,
        text: createDiffScript(baseContent, content),
      };
      return { ...archive, locks, revisions: [...revisions, firstBranchRevision] };
    }

    const seen = new Set();
    while (tip.next) {
      if (seen.has(tip.revision)) {
        throw new Error(`Cycle in RCS branch ${branchNumber}`);
      }
      seen.add(tip.revision);
      if (!tip.next.startsWith(`${branchNumber}.`)) {
        throw new Error(`Invalid next revision ${tip.next} in branch ${branchNumber}`);
      }
      tip = revisions.find((entry) => entry.revision === tip.next);
      if (!tip) {
        throw new Error(`Missing next revision in branch ${branchNumber}`);
      }
    }

    const previousContent = checkoutText(archive, tip.revision);
    const locks = releaseCheckinLock(archive, archive.locks ?? {}, author.trim(), tip.revision);
    if (!force && matchesRevisionContent(archive, tip.revision, content)) {
      return { ...archive, locks };
    }
    const parts = tip.revision.split(".");
    const nextRevision = `${branchNumber}.${Number(parts[parts.length - 1]) + 1}`;
    tip.next = nextRevision;
    revisions.push({
      revision: nextRevision,
      date: revisionDate,
      author: author.trim(),
      state,
      branches: [],
      next: "",
      log,
      text: createDiffScript(previousContent, content),
    });
    return { ...archive, locks, revisions };
  }

  let revision = "1.1";
  let previousHead = "";
  if (archive.head) {
    const match = /^(\d+)\.(\d+)$/.exec(archive.head);
    if (!match) {
      throw new Error("Trunk check-in requires a two-component head revision");
    }
    revision = `${match[1]}.${Number(match[2]) + 1}`;
    previousHead = archive.head;
  }

  const previous = revisions.find((entry) => entry.revision === previousHead);
  if (previousHead && !previous) {
    throw new Error(`Head revision ${previousHead} is missing from the archive`);
  }
  const previousContent = previousHead ? checkoutText(archive, previousHead) : "";
  const locks = releaseCheckinLock(archive, archive.locks ?? {}, author.trim(), previousHead);
  if (
    previousHead
    && !force
    && matchesRevisionContent(archive, previousHead, content)
  ) {
    return { ...archive, locks };
  }
  if (previous) {
    previous.text = createDiffScript(content, previousContent);
  }

  const nextRevision = {
    revision,
    date: revisionDate,
    author: author.trim(),
    state,
    branches: [],
    next: previousHead,
    log,
    text: content,
  };

  return {
    ...archive,
    locks,
    head: revision,
    revisions: [nextRevision, ...revisions],
  };
}
