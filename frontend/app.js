"use strict";
(function () {

  /* ── DOM refs ─────────────────────────────────── */
  const gallery        = document.getElementById("gallery");
  const emptyState     = document.getElementById("empty-state");
  const detailContent  = document.getElementById("detail-content");
  const detailPane     = document.getElementById("detail-pane");
  const detailClose    = document.getElementById("detail-close");

  const searchForm     = document.getElementById("search-form");
  const searchInput    = document.getElementById("search-input");
  const clearBtn       = document.getElementById("clear-btn");

  const toggleFiltersBtn = document.getElementById("toggle-filters-btn");
  const filterPanel    = document.getElementById("filter-panel");
  const filterBadge    = document.getElementById("filter-badge");
  const activeChips    = document.getElementById("active-chips");

  const selMediaKind   = document.getElementById("filter-media-kind");
  const selExt         = document.getElementById("filter-ext");
  const selMake        = document.getElementById("filter-make");
  const selModel       = document.getElementById("filter-model");
  const selCameraId    = document.getElementById("filter-camera-id");
  const selLensModel   = document.getElementById("filter-lens-model");
  const selAiModel     = document.getElementById("filter-ai-model");
  const selFolder      = document.getElementById("filter-folder");
  const selSort        = document.getElementById("sort-select");

  const chkFolder      = document.getElementById("toggle-folder");
  const chkCompact     = document.getElementById("toggle-compact");
  const chkGroupFolder = document.getElementById("toggle-group-folder");

  const resultsText    = document.getElementById("results-text");
  const pageInfo       = document.getElementById("page-info");
  const pageLabel      = document.getElementById("page-label");

  const btnFirst       = document.getElementById("btn-first");
  const btnPrev        = document.getElementById("btn-prev");
  const btnNext        = document.getElementById("btn-next");
  const btnLast        = document.getElementById("btn-last");

  const btnViewAlbums  = document.getElementById("btn-view-albums");
  const btnViewAll     = document.getElementById("btn-view-all");
  const albumBreadcrumb = document.getElementById("album-breadcrumb");
  const albumBreadcrumbLabel = document.getElementById("album-breadcrumb-label");
  const btnAlbumBack   = document.getElementById("btn-album-back");
  const paginationEl   = document.querySelector(".pagination");

  /* ── State ────────────────────────────────────── */
  const PAGE_LIMIT = 100;
  const ALBUM_ROTATE_MS = 3500;

  let viewMode = "all";

  const state = {
    q:          "",
    page:       1,
    mediaKind:  "",
    ext:        "",
    make:       "",
    model:      "",
    cameraId:   "",
    lensModel:  "",
    aiModel:    "",
    folder:     "",
    sort:       "created_desc",
    showFolder: false,
    compact:    false,
    groupFolder:false,
  };

  let currentItems      = [];
  let currentTotal      = 0;
  let currentTotalPages = 1;
  let currentPage       = 1;
  let selectedId        = null;

  const albumRotationTimers = new Set();

  /* ── Utils ────────────────────────────────────── */
  const esc = s => String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

  function fmtSize(bytes) {
    if (bytes == null || isNaN(+bytes)) return "";
    const u = ["B","KB","MB","GB","TB"];
    let v = +bytes, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  function fmtTs(ts) {
    if (!ts) return "";
    const d = new Date(+ts * 1000);
    return isNaN(d) ? "" : d.toLocaleString("it-IT");
  }

  async function api(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function clearAlbumRotations() {
    for (const timer of albumRotationTimers) clearInterval(timer);
    albumRotationTimers.clear();
  }

  function setViewMode(mode) {
    viewMode = mode;
    const isAlbums = mode === "albums";
    const isAlbumDetail = mode === "album-detail";
    const isAll = mode === "all";

    btnViewAlbums.classList.toggle("active", isAlbums || isAlbumDetail);
    btnViewAlbums.setAttribute("aria-pressed", String(isAlbums || isAlbumDetail));

    btnViewAll.classList.toggle("active", isAll);
    btnViewAll.setAttribute("aria-pressed", String(isAll));

    albumBreadcrumb.classList.toggle("hidden", !isAlbumDetail);

    document.querySelector(".search-wrap").style.display = isAlbums ? "none" : "";
    toggleFiltersBtn.style.display = isAlbums ? "none" : "";

    paginationEl.classList.toggle("hidden", isAlbums);
    detailPane.classList.toggle("albums-hidden", isAlbums);

    if (!isAlbums) clearAlbumRotations();
  }

  /* ── Filter panel toggle ──────────────────────── */
  toggleFiltersBtn.addEventListener("click", () => {
    const open = filterPanel.classList.toggle("open");
    toggleFiltersBtn.setAttribute("aria-expanded", String(open));
  });

  /* ── Populate selects from /filters ──────────── */
  function fillSelect(el, values, emptyLabel) {
    const prev = el.value;
    el.innerHTML = `<option value="">${emptyLabel}</option>`;
    (values || []).forEach(v => {
      const o = document.createElement("option");
      o.value = v; o.textContent = v;
      if (v === prev) o.selected = true;
      el.appendChild(o);
    });
  }

  async function loadFilters() {
    try {
      const d = await api("/filters");
      fillSelect(selMediaKind, d.media_kind,  "Tutti");
      fillSelect(selExt,       d.extension,   "Tutte");
      fillSelect(selMake,      d.make,        "Tutte");
      fillSelect(selModel,     d.model,       "Tutti");
      fillSelect(selCameraId,  d.camera_id,   "Tutti");
      fillSelect(selLensModel, d.lens_model,  "Tutti");
      fillSelect(selAiModel,   d.ai_model,    "Tutti");
      fillSelect(selFolder,    d.folder,      "Tutte");
      if (Array.isArray(d.sort) && d.sort.length) {
        const prev = selSort.value;
        selSort.innerHTML = "";
        d.sort.forEach(s => {
          const o = document.createElement("option");
          o.value = s.value; o.textContent = s.label;
          if (s.value === prev || s.value === state.sort) o.selected = true;
          selSort.appendChild(o);
        });
      }
    } catch (e) {
      console.warn("loadFilters error:", e);
    }
  }

  /* ── Sync state ───────────────────────────────── */
  function syncFromUI() {
    state.q          = searchInput.value.trim();
    state.mediaKind  = selMediaKind.value;
    state.ext        = selExt.value;
    state.make       = selMake.value;
    state.model      = selModel.value;
    state.cameraId   = selCameraId.value;
    state.lensModel  = selLensModel.value;
    state.aiModel    = selAiModel.value;
    state.folder     = selFolder.value;
    state.sort       = selSort.value;
    state.showFolder = chkFolder.checked;
    state.compact    = chkCompact.checked;
    state.groupFolder= chkGroupFolder.checked;
  }

  function resetState() {
    searchInput.value  = "";
    selMediaKind.value = ""; selExt.value      = "";
    selMake.value      = ""; selModel.value    = "";
    selCameraId.value  = ""; selLensModel.value= "";
    selAiModel.value   = ""; selFolder.value   = "";
    selSort.value      = "created_desc";
    chkFolder.checked  = false; chkCompact.checked = false; chkGroupFolder.checked = false;
    syncFromUI();
  }

  /* ── Active chips & badge ─────────────────────── */
  const FILTER_LABELS = {
    q: "Testo", mediaKind: "Tipo", ext: "Ext", make: "Make",
    model: "Model", cameraId: "CameraID", lensModel: "Lens",
    aiModel: "AI", folder: "Cartella",
  };

  function renderChips() {
    const keys = ["q","mediaKind","ext","make","model","cameraId","lensModel","aiModel","folder"];
    const active = keys.filter(k => state[k]);
    filterBadge.textContent = active.length;
    filterBadge.classList.toggle("hidden", active.length === 0);

    if (!active.length) {
      activeChips.innerHTML = `<span class="chip chip-none">Nessun filtro attivo</span>`;
      return;
    }
    activeChips.innerHTML = active.map(k =>
      `<span class="chip">${esc(FILTER_LABELS[k])}: ${esc(state[k])}</span>`
    ).join("");
  }

  /* ── Build URL ────────────────────────────────── */
  function buildUrl() {
    const p = new URLSearchParams();
    p.set("page",  String(state.page));
    p.set("limit", String(PAGE_LIMIT));
    p.set("sort",  state.sort);
    if (state.q)          p.set("q",           state.q);
    if (state.mediaKind)  p.set("media_kind",  state.mediaKind);
    if (state.ext)        p.set("ext",         state.ext);
    if (state.make)       p.set("make",        state.make);
    if (state.model)      p.set("model",       state.model);
    if (state.cameraId)   p.set("camera_id",   state.cameraId);
    if (state.lensModel)  p.set("lens_model",  state.lensModel);
    if (state.aiModel)    p.set("ai_model",    state.aiModel);
    if (state.folder)     p.set("folder",      state.folder);
    return `/media?${p}`;
  }

  /* ── Render media card ───────────────────────── */
  function makeCard(item) {
    const card = document.createElement("article");
    card.className = "card" + (item.id === selectedId ? " selected" : "");
    card.dataset.id = item.id;

    const isVideo = item.media_kind === "video";
    const thumb   = item.thumb_url || item.file_url;

    let thumbTag;
    if (isVideo) {
      thumbTag = `<video class="card-thumb" src="${esc(thumb)}" preload="metadata" muted playsinline></video>`;
    } else {
      thumbTag = `<img class="card-thumb" src="${esc(thumb)}" alt="${esc(item.filename)}" loading="lazy" decoding="async">`;
    }

    const badgeHTML = isVideo
      ? `<span class="card-badge badge-video">VIDEO</span>`
      : `<span class="card-badge">${esc(item.extension || "").toUpperCase()}</span>`;

    const folderHTML = state.showFolder && item.parent_folder
      ? `<div class="card-folder">📁 ${esc(item.parent_folder)}</div>`
      : "";

    card.innerHTML = `
      <div class="card-thumb-wrap">
        ${thumbTag}
        ${badgeHTML}
      </div>
      <div class="card-body">
        ${folderHTML}
        <div class="card-name" title="${esc(item.filename)}">${esc(item.filename)}</div>
        <div class="card-meta">
          <span>${esc(item.media_kind || "")}</span>
          <span>${esc(fmtSize(item.size_bytes))}</span>
        </div>
        ${item.description ? `<div class="card-desc">${esc(item.description)}</div>` : ""}
      </div>`;

    card.addEventListener("click", () => openDetail(item.id));
    return card;
  }

  /* ── Album rotation ───────────────────────────── */
  function startAlbumRotation(card, thumbs) {
    if (!Array.isArray(thumbs) || thumbs.length <= 1) return;

    const img = card.querySelector(".album-rotating-thumb");
    if (!img) return;

    let idx = 0;

    const timer = setInterval(() => {
      if (!document.body.contains(card)) {
        clearInterval(timer);
        albumRotationTimers.delete(timer);
        return;
      }

      const nextIdx = (idx + 1) % thumbs.length;
      const nextUrl = thumbs[nextIdx];

      const preload = new Image();
      preload.onload = () => {
        img.classList.add("is-fading");
        setTimeout(() => {
          img.src = nextUrl;
          img.classList.remove("is-fading");
          idx = nextIdx;
        }, 180);
      };
      preload.src = nextUrl;
    }, ALBUM_ROTATE_MS + Math.floor(Math.random() * 1200));

    albumRotationTimers.add(timer);
  }

  /* ── Render album card ────────────────────────── */
  function makeAlbumCard(album) {
    const card = document.createElement("article");
    card.className = "album-card";

    const folderName = album.folder === "(radice)" ? "/ (radice)" : album.folder.split("/").pop();
    const folderPath = album.folder === "(radice)" ? "" : album.folder;
    const thumbs     = Array.isArray(album.thumbs) ? album.thumbs.filter(Boolean) : [];
    const firstThumb = thumbs[0] || "";
    const dateStr    = album.last_mtime ? fmtTs(album.last_mtime) : "";
    const subfolderParts = album.folder.split("/");
    const parentPath = subfolderParts.length > 1
      ? subfolderParts.slice(0, -1).join(" / ")
      : "";

    card.innerHTML = `
      <div class="album-cover">
        ${firstThumb
          ? `<img class="album-rotating-thumb" src="${esc(firstThumb)}" alt="${esc(folderName)}" loading="lazy" decoding="async">`
          : `<div class="album-cover-placeholder"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>`
        }
        <div class="album-overlay">
          <span class="album-count">${album.count} elementi</span>
        </div>
      </div>
      <div class="album-body">
        <div class="album-name" title="${esc(album.folder)}">${esc(folderName)}</div>
        ${parentPath ? `<div class="album-path">${esc(parentPath)}</div>` : ""}
        ${dateStr ? `<div class="album-date">${esc(dateStr)}</div>` : ""}
      </div>`;

    card.addEventListener("click", () => openAlbum(folderPath, folderName));
    startAlbumRotation(card, thumbs);
    return card;
  }

  /* ── Open album ───────────────────────────────── */
  function openAlbum(folderPath, folderName) {
    state.folder = folderPath;
    if (selFolder) selFolder.value = folderPath;
    if (albumBreadcrumbLabel) albumBreadcrumbLabel.textContent = folderName || folderPath || "radice";
    setViewMode("album-detail");
    syncFromUI();
    loadMedia(1);
  }

  /* ── Load albums view ─────────────────────────── */
  async function loadAlbums() {
    clearAlbumRotations();
    setViewMode("albums");
    gallery.innerHTML = "";
    gallery.className = "albums-grid";
    emptyState.classList.add("hidden");
    resultsText.textContent = "Caricamento album…";
    detailPane.classList.remove("open");

    try {
      const albums = await api("/albums");
      resultsText.textContent = `${albums.length} album`;

      if (!albums.length) {
        emptyState.classList.remove("hidden");
        emptyState.textContent = "Nessun album trovato.";
        gallery.appendChild(emptyState);
        return;
      }

      const frag = document.createDocumentFragment();
      albums.forEach(a => frag.appendChild(makeAlbumCard(a)));
      gallery.appendChild(frag);
    } catch (err) {
      console.error(err);
      resultsText.textContent = "Errore caricamento album";
    }
  }

  /* ── Render gallery ───────────────────────────── */
  function renderGallery(items) {
    gallery.innerHTML = "";
    gallery.className = "gallery-grid" + (state.compact ? " compact" : "");
    emptyState.classList.toggle("hidden", items.length > 0);

    if (!items.length) {
      gallery.appendChild(emptyState);
      return;
    }

    if (state.groupFolder) {
      const groups = new Map();
      items.forEach(item => {
        const g = item.parent_folder || "(radice)";
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(item);
      });

      groups.forEach((groupItems, folderName) => {
        const section = document.createElement("div");
        section.className = "folder-group";
        section.innerHTML = `
          <div class="folder-group-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            ${esc(folderName)} <span style="color:var(--text-faint);font-weight:400;">(${groupItems.length})</span>
          </div>
          <div class="folder-group-grid"></div>`;
        const grid = section.querySelector(".folder-group-grid");
        groupItems.forEach(item => grid.appendChild(makeCard(item)));
        gallery.appendChild(section);
      });
    } else {
      const frag = document.createDocumentFragment();
      items.forEach(item => frag.appendChild(makeCard(item)));
      gallery.appendChild(frag);
    }
  }

  /* ── Pagination UI ────────────────────────────── */
  function updatePagination() {
    const tp = currentTotalPages;
    const cp = currentPage;
    const from = currentTotal === 0 ? 0 : (cp - 1) * PAGE_LIMIT + 1;
    const to   = Math.min(cp * PAGE_LIMIT, currentTotal);

    resultsText.textContent = `${currentTotal} elementi — ${from}-${to}`;
    pageInfo.textContent    = `Pagina ${cp} / ${tp}`;
    pageLabel.textContent   = `${cp} / ${tp}`;

    btnFirst.disabled = cp <= 1;
    btnPrev.disabled  = cp <= 1;
    btnNext.disabled  = cp >= tp;
    btnLast.disabled  = cp >= tp;
  }

  /* ── Load media ───────────────────────────────── */
  async function loadMedia(page = 1) {
    clearAlbumRotations();
    state.page = page;
    renderChips();

    try {
      const data = await api(buildUrl());
      currentItems      = data.items || [];
      currentPage       = data.page  || page;
      currentTotal      = data.total || 0;
      currentTotalPages = data.total_pages || Math.max(1, Math.ceil(currentTotal / PAGE_LIMIT));

      renderGallery(currentItems);
      updatePagination();

      if (currentItems.length) {
        const keep = selectedId && currentItems.some(x => x.id === selectedId);
        openDetail(keep ? selectedId : currentItems[0].id);
      } else {
        selectedId = null;
        detailContent.innerHTML = `<div class="detail-placeholder"><p>Nessun elemento trovato.</p></div>`;
      }
    } catch (err) {
      console.error(err);
      resultsText.textContent = "Errore di caricamento";
      detailContent.innerHTML = `<div class="detail-placeholder"><p>Errore: ${esc(err.message)}</p></div>`;
    }
  }

  /* ── Open detail ──────────────────────────────── */
  async function openDetail(id) {
    selectedId = id;
    document.querySelectorAll(".card").forEach(c => {
      c.classList.toggle("selected", +c.dataset.id === +id);
    });

    detailPane.classList.add("open");
    detailContent.innerHTML = `<div class="detail-placeholder"><p>Caricamento…</p></div>`;

    try {
      const d = await api(`/media/${id}`);

      const chips = [
        d.media_kind && `Tipo: ${d.media_kind}`,
        d.extension  && `Ext: .${d.extension}`,
        d.size_bytes != null && `Peso: ${fmtSize(d.size_bytes)}`,
        d.mtime      && `Data: ${fmtTs(d.mtime)}`,
        d.model      && `AI: ${d.model}`,
        d.language   && `Lingua: ${d.language}`,
        d.parent_folder && `📁 ${d.parent_folder}`,
      ].filter(Boolean);

      const metaRows = [
        ["Nome",       d.filename],
        ["Estensione", d.extension],
        ["Cartella",   d.parent_folder],
        ["Percorso",   d.relative_path],
        ["Peso",       fmtSize(d.size_bytes)],
        ["Data file",  fmtTs(d.mtime)],
        ["SHA256",     d.sha256],
      ].filter(r => r[1]).map(r =>
        `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`
      ).join("");

      const exifKeys = ["Make","Model","CameraID","LensModel","CreateDate","DateTimeOriginal",
                        "ISO","FNumber","ExposureTime","ImageWidth","ImageHeight"];
      const meta = d.metadata || {};
      const allMetaKeys = [...new Set([...exifKeys, ...Object.keys(meta)])].filter(k => meta[k] != null && String(meta[k]).trim());
      const metaExifRows = allMetaKeys.map(k =>
        `<tr><th>${esc(k)}</th><td>${esc(String(meta[k]))}</td></tr>`
      ).join("");

      const mediaTag = d.media_kind === "video"
        ? `<video src="${esc(d.file_url)}" controls preload="metadata" style="width:100%;height:100%;object-fit:contain;"></video>`
        : `<img src="${esc(d.file_url)}" alt="${esc(d.filename)}" loading="eager" style="width:100%;height:100%;object-fit:contain;">`;

      detailContent.innerHTML = `
        <div class="d-media">${mediaTag}</div>
        <div class="d-title">${esc(d.title || d.filename)}</div>
        ${d.relative_path ? `<div class="d-path">${esc(d.relative_path)}</div>` : ""}
        <div class="d-chips">${chips.map(c => `<span class="d-chip">${esc(c)}</span>`).join("")}</div>
        ${d.description ? `
          <div class="d-section">Descrizione AI</div>
          <p class="d-desc">${esc(d.description)}</p>` : ""}
        <div class="d-section">Info file</div>
        <table class="d-table"><tbody>${metaRows}</tbody></table>
        ${metaExifRows ? `
          <div class="d-section">Metadati EXIF</div>
          <table class="d-table"><tbody>${metaExifRows}</tbody></table>` : ""}
      `;
    } catch (e) {
      detailContent.innerHTML = `<div class="detail-placeholder"><p>Errore: ${esc(e.message)}</p></div>`;
    }
  }

  /* ── Events ───────────────────────────────────── */
  searchForm.addEventListener("submit", e => {
    e.preventDefault();
    if (viewMode === "albums") return;
    if (viewMode === "album-detail") setViewMode("all");
    syncFromUI();
    loadMedia(1);
  });

  clearBtn.addEventListener("click", () => {
    resetState();
    if (viewMode === "albums") return;
    loadMedia(1);
  });

  [selMediaKind, selExt, selMake, selModel, selCameraId,
   selLensModel, selAiModel, selFolder, selSort].forEach(el => {
    el.addEventListener("change", () => {
      if (viewMode === "albums") return;
      syncFromUI();
      loadMedia(1);
    });
  });

  [chkFolder, chkCompact, chkGroupFolder].forEach(el => {
    el.addEventListener("change", () => {
      syncFromUI();
      if (viewMode !== "albums") renderGallery(currentItems);
    });
  });

  btnFirst.addEventListener("click", () => loadMedia(1));
  btnPrev.addEventListener("click",  () => loadMedia(currentPage - 1));
  btnNext.addEventListener("click",  () => loadMedia(currentPage + 1));
  btnLast.addEventListener("click",  () => loadMedia(currentTotalPages));

  detailClose.addEventListener("click", () => {
    detailPane.classList.remove("open");
  });

  btnViewAlbums.addEventListener("click", () => {
    loadAlbums();
  });

  btnViewAll.addEventListener("click", () => {
    state.folder = "";
    if (selFolder) selFolder.value = "";
    setViewMode("all");
    syncFromUI();
    loadMedia(1);
  });

  if (btnAlbumBack) {
    btnAlbumBack.addEventListener("click", () => {
      loadAlbums();
    });
  }

  /* ── Init ─────────────────────────────────────── */
  async function init() {
    await loadFilters();
    syncFromUI();
    await loadMedia(1);
  }

  init();

})();