"use strict";

const PDF_WORKER_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const CHAPTER_HEADING =
  /^\s*(chapter|chap\.?|part|section)\s+((?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b.*)$/i;

const elements = {
  addChapter: document.querySelector("#add-chapter"),
  chapterCount: document.querySelector("#chapter-count"),
  chapterHelp: document.querySelector("#chapter-help"),
  chapterList: document.querySelector("#chapter-list"),
  documentMeta: document.querySelector("#document-meta"),
  documentPanel: document.querySelector("#document-panel"),
  documentTitle: document.querySelector("#document-title"),
  dropZone: document.querySelector("#drop-zone"),
  exportButton: document.querySelector("#export-button"),
  fileInput: document.querySelector("#pdf-input"),
  removeFile: document.querySelector("#remove-file"),
  statusMessage: document.querySelector("#status-message"),
};

const state = {
  chapters: [],
  file: null,
  pdfBytes: null,
  pageCount: 0,
};

pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;

elements.fileInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) {
    loadPdf(file);
  }
});

elements.dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  elements.dropZone.classList.add("is-dragging");
});

elements.dropZone.addEventListener("dragleave", (event) => {
  if (!elements.dropZone.contains(event.relatedTarget)) {
    elements.dropZone.classList.remove("is-dragging");
  }
});

elements.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("is-dragging");
  const [file] = event.dataTransfer.files;
  if (file) {
    loadPdf(file);
  }
});

elements.addChapter.addEventListener("click", () => {
  const nextPage = state.chapters.length
    ? Math.max(...state.chapters.map((chapter) => chapter.startPage)) + 1
    : 1;
  if (nextPage > state.pageCount) {
    showStatus("Every page already starts a chapter. Change a start page to make room.", true);
    return;
  }
  state.chapters.push({ title: "New chapter", startPage: nextPage });
  renderChapters();
});

elements.removeFile.addEventListener("click", reset);
elements.exportButton.addEventListener("click", exportChapters);

async function loadPdf(file) {
  clearStatus();
  if (!isPdfFile(file)) {
    showStatus("Choose a PDF file to get started.", true);
    return;
  }

  setBusy(true);
  showStatus("Reading your PDF and looking for chapter breaks…");

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    state.file = file;
    state.pdfBytes = bytes;
    state.pageCount = pdf.numPages;

    const bookmarks = await getBookmarkChapters(pdf);
    const chapters = bookmarks.length ? bookmarks : await findTextChapters(pdf);
    state.chapters = withFrontMatter(chapters, state.pageCount);

    elements.documentTitle.textContent = file.name;
    elements.documentMeta.textContent = `${formatFileSize(file.size)} · ${state.pageCount} pages`;
    elements.documentPanel.hidden = false;
    elements.chapterHelp.textContent = bookmarks.length
      ? "Found chapter starts in the PDF bookmarks. Edit a title or start page to fine-tune the split."
      : chapters.length
        ? "Found likely chapter headings in the PDF text. Review these suggestions; scanned pages without text need manual chapter markers."
        : "No bookmarks or chapter headings were found. Add a chapter and set its start page; scanned pages need manual markers.";
    renderChapters();

    if (chapters.length) {
      showStatus(
        bookmarks.length
          ? `Found ${bookmarks.length} chapter bookmark${bookmarks.length === 1 ? "" : "s"}. You can edit the split plan below.`
          : `Suggested ${chapters.length} chapter start${chapters.length === 1 ? "" : "s"} from searchable text. Review them before exporting.`,
      );
    } else {
      showStatus("No chapter markers found. Add your first chapter below to create a split plan.");
    }
  } catch (error) {
    reset();
    showStatus(`Could not read this PDF. ${error.message || "Try another file."}`, true);
  } finally {
    setBusy(false);
    elements.fileInput.value = "";
  }
}

function isPdfFile(file) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

