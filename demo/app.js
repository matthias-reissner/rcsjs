import {
  checkin,
  checkout,
  createArchive,
  createUnifiedDiff,
  parseArchive,
  serializeArchive,
} from "../src/index.js";

const INITIAL_CONTENT = `rcsjs verwaltet Versionen im RCS-Format.

Bearbeite diesen Text und checke deine Änderungen ein.
Wähle danach eine Revision aus der Historie, um sie wiederherzustellen.
`;
const INITIAL_DATE = new Date("2026-01-15T10:00:00.000Z");

const elements = {
  archiveFile: document.querySelector("#archive-file"),
  archiveOutput: document.querySelector("#archive-output"),
  archiveSize: document.querySelector("#archive-size"),
  author: document.querySelector("#author"),
  checkinForm: document.querySelector("#checkin-form"),
  diffOutput: document.querySelector("#diff-output"),
  downloadArchive: document.querySelector("#download-archive"),
  logMessage: document.querySelector("#log-message"),
  notice: document.querySelector("#notice"),
  resetDemo: document.querySelector("#reset-demo"),
  revisionCount: document.querySelector("#revision-count"),
  revisionDetail: document.querySelector("#revision-detail"),
  revisionList: document.querySelector("#revision-list"),
  workingCopy: document.querySelector("#working-copy"),
};

let archive;
let selectedRevision;
let noticeTimer;

function createStarterArchive() {
  const starter = createArchive({
    description: "Beispielarchiv aus der rcsjs Browser-Demo",
  });
  return checkin(starter, INITIAL_CONTENT, {
    author: "alice",
    date: INITIAL_DATE,
    log: "Initiale Version",
  });
}

function showNotice(message, kind = "success") {
  window.clearTimeout(noticeTimer);
  elements.notice.textContent = message;
  elements.notice.className = `notice is-visible ${kind}`;
  noticeTimer = window.setTimeout(() => {
    elements.notice.className = "notice";
  }, 4200);
}

function getRevisionText(revision) {
  return checkout(archive, revision, { keywordMode: "o" });
}

function renderDiff() {
  const current = archive.revisions.find(
    (entry) => entry.revision === selectedRevision,
  );
  const previous = current?.next
    ? archive.revisions.find((entry) => entry.revision === current.next)
    : undefined;
  if (!current || !previous) {
    elements.diffOutput.textContent = current
      ? "Das ist die erste Revision — es gibt noch keine ältere Version zum Vergleichen."
      : "Wähle eine Revision aus der Historie.";
    elements.diffOutput.className = "diff-output is-empty";
    return;
  }

  const diff = createUnifiedDiff(
    getRevisionText(previous.revision),
    getRevisionText(current.revision),
    `a/README.txt@${previous.revision}`,
    `b/README.txt@${current.revision}`,
  );
  elements.diffOutput.textContent = diff;
  elements.diffOutput.className = "diff-output";
  if (!diff) {
    elements.diffOutput.textContent = "Keine Textänderungen zwischen diesen Revisionen.";
    elements.diffOutput.className = "diff-output is-empty";
  }
}

function renderRevisionDetail() {
  const entry = archive.revisions.find(
    (revision) => revision.revision === selectedRevision,
  );
  if (!entry) {
    elements.revisionDetail.textContent = "Noch keine Revision ausgewählt.";
    return;
  }

  const log = document.createElement("p");
  log.className = "revision-log";
  log.textContent = entry.log || "Keine Änderungsnotiz";

  const metadata = document.createElement("p");
  metadata.className = "revision-meta";
  metadata.textContent = `${entry.author} · ${entry.date.replaceAll(".", "/")}`;

  elements.revisionDetail.replaceChildren(log, metadata);
}

function renderRevisions() {
  elements.revisionCount.textContent = String(archive.revisions.length);
  const buttons = archive.revisions.map((entry) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "revision-item";
    button.type = "button";
    button.setAttribute("aria-pressed", String(entry.revision === selectedRevision));

    const number = document.createElement("span");
    number.className = "revision-number";
    number.textContent = entry.revision;

    const summary = document.createElement("span");
    summary.className = "revision-summary";
    summary.textContent = entry.log || "Keine Änderungsnotiz";

    const marker = document.createElement("span");
    marker.className = "revision-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = entry.revision === archive.head ? "HEAD" : "";

    button.append(number, summary, marker);
    button.addEventListener("click", () => {
      try {
        selectedRevision = entry.revision;
        elements.workingCopy.value = getRevisionText(entry.revision);
        render();
        showNotice(`Revision ${entry.revision} in die Arbeitskopie geladen.`);
      } catch (error) {
        showNotice(error.message, "error");
      }
    });
    item.append(button);
    return item;
  });
  elements.revisionList.replaceChildren(...buttons);
}

function renderArchive() {
  const serialized = serializeArchive(archive);
  elements.archiveOutput.textContent = serialized;
  elements.archiveSize.textContent = `${new TextEncoder().encode(serialized).length} Bytes`;
}

function render() {
  renderRevisions();
  renderRevisionDetail();
  renderDiff();
  renderArchive();
}

function resetDemo() {
  archive = createStarterArchive();
  selectedRevision = archive.head;
  elements.workingCopy.value = getRevisionText(selectedRevision);
  elements.author.value = "alice";
  elements.logMessage.value = "Text aktualisiert";
  render();
  showNotice("Beispielarchiv zurückgesetzt.");
}

elements.checkinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const previousHead = archive.head;
    const previousCount = archive.revisions.length;
    archive = checkin(archive, elements.workingCopy.value, {
      author: elements.author.value,
      log: elements.logMessage.value,
    });
    selectedRevision = archive.head;
    render();
    if (archive.revisions.length === previousCount) {
      showNotice("Keine neue Revision: Der Inhalt entspricht bereits dem aktuellen Stand.", "info");
      return;
    }
    elements.logMessage.value = "";
    showNotice(`Revision ${archive.head} wurde eingecheckt${previousHead ? "." : " — Archiv erstellt."}`);
  } catch (error) {
    showNotice(error.message, "error");
  }
});

elements.resetDemo.addEventListener("click", resetDemo);

elements.archiveFile.addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const [file] = input.files ?? [];
  if (!file) {
    return;
  }
  try {
    const imported = parseArchive(await file.text());
    if (imported.binary) {
      throw new Error("Binärarchive können in dieser Textdemo nicht geöffnet werden.");
    }
    archive = imported;
    selectedRevision = archive.revisions.some(
      (entry) => entry.revision === archive.head,
    )
      ? archive.head
      : archive.revisions.at(-1)?.revision;
    elements.workingCopy.value = selectedRevision
      ? getRevisionText(selectedRevision)
      : "";
    render();
    showNotice(`${file.name} wurde geladen.`);
  } catch (error) {
    showNotice(`Archiv konnte nicht geöffnet werden: ${error.message}`, "error");
  } finally {
    input.value = "";
  }
});

elements.downloadArchive.addEventListener("click", () => {
  const blob = new Blob([serializeArchive(archive)], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "README.txt,v";
  link.click();
  URL.revokeObjectURL(url);
});

resetDemo();
