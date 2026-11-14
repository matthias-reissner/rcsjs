function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function backtrack(trace, distance, before, after, offset) {
  let x = before.length;
  let y = after.length;
  const reversed = [];

  for (let d = distance; d > 0; d -= 1) {
    const previous = trace[d - 1];
    const diagonal = x - y;
    const previousDiagonal = diagonal === -d
      || (diagonal !== d && previous[offset + diagonal - 1] < previous[offset + diagonal + 1])
      ? diagonal + 1
      : diagonal - 1;
    const previousX = previous[offset + previousDiagonal];
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      reversed.push({ type: " ", line: before[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      reversed.push({ type: "+", line: after[y - 1] });
      y -= 1;
    } else {
      reversed.push({ type: "-", line: before[x - 1] });
      x -= 1;
    }
  }

  while (x > 0 && y > 0) {
    reversed.push({ type: " ", line: before[x - 1] });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    reversed.push({ type: "-", line: before[x - 1] });
    x -= 1;
  }
  while (y > 0) {
    reversed.push({ type: "+", line: after[y - 1] });
    y -= 1;
  }

  return reversed.reverse();
}

function diffLines(before, after) {
  const n = before.length;
  const m = after.length;
  const maxDistance = n + m;
  const offset = maxDistance + 1;
  let furthest = new Int32Array(maxDistance * 2 + 3);
  furthest.fill(-1);
  furthest[offset + 1] = 0;
  const trace = [];

  for (let distance = 0; distance <= maxDistance; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal;
      let x;
      if (
        diagonal === -distance
        || (diagonal !== distance && furthest[index - 1] < furthest[index + 1])
      ) {
        x = furthest[index + 1];
      } else {
        x = furthest[index - 1] + 1;
      }

      let y = x - diagonal;
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      furthest[index] = x;

      if (x >= n && y >= m) {
        trace.push(furthest.slice());
        return backtrack(trace, distance, before, after, offset);
      }
    }
    trace.push(furthest.slice());
  }

  throw new Error("Unable to compute text diff");
}

function formatOperation(operation) {
  const line = operation.line.endsWith("\n") ? operation.line : `${operation.line}\n`;
  const marker = operation.line.endsWith("\n") ? "" : "\\ No newline at end of file\n";
  return `${operation.type}${line}${marker}`;
}

export function createUnifiedDiff(beforeText, afterText, beforeLabel = "a", afterLabel = "b") {
  if (typeof beforeText !== "string" || typeof afterText !== "string") {
    throw new TypeError("diff inputs must be strings");
  }
  if (beforeText === afterText) {
    return "";
  }

  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const operations = diffLines(before, after);
  const context = 3;
  const hunks = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index].type === " ") {
      continue;
    }
    const start = Math.max(0, index - context);
    const end = Math.min(operations.length, index + context + 1);
    const previous = hunks[hunks.length - 1];
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      hunks.push({ start, end });
    }
  }

  const oldLineCounts = [0];
  const newLineCounts = [0];
  for (const operation of operations) {
    oldLineCounts.push(oldLineCounts[oldLineCounts.length - 1] + Number(operation.type !== "+"));
    newLineCounts.push(newLineCounts[newLineCounts.length - 1] + Number(operation.type !== "-"));
  }

  const formattedHunks = hunks.map(({ start, end }) => {
    const oldBefore = oldLineCounts[start];
    const newBefore = newLineCounts[start];
    const oldCount = oldLineCounts[end] - oldBefore;
    const newCount = newLineCounts[end] - newBefore;
    const oldStart = oldCount ? oldBefore + 1 : oldBefore;
    const newStart = newCount ? newBefore + 1 : newBefore;
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
    return `${header}\n${operations.slice(start, end).map(formatOperation).join("")}`;
  });
  return `--- ${beforeLabel}\n+++ ${afterLabel}\n${formattedHunks.join("")}`;
}

function createEdits(base, changed) {
  const operations = diffLines(base, changed);
  const edits = [];
  let baseIndex = 0;
  let pending;

  function finishEdit() {
    if (pending) {
      edits.push(pending);
      pending = undefined;
    }
  }

  for (const operation of operations) {
    if (operation.type === " ") {
      finishEdit();
      baseIndex += 1;
      continue;
    }
    if (!pending) {
      pending = { start: baseIndex, end: baseIndex, replacement: [] };
    }
    if (operation.type === "-") {
      baseIndex += 1;
      pending.end = baseIndex;
    } else {
      pending.replacement.push(operation.line);
    }
  }
  finishEdit();
  return edits;
}