async function getBookmarkChapters(pdf) {
  const outline = await pdf.getOutline();
  if (!outline) {
    return [];
  }

  const entries = [];
  const visit = async (items) => {
    for (const item of items) {
      if (item.dest) {
        try {
          const destination = typeof item.dest === "string"
            ? await pdf.getDestination(item.dest)
            : item.dest;
          if (destination && destination[0]) {
            entries.push({
              title: cleanTitle(item.title),
              startPage: (await pdf.getPageIndex(destination[0])) + 1,
            });
          }
        } catch {
          // Some PDFs contain stale bookmark destinations; other entries can still be used.
        }
      }
      if (item.items?.length) {
        await visit(item.items);
      }
    }
  };

  await visit(outline);
  return normalizeChapters(entries);
}

async function findTextChapters(pdf) {
  const matches = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    let line = "";

    for (const item of content.items) {
      if (typeof item.str !== "string") {
        continue;
      }
      line += item.str;
      if (item.hasEOL) {
        addHeadingMatch(matches, line, pageNumber);
        line = "";
      } else {
        line += " ";
      }
    }
    addHeadingMatch(matches, line, pageNumber);
  }
  return normalizeChapters(matches);
}

function addHeadingMatch(chapters, line, pageNumber) {
  const match = line.match(CHAPTER_HEADING);
  if (match) {
    chapters.push({
      title: cleanTitle(`${match[1]} ${match[2]}`),
      startPage: pageNumber,
    });
  }
}

function normalizeChapters(chapters) {
  const seenPages = new Set();
  return chapters
    .filter((chapter) => Number.isInteger(chapter.startPage) && chapter.startPage > 0)
    .sort((first, second) => first.startPage - second.startPage)
    .filter((chapter) => {
      if (seenPages.has(chapter.startPage)) {
        return false;
      }
      seenPages.add(chapter.startPage);
      return true;
    });
}

function withFrontMatter(chapters, pageCount) {
  const validChapters = normalizeChapters(chapters).filter(
    (chapter) => chapter.startPage <= pageCount,
  );
  if (!validChapters.length || validChapters[0].startPage === 1) {
    return validChapters;
  }
  return [{ title: "Front matter", startPage: 1 }, ...validChapters];
}

