(function () {
  /* ---- elementi DOM ---- */
  const galleryEl        = document.getElementById("gallery");
  const emptyStateEl     = document.getElementById("empty-state");
  const detailContentEl  = document.getElementById("detail-content");

  const searchForm       = document.getElementById("search-form");
  const searchInput      = document.getElementById("search-input");
  const clearSearchBtn   = document.getElementById("clear-search");

  const filterMediaKindEl = document.getElementById("filter-media-kind");
  const filterExtEl       = document.getElementById("filter-ext");
  const filterMakeEl      = document.getElementById("filter-make");
  const filterModelEl     = document.getElementById("filter-model");
  const filterCameraIdEl  = document.getElementById("filter-camera-id");
  const filterLensModelEl = document.getElementById("filter-lens-model");
  const filterAiModelEl   = document.getElementById("filter-ai-model");
  const filterFolderEl    = document.getElementById("filter-folder");
  const sortSelectEl      = document.getElementById("sort-select");

  const toggleShowFolderEl = document.getElementById("toggle-show-folder");
  const toggleCompactEl    = document.getElementById("toggle-compact");

  const resultsSummaryEl  = document.getElementById("results-summary");
  const activeFiltersEl   = document.getElementById("active-filters");

  const firstPageBtn = document.getElementById("first-page");
  const prevPageBtn  = document.getElementById("prev-page");
  const nextPageBtn  = document.getElementById("next-page");
  const lastPageBtn  = document.getElementById("last-page");
  const pageInfoEl   = document.getElementById("page-info");

  /* ---- stato globale ---- */
  const PAGE_LIMIT = 100;

  let currentItems      = [];
  let currentPage       = 1;
  let currentTotal      = 0;
  let currentTotalPages = 1;
  let currentSelectedId = null;

  const state = {
    q: "", page: 1,
    mediaKind: "", ext: "", make: "", model: "",
    cameraId: "", lensModel: "", aiModel: "", folder: "",
    sort: "created_desc",
    showFolder: false,
    compact: false,
  };

  /* ---- utilità ---- */
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function formatSize(bytes) {
    if (bytes == null || Number.isNaN(Number(bytes))) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = Number(bytes), u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
  }

  function formatTimestamp(ts) {
    if (ts == null || Number.isNaN(Number(ts))) return "";
    const d = new Date(Number(ts) * 1000);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("it-IT");
  }

  /* ---- URL costruzione ---- */
  function buildMediaUrl() {
    const p = new URLSearchParams();
    p.set("page",  String(state.page));
    p.set("limit", String(PAGE_LIMIT));
    p.set("sort",  state.sort);
    if (state.q)         p.set("q",          state.q);
    if (state.mediaKind) p.set("media_kind", state.mediaKind);
    if (state.ext)       p.set("ext",        state.ext);
    if (state.make)      p.set("make",       state.make);
    if (state.model)     p.set("model",      state.model);
    if (state.cameraId)  p.set("camera_id",  state.cameraId);
    if (state.lensModel) p.set("lens_model", state.lensModel);
    if (state.aiModel)   p.set("ai_model",   state.aiModel);
    if (state.folder)    p.set("folder",     state.folder);
    return `/media?${p.toString()}`;
  }

  /* ---- paginazione UI ---- */
  function updatePaginationUI() {
    pageInfoEl.textContent = `Pagina ${currentPage} / ${currentTotalPages}`;
    firstPageBtn.disabled = currentPage <= 1;
    prevPageBtn.disabled  = currentPage <= 1;
    nextPageBtn.disabled  = currentPage >= currentTotalPages;
    lastPageBtn.disabled  = currentPage >= currentTotalPages;
  }

  /* ---- riepilogo risultati ---- */
  function renderResultsSummary() {
    const from = currentTotal === 0 ? 0 : (currentPage - 1) * PAGE_LIMIT + 1;
    const to   = Math.min(currentPage * PAGE_LIMIT, currentTotal);
    resultsSummaryEl.textContent =
      `${currentTotal} elementi — visualizzati ${from}–${to}`;
  }

  /* ---- chip filtri attivi ---- */
  function renderActiveFilters() {
    const chips = [];
    if (state.q)         chips.push(`Testo: ${state.q}`);
    if (state.mediaKind) chips.push(`Tipo: ${state.mediaKind}`);
    if (state.ext)       chips.push(`Ext: .${state.ext}`);
    if (state.make)      chips.push(`Make: ${state.make}`);
    if (state.model)     chips.push(`Model: ${state.model}`);
    if (state.cameraId)  chips.push(`CameraID: ${state.cameraId}`);
    if (state.lensModel) chips.push(`Lens: ${state.lensModel}`);
    if (state.aiModel)   chips.push(`AI: ${state.aiModel}`);
    if (state.folder)    chips.push(`Cartella: ${state.folder}`);
    activeFiltersEl.innerHTML = chips.length
      ? chips.map((c) => `<span class="filter-chip">${esc(c)}</span>`).join("")
      : `<span class="filter-chip filter-chip-muted">Nessun filtro attivo</span>`;
  }

  /* ---- vista compatta ---- */
  function applyViewMode() {
    galleryEl.classList.toggle("grid-compact", state.compact);
  }

  /* ---- tabella metadati nel pannello dettaglio ---- */
  function renderMetadataTable(metadata) {
    if (!metadata || typeof metadata !== "object") return "";
    const allKeys = Object.keys(metadata).filter(
      (k) => metadata[k] !== null && metadata[k] !== undefined && String(metadata[k]).trim() !== ""
    );
    if (!allKeys.length) return "";
    const primary = [
      "Make", "Model", "CameraID", "LensModel",
      "CreateDate", "DateTimeOriginal",
      "ISO", "FNumber", "ExposureTime",
      "Duration", "ImageWidth", "ImageHeight",
      "FileType", "MIMEType",
    ];
    const sorted = [
      ...primary.filter((k) => Object.prototype.hasOwnProperty.call(metadata, k)),
      ...allKeys.filter((k) => !primary.includes(k)).sort((a, b) => a.localeCompare(b)),
    ];
    const rows = sorted.map(
      (k) => `<tr><th>${esc(k)}</th><td>${esc(String(metadata[k]))}</td></tr>`
    );
    return `<table class="meta-table"><tbody>${rows.join("")}</tbody></table>`;
  }

  /* ---- galleria ---- */
  function renderGallery(items) {
    currentItems = items || [];
    galleryEl.innerHTML = "";
    applyViewMode();

    if (!currentItems.length) {
      emptyStateEl.classList.remove("hidden");
      return;
    }
    emptyStateEl.classList.add("hidden");

    const fragment = document.createDocumentFragment();
    currentItems.forEach((item) => {
      const card = document.createElement("article");
      card.className = "card";
      card.dataset.id = item.id;
      if (item.id === currentSelectedId) card.classList.add("card-selected");

      let thumb;
      if (item.media_kind === "video") {
        thumb = document.createElement("video");
        thumb.className    = "card-thumb";
        thumb.preload      = "metadata";
        thumb.muted        = true;
        thumb.playsInline  = true;
        thumb.src          = item.thumb_url || item.file_url;
      } else {
        thumb = document.createElement("img");
        thumb.className = "card-thumb";
        thumb.loading   = "lazy";
        thumb.decoding  = "async";
        thumb.src       = item.thumb_url || item.file_url;
        thumb.alt       = item.filename || "Media";
      }

      const body = document.createElement("div");
      body.className = "card-body";

      if (state.showFolder) {
        const folder = item.parent_folder ||
          (item.relative_path && item.relative_path.includes("/")
            ? item.relative_path.split("/").slice(0, -1).join("/")
            : "");
        if (folder) {
          const folderEl = document.createElement("div");
          folderEl.className   = "card-folder";
          folderEl.textContent = folder;
          body.appendChild(folderEl);
        }
      }

      const title = document.createElement("h2");
      title.className   = "card-title";
      title.textContent = item.filename || "Senza nome";

      const metaRow = document.createElement("div");
      metaRow.className = "card-meta-row";
      const left  = [item.media_kind, item.extension ? `.${item.extension}` : ""].filter(Boolean).join(" · ");
      const right = item.size_bytes != null ? formatSize(item.size_bytes) : "";
      metaRow.innerHTML = `<span>${esc(left)}</span><span>${esc(right)}</span>`;

      const desc = document.createElement("p");
      desc.className   = "card-desc";
      desc.textContent = item.description || "";

      body.appendChild(title);
      body.appendChild(metaRow);
      body.appendChild(desc);
      card.appendChild(thumb);
      card.appendChild(body);

      card.addEventListener("click", () => openDetail(item.id));
      fragment.appendChild(card);
    });
    galleryEl.appendChild(fragment);
  }

  /* ---- pannello dettaglio ---- */
  async function openDetail(id) {
    currentSelectedId = id;
    galleryEl.querySelectorAll(".card").forEach(
      (c) => c.classList.toggle("card-selected", Number(c.dataset.id) === Number(id))
    );
    detailContentEl.innerHTML = `<p class="placeholder">Caricamento...</p>`;

    try {
      const data = await fetchJSON(`/media/${id}`);

      const chips = [];
      if (data.model)       chips.push(`Modello AI: ${esc(data.model)}`);
      if (data.language)    chips.push(`Lingua: ${esc(data.language)}`);
      if (data.media_kind)  chips.push(`Tipo: ${esc(data.media_kind)}`);
      if (data.extension)   chips.push(`Ext: .${esc(data.extension)}`);
      if (data.size_bytes != null) chips.push(`Peso: ${esc(formatSize(data.size_bytes))}`);
      if (data.mtime)       chips.push(`Data file: ${esc(formatTimestamp(data.mtime))}`);
      if (data.parent_folder) chips.push(`Cartella: ${esc(data.parent_folder)}`);

      const metaTable = renderMetadataTable(data.metadata);

      const mediaTag = data.media_kind === "video"
        ? `<video class="detail-image" src="${esc(data.file_url)}" controls preload="metadata"></video>`
        : `<img class="detail-image" src="${esc(data.file_url)}" alt="${esc(data.filename || "Media")}" loading="eager" />`;

      detailContentEl.innerHTML = `
        ${mediaTag}
        <h2 class="detail-title">${esc(data.title || data.filename || "Dettaglio")}</h2>
        ${data.relative_path ? `<p class="detail-path">${esc(data.relative_path)}</p>` : ""}
        ${chips.length ? `<div class="chip-row">${chips.map((c) => `<span class="chip">${c}</span>`).join("")}</div>` : ""}
        <h3 class="detail-section-title">Descrizione AI</h3>
        <p class="detail-description">${esc(data.description || "Nessuna descrizione disponibile.")}</p>
        <h3 class="detail-section-title">Info file</h3>
        <table class="meta-table"><tbody>
          <tr><th>Nome</th><td>${esc(data.filename || "")}</td></tr>
          <tr><th>Estensione</th><td>${esc(data.extension || "")}</td></tr>
          <tr><th>Cartella padre</th><td>${esc(data.parent_folder || "")}</td></tr>
          <tr><th>Percorso relativo</th><td>${esc(data.relative_path || "")}</td></tr>
          <tr><th>Peso</th><td>${esc(formatSize(data.size_bytes) || "")}</td></tr>
          <tr><th>Data file</th><td>${esc(formatTimestamp(data.mtime) || "")}</td></tr>
          <tr><th>SHA256</th><td class="sha256-cell">${esc(data.sha256 || "")}</td></tr>
        </tbody></table>
        ${metaTable ? `<h3 class="detail-section-title">Metadati EXIF</h3>${metaTable}` : ""}
      `;
    } catch (err) {
      console.error(err);
      detailContentEl.innerHTML = `<p class="placeholder">Errore nel caricamento dei dettagli.</p>`;
    }
  }

  /* ---- caricamento select filtri ---- */
  async function loadFilterOptions() {
    try {
      const payload = await fetchJSON("/filters");

      function fillSelect(el, values, emptyLabel) {
        const cur = el.value;
        el.innerHTML = "";
        const opt0 = document.createElement("option");
        opt0.value = ""; opt0.textContent = emptyLabel;
        el.appendChild(opt0);
        (values || []).forEach((v) => {
          const opt = document.createElement("option");
          opt.value = v; opt.textContent = v;
          if (v === cur) opt.selected = true;
          el.appendChild(opt);
        });
      }

      fillSelect(filterMediaKindEl, payload.media_kind, "Tutti");
      fillSelect(filterExtEl,       payload.extension,  "Tutte");
      fillSelect(filterMakeEl,      payload.make,       "Tutte");
      fillSelect(filterModelEl,     payload.model,      "Tutti");
      fillSelect(filterCameraIdEl,  payload.camera_id,  "Tutti");
      fillSelect(filterLensModelEl, payload.lens_model, "Tutti");
      fillSelect(filterAiModelEl,   payload.ai_model,   "Tutti");
      fillSelect(filterFolderEl,    payload.folder,     "Tutte");

      if (Array.isArray(payload.sort) && payload.sort.length) {
        const cur = state.sort;
        sortSelectEl.innerHTML = "";
        payload.sort.forEach((item) => {
          const opt = document.createElement("option");
          opt.value = item.value; opt.textContent = item.label;
          if (item.value === cur) opt.selected = true;
          sortSelectEl.appendChild(opt);
        });
      }
    } catch (err) {
      console.error("Errore caricamento filtri:", err);
    }
  }

  /* ---- caricamento media ---- */
  async function loadMedia(page = 1) {
    state.page = page;
    try {
      const payload = await fetchJSON(buildMediaUrl());
      const items = payload.items || [];

      currentItems      = items;
      currentPage       = payload.page || page;
      currentTotal      = payload.total || 0;
      currentTotalPages = payload.total_pages || Math.max(1, Math.ceil(currentTotal / PAGE_LIMIT));

      renderGallery(items);
      renderResultsSummary();
      renderActiveFilters();
      updatePaginationUI();

      if (items.length > 0) {
        const keepId = currentSelectedId && items.some((x) => x.id === currentSelectedId)
          ? currentSelectedId
          : items[0].id;
        openDetail(keepId);
      } else {
        currentSelectedId = null;
        detailContentEl.innerHTML =
          `<p class="placeholder">Nessun elemento con i filtri correnti.</p>`;
      }
    } catch (err) {
      console.error(err);
      emptyStateEl.classList.remove("hidden");
      emptyStateEl.textContent =
        "Errore di caricamento. Verifica che il backend sia in esecuzione.";
      resultsSummaryEl.textContent = "Errore";
      pageInfoEl.textContent = "– / –";
    }
  }

  /* ---- sync stato dai controlli ---- */
  function syncState() {
    state.q         = searchInput.value.trim();
    state.mediaKind = filterMediaKindEl.value;
    state.ext       = filterExtEl.value;
    state.make      = filterMakeEl.value;
    state.model     = filterModelEl.value;
    state.cameraId  = filterCameraIdEl.value;
    state.lensModel = filterLensModelEl.value;
    state.aiModel   = filterAiModelEl.value;
    state.folder    = filterFolderEl.value;
    state.sort      = sortSelectEl.value;
    state.showFolder = toggleShowFolderEl.checked;
    state.compact    = toggleCompactEl.checked;
  }

  function resetControls() {
    searchInput.value = "";
    filterMediaKindEl.value = "";
    filterExtEl.value       = "";
    filterMakeEl.value      = "";
    filterModelEl.value     = "";
    filterCameraIdEl.value  = "";
    filterLensModelEl.value = "";
    filterAiModelEl.value   = "";
    filterFolderEl.value    = "";
    sortSelectEl.value      = "created_desc";
    toggleShowFolderEl.checked = false;
    toggleCompactEl.checked    = false;
    syncState();
  }

  /* ---- eventi ---- */
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    syncState();
    loadMedia(1);
  });

  clearSearchBtn.addEventListener("click", () => {
    resetControls();
    loadMedia(1);
  });

  [
    filterMediaKindEl, filterExtEl, filterMakeEl,
    filterModelEl, filterCameraIdEl, filterLensModelEl,
    filterAiModelEl, filterFolderEl, sortSelectEl,
  ].forEach((el) => el.addEventListener("change", () => { syncState(); loadMedia(1); }));

  toggleShowFolderEl.addEventListener("change", () => { syncState(); renderGallery(currentItems); });
  toggleCompactEl.addEventListener("change",    () => { syncState(); applyViewMode(); renderGallery(currentItems); });

  firstPageBtn.addEventListener("click", () => { if (currentPage > 1) loadMedia(1); });
  prevPageBtn.addEventListener("click",  () => { if (currentPage > 1) loadMedia(currentPage - 1); });
  nextPageBtn.addEventListener("click",  () => { if (currentPage < currentTotalPages) loadMedia(currentPage + 1); });
  lastPageBtn.addEventListener("click",  () => { if (currentPage < currentTotalPages) loadMedia(currentTotalPages); });

  /* ---- init ---- */
  (async function init() {
    await loadFilterOptions();
    syncState();
    await loadMedia(1);
  })();
})();