function editsConflict(first, second) {
  const firstInsertion = first.start === first.end;
  const secondInsertion = second.start === second.end;
  if (firstInsertion && secondInsertion) {
    return first.start === second.start;
  }
  if (firstInsertion) {
    return first.start >= second.start && first.start < second.end;
  }
  if (secondInsertion) {
    return second.start >= first.start && second.start < first.end;
  }
  return first.start < second.end && second.start < first.end;
}

function applyEditsToRange(base, start, end, edits) {
  const result = [];
  let cursor = start;
  for (const edit of edits) {
    result.push(...base.slice(cursor, edit.start), ...edit.replacement);
    cursor = edit.end;
  }
  result.push(...base.slice(cursor, end));
  return result.join("");
}

function ensureNewline(text) {
  return text && !text.endsWith("\n") ? `${text}\n` : text;
}

export function mergeThreeWay(baseText, localText, incomingText, { local = "local", incoming = "incoming" } = {}) {
  if (![baseText, localText, incomingText].every((text) => typeof text === "string")) {
    throw new TypeError("merge inputs must be strings");
  }
  if (localText === incomingText) {
    return { content: localText, conflicts: 0 };
  }

  const base = splitLines(baseText);
  const localEdits = createEdits(base, splitLines(localText));
  const incomingEdits = createEdits(base, splitLines(incomingText));
  let localIndex = 0;
  let incomingIndex = 0;
  let baseCursor = 0;
  let content = "";
  let conflicts = 0;

  while (localIndex < localEdits.length || incomingIndex < incomingEdits.length) {
    const localEdit = localEdits[localIndex];
    const incomingEdit = incomingEdits[incomingIndex];
    if (!localEdit || !incomingEdit) {
      const edits = localEdit ? localEdits : incomingEdits;
      const index = localEdit ? localIndex : incomingIndex;
      const edit = edits[index];
      content += base.slice(baseCursor, edit.start).join("") + edit.replacement.join("");
      baseCursor = edit.end;
      if (localEdit) {
        localIndex += 1;
      } else {
        incomingIndex += 1;
      }
      continue;
    }

    if (!editsConflict(localEdit, incomingEdit)) {
      const takeLocal = localEdit.start < incomingEdit.start
        || (localEdit.start === incomingEdit.start && localEdit.end < incomingEdit.end);
      const edit = takeLocal ? localEdit : incomingEdit;
      content += base.slice(baseCursor, edit.start).join("") + edit.replacement.join("");
      baseCursor = edit.end;
      if (takeLocal) {
        localIndex += 1;
      } else {
        incomingIndex += 1;
      }
      continue;
    }

    let groupStart = Math.min(localEdit.start, incomingEdit.start);
    let groupEnd = Math.max(localEdit.end, incomingEdit.end);
    const localGroup = [localEdit];
    const incomingGroup = [incomingEdit];
    localIndex += 1;
    incomingIndex += 1;

    let expanded = true;
    while (expanded) {
      expanded = false;
      while (
        localIndex < localEdits.length
        && localGroup.some((edit) => editsConflict(edit, localEdits[localIndex]))
      ) {
        const edit = localEdits[localIndex];
        localGroup.push(edit);
        localIndex += 1;
        groupStart = Math.min(groupStart, edit.start);
        groupEnd = Math.max(groupEnd, edit.end);
        expanded = true;
      }
      while (
        incomingIndex < incomingEdits.length
        && (localGroup.some((edit) => editsConflict(edit, incomingEdits[incomingIndex]))
          || incomingGroup.some((edit) => editsConflict(edit, incomingEdits[incomingIndex])))
      ) {
        const edit = incomingEdits[incomingIndex];
        incomingGroup.push(edit);
        incomingIndex += 1;
        groupStart = Math.min(groupStart, edit.start);
        groupEnd = Math.max(groupEnd, edit.end);
        expanded = true;
      }
      while (
        localIndex < localEdits.length
        && incomingGroup.some((edit) => editsConflict(edit, localEdits[localIndex]))
      ) {
        const edit = localEdits[localIndex];
        localGroup.push(edit);
        localIndex += 1;
        groupStart = Math.min(groupStart, edit.start);
        groupEnd = Math.max(groupEnd, edit.end);
        expanded = true;
      }
    }

    content += base.slice(baseCursor, groupStart).join("");
    const localContent = applyEditsToRange(base, groupStart, groupEnd, localGroup);
    const incomingContent = applyEditsToRange(base, groupStart, groupEnd, incomingGroup);
    if (localContent === incomingContent) {
      content += localContent;
    } else {
      conflicts += 1;
      content += `<<<<<<< ${local}\n${ensureNewline(localContent)}=======\n${ensureNewline(incomingContent)}>>>>>>> ${incoming}\n`;
    }
    baseCursor = groupEnd;
  }

  content += base.slice(baseCursor).join("");
  return { content, conflicts };
}