function renderChapters() {
  elements.chapterList.replaceChildren();
  elements.chapterCount.textContent = String(state.chapters.length);

  state.chapters.forEach((chapter, index) => {
    const row = document.createElement("div");
    row.className = "chapter-row";

    const number = document.createElement("span");
    number.className = "chapter-number";
    number.textContent = String(index + 1).padStart(2, "0");

    const title = document.createElement("input");
    title.className = "chapter-title";
    title.type = "text";
    title.value = chapter.title;
    title.setAttribute("aria-label", `Chapter ${index + 1} title`);
    title.addEventListener("input", () => {
      state.chapters[index].title = title.value;
    });

    const start = document.createElement("label");
    start.className = "chapter-start";
    start.append("Starts p.");

    const pageInput = document.createElement("input");
    pageInput.className = "page-input";
    pageInput.type = "number";
    pageInput.min = "1";
    pageInput.max = String(state.pageCount);
    pageInput.step = "1";
    pageInput.value = String(chapter.startPage);
    pageInput.setAttribute("aria-label", `Chapter ${index + 1} start page`);
    pageInput.addEventListener("change", () => {
      const page = Number(pageInput.value);
      if (!Number.isInteger(page) || page < 1 || page > state.pageCount) {
        pageInput.value = String(state.chapters[index].startPage);
        showStatus(`Enter a page number from 1 to ${state.pageCount}.`, true);
        return;
      }
      if (state.chapters.some((item, itemIndex) => itemIndex !== index && item.startPage === page)) {
        pageInput.value = String(state.chapters[index].startPage);
        showStatus("Each chapter needs a unique start page.", true);
        return;
      }
      state.chapters[index].startPage = page;
      state.chapters = normalizeChapters(state.chapters);
      renderChapters();
      clearStatus();
    });
    start.append(pageInput);

    const remove = document.createElement("button");
    remove.className = "remove-chapter";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${chapter.title || `chapter ${index + 1}`}`);
    remove.addEventListener("click", () => {
      state.chapters.splice(index, 1);
      renderChapters();
    });

    row.append(number, title, start, remove);
    elements.chapterList.append(row);
  });
}

async function exportChapters() {
  clearStatus();
  const chapters = prepareExportPlan();
  if (!chapters) {
    return;
  }

  elements.exportButton.disabled = true;
  elements.exportButton.textContent = "Preparing your chapters…";
  showStatus("Splitting pages and building your ZIP file…");

  try {
    const source = await PDFLib.PDFDocument.load(state.pdfBytes);
    const zip = new JSZip();
    const usedNames = new Set();

    for (let index = 0; index < chapters.length; index += 1) {
      const chapter = chapters[index];
      const nextChapter = chapters[index + 1];
      const firstPage = chapter.startPage - 1;
      const lastPage = nextChapter ? nextChapter.startPage - 2 : state.pageCount - 1;
      const output = await PDFLib.PDFDocument.create();
      const pageIndices = Array.from(
        { length: lastPage - firstPage + 1 },
        (_, offset) => firstPage + offset,
      );
      const copiedPages = await output.copyPages(source, pageIndices);
      copiedPages.forEach((page) => output.addPage(page));
      const fileName = uniqueFileName(makeFileName(chapter.title, index), usedNames);
      zip.file(`${fileName}.pdf`, await output.save());
    }

    const archive = await zip.generateAsync({ type: "blob" });
    downloadBlob(archive, `${fileBaseName(state.file.name)}-chapters.zip`);
    showStatus(`Done — ${chapters.length} PDF${chapters.length === 1 ? "" : "s"} downloaded in a ZIP file.`);
  } catch (error) {
    showStatus(`Could not split this PDF. ${error.message || "Please try again."}`, true);
  } finally {
    elements.exportButton.disabled = false;
    elements.exportButton.innerHTML = 'Split &amp; download <span aria-hidden="true">→</span>';
  }
}

function prepareExportPlan() {
  if (!state.pdfBytes || !state.pageCount) {
    showStatus("Choose a PDF before exporting.", true);
    return null;
  }

  const chapters = state.chapters.map((chapter) => ({ ...chapter }));
  if (!chapters.length) {
    showStatus("Add at least one chapter start page before exporting.", true);
    return null;
  }

  if (chapters.some((chapter) =>
    !Number.isInteger(chapter.startPage) || chapter.startPage < 1 || chapter.startPage > state.pageCount
  )) {
    showStatus(`Chapter start pages must be between 1 and ${state.pageCount}.`, true);
    return null;
  }
  chapters.sort((first, second) => first.startPage - second.startPage);

  const seenPages = new Set();
  for (const chapter of chapters) {
    if (seenPages.has(chapter.startPage)) {
      showStatus("Each chapter needs a unique start page.", true);
      return null;
    }
    seenPages.add(chapter.startPage);
  }

  return withFrontMatter(chapters, state.pageCount);
}

function makeFileName(title, index) {
  const safeTitle = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 70);
  return `${String(index + 1).padStart(2, "0")}-${safeTitle || "chapter"}`;
}

function uniqueFileName(fileName, usedNames) {
  let candidate = fileName;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${fileName}-${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function fileBaseName(fileName) {
  return fileName.replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "-") || "document";
}

function cleanTitle(title) {
  return title.replace(/\s+/g, " ").trim() || "Untitled chapter";
}

function formatFileSize(size) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setBusy(isBusy) {
  elements.fileInput.disabled = isBusy;
  elements.addChapter.disabled = isBusy;
  elements.removeFile.disabled = isBusy;
  elements.exportButton.disabled = isBusy;
}

function showStatus(message, isError = false) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.classList.toggle("is-error", isError);
  elements.statusMessage.hidden = false;
}

function clearStatus() {
  elements.statusMessage.hidden = true;
  elements.statusMessage.textContent = "";
  elements.statusMessage.classList.remove("is-error");
}

function reset() {
  state.file = null;
  state.pdfBytes = null;
  state.pageCount = 0;
  state.chapters = [];
  elements.documentPanel.hidden = true;
  elements.chapterList.replaceChildren();
  elements.fileInput.value = "";
  clearStatus();
}
