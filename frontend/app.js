"use strict";
(function () {
  const mainLayout       = document.querySelector(".main-layout");
  const gallery          = document.getElementById("gallery");
  const emptyState       = document.getElementById("empty-state");
  const detailContent    = document.getElementById("detail-content");
  const detailPane       = document.getElementById("detail-pane");
  const detailClose      = document.getElementById("detail-close");

  const searchForm       = document.getElementById("search-form");
  const searchInput      = document.getElementById("search-input");
  const clearBtn         = document.getElementById("clear-btn");
  const resetFiltersBtn  = document.getElementById("reset-filters-btn");

  const toggleFiltersBtn = document.getElementById("toggle-filters-btn");
  const filterPanel      = document.getElementById("filter-panel");
  const filterBadge      = document.getElementById("filter-badge");
  const activeChips      = document.getElementById("active-chips");
  const searchWrap       = document.querySelector(".topbar-search-wrap");

  const selMediaKind     = document.getElementById("filter-media-kind");
  const selExt           = document.getElementById("filter-ext");
  const selMake          = document.getElementById("filter-make");
  const selModel         = document.getElementById("filter-model");
  const selCameraId      = document.getElementById("filter-camera-id");
  const selLensModel     = document.getElementById("filter-lens-model");
  const selAiModel       = document.getElementById("filter-ai-model");
  const selFolder        = document.getElementById("filter-folder");
  const selSort          = document.getElementById("sort-select");

  const chkFolder        = document.getElementById("toggle-folder");
  const chkCompact       = document.getElementById("toggle-compact");
  const chkGroupFolder   = document.getElementById("toggle-group-folder");

  const resultsText      = document.getElementById("results-text");
  const pageInfo         = document.getElementById("page-info");
  const pageLabel        = document.getElementById("page-label");
  const paginationEl     = document.querySelector(".pagination");

  const btnViewAlbums    = document.getElementById("btn-view-albums");
  const btnViewAll       = document.getElementById("btn-view-all");
  const albumBreadcrumb  = document.getElementById("album-breadcrumb");
  const albumBreadcrumbLabel = document.getElementById("album-breadcrumb-label");
  const btnAlbumBack     = document.getElementById("btn-album-back");

  const PAGE_LIMIT = 100;
  const ALBUM_ROTATE_MS = 3500;
  const MOBILE_BP = 900;

  let viewMode = "all";
  let selectedId = null;
  let currentTotal = 0;
  let currentTotalPages = 1;
  let currentPage = 0;
  let currentItems = [];
  let isLoading = false;
  let hasMore = true;
  let currentQueryToken = 0;
  let currentDetailToken = 0;
  let infiniteObserver = null;
  let sentinelEl = null;
  let detailBackdrop = null;

  const mobileMQ = window.matchMedia(`(max-width: ${MOBILE_BP}px)`);

  const folderGroupStates = new Map();
  const albumRotationTimers = new Set();

  const state = {
    q: "",
    page: 1,
    mediaKind: "",
    ext: "",
    make: "",
    model: "",
    cameraId: "",
    lensModel: "",
    aiModel: "",
    folder: "",
    sort: "created_desc",
    showFolder: false,
    compact: false,
    groupFolder: false,
  };

  const esc = s => String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  function isMobileViewport() {
    return mobileMQ.matches;
  }

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

  function ensureDetailBackdrop() {
    if (detailBackdrop) return;
    detailBackdrop = document.createElement("div");
    detailBackdrop.className = "detail-backdrop";
    document.body.appendChild(detailBackdrop);
    detailBackdrop.addEventListener("click", () => closeDetailPane(true));
  }

  function updateSelectedCards() {
    document.querySelectorAll(".card, .group-album-tile").forEach(c => {
      c.classList.toggle("selected", +c.dataset.id === +selectedId);
    });
  }

  function setDetailOpen(open) {
    mainLayout?.classList.toggle("has-open-detail", open && !isMobileViewport());
    detailPane.classList.toggle("open", open);

    if (isMobileViewport()) {
      ensureDetailBackdrop();
      detailBackdrop.classList.toggle("open", open);
      document.body.classList.toggle("detail-open-mobile", open);
    } else {
      document.body.classList.remove("detail-open-mobile");
      if (detailBackdrop) detailBackdrop.classList.remove("open");
    }
  }

  function closeDetailPane(clearSelection = false) {
    setDetailOpen(false);
    if (clearSelection) {
      selectedId = null;
      updateSelectedCards();
    }
  }

  function clearAlbumRotations() {
    for (const timer of albumRotationTimers) clearInterval(timer);
    albumRotationTimers.clear();
  }

  function destroyInfiniteScroll() {
    if (infiniteObserver) {
      infiniteObserver.disconnect();
      infiniteObserver = null;
    }
    if (sentinelEl && sentinelEl.parentNode) sentinelEl.parentNode.removeChild(sentinelEl);
    sentinelEl = null;
  }

  function ensureSentinel() {
    destroyInfiniteScroll();
    sentinelEl = document.createElement("div");
    sentinelEl.id = "infinite-scroll-sentinel";
    sentinelEl.className = "infinite-scroll-sentinel";
    sentinelEl.innerHTML = '<span class="loading-more-text">Scorri per caricare altri 100 elementi</span>';
    gallery.after(sentinelEl);

    infiniteObserver = new IntersectionObserver(entries => {
      const entry = entries[0];
      if (!entry || !entry.isIntersecting) return;
      if (viewMode === "albums") return;
      if (state.groupFolder) return;
      if (isLoading || !hasMore) return;
      loadNextPage();
    }, {
      root: null,
      rootMargin: "800px 0px",
      threshold: 0,
    });

    infiniteObserver.observe(sentinelEl);
    updateSentinel();
  }

  function updateSentinel() {
    if (!sentinelEl) return;

    const shouldHide =
      viewMode === "albums" ||
      state.groupFolder ||
      (!currentItems.length && !isLoading) ||
      (!hasMore && currentItems.length > 0);

    sentinelEl.classList.toggle("hidden", shouldHide);
    sentinelEl.classList.toggle("is-loading", isLoading);

    const label = sentinelEl.querySelector(".loading-more-text");
    if (!label) return;

    if (state.groupFolder) {
      label.textContent = "Scroll infinito disattivato con raggruppamento per cartella";
    } else if (isLoading && currentItems.length > 0) {
      label.textContent = "Caricamento altri 100 elementi…";
    } else if (hasMore) {
      label.textContent = "Scorri per caricare altri 100 elementi";
    } else {
      label.textContent = "Hai raggiunto la fine della galleria";
    }
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
    searchWrap.style.display = isAlbums ? "none" : "";
    toggleFiltersBtn.style.display = isAlbums ? "none" : "";

    if (isAlbums) {
      filterPanel.classList.remove("open");
      toggleFiltersBtn.setAttribute("aria-expanded", "false");
      destroyInfiniteScroll();
      closeDetailPane(true);
    } else if (!state.groupFolder) {
      ensureSentinel();
    }

    paginationEl?.classList.add("hidden");
    detailPane.classList.toggle("albums-hidden", isAlbums);

    if (!isAlbums) clearAlbumRotations();
    renderChips();
    updateSentinel();
  }

  toggleFiltersBtn.addEventListener("click", () => {
    const open = filterPanel.classList.toggle("open");
    toggleFiltersBtn.setAttribute("aria-expanded", String(open));
    renderChips();
  });

  function fillSelect(el, values, emptyLabel) {
    const prev = el.value;
    el.innerHTML = `<option value="">${emptyLabel}</option>`;
    (values || []).forEach(v => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      if (v === prev) o.selected = true;
      el.appendChild(o);
    });
  }

  async function loadFilters() {
    try {
      const d = await api("/filters");
      fillSelect(selMediaKind, d.media_kind, "Tutti");
      fillSelect(selExt, d.extension, "Tutte");
      fillSelect(selMake, d.make, "Tutte");
      fillSelect(selModel, d.model, "Tutti");
      fillSelect(selCameraId, d.camera_id, "Tutti");
      fillSelect(selLensModel, d.lens_model, "Tutti");
      fillSelect(selAiModel, d.ai_model, "Tutti");
      fillSelect(selFolder, d.folder, "Tutte");

      if (Array.isArray(d.sort) && d.sort.length) {
        const prev = selSort.value;
        selSort.innerHTML = "";
        d.sort.forEach(s => {
          const o = document.createElement("option");
          o.value = s.value;
          o.textContent = s.label;
          if (s.value === prev || s.value === state.sort) o.selected = true;
          selSort.appendChild(o);
        });
      }
    } catch (e) {
      console.warn("loadFilters error:", e);
    }
  }

  function syncFromUI() {
    state.q = searchInput.value.trim();
    state.mediaKind = selMediaKind.value;
    state.ext = selExt.value;
    state.make = selMake.value;
    state.model = selModel.value;
    state.cameraId = selCameraId.value;
    state.lensModel = selLensModel.value;
    state.aiModel = selAiModel.value;
    state.folder = selFolder.value;
    state.sort = selSort.value;
    state.showFolder = chkFolder.checked;
    state.compact = chkCompact.checked;
    state.groupFolder = chkGroupFolder.checked;
  }

  function resetState() {
    searchInput.value = "";
    selMediaKind.value = "";
    selExt.value = "";
    selMake.value = "";
    selModel.value = "";
    selCameraId.value = "";
    selLensModel.value = "";
    selAiModel.value = "";
    selFolder.value = "";
    selSort.value = "created_desc";
    chkFolder.checked = false;
    chkCompact.checked = false;
    chkGroupFolder.checked = false;
    syncFromUI();
    renderChips();
  }

  const FILTER_LABELS = {
    q: "Testo",
    mediaKind: "Tipo",
    ext: "Ext",
    make: "Marca",
    model: "Modello",
    cameraId: "CameraID",
    lensModel: "Obiettivo",
    aiModel: "AI",
    folder: "Cartella",
  };

  function removeSingleFilter(key) {
    switch (key) {
      case "q": searchInput.value = ""; break;
      case "mediaKind": selMediaKind.value = ""; break;
      case "ext": selExt.value = ""; break;
      case "make": selMake.value = ""; break;
      case "model": selModel.value = ""; break;
      case "cameraId": selCameraId.value = ""; break;
      case "lensModel": selLensModel.value = ""; break;
      case "aiModel": selAiModel.value = ""; break;
      case "folder": selFolder.value = ""; break;
      default: return;
    }
    syncFromUI();
    if (viewMode !== "albums") refreshMedia();
  }

  function renderChips() {
    syncFromUI();
    const keys = ["q","mediaKind","ext","make","model","cameraId","lensModel","aiModel","folder"];
    const active = keys.filter(k => state[k]);

    filterBadge.textContent = active.length;
    filterBadge.classList.toggle("hidden", active.length === 0);
    toggleFiltersBtn.classList.toggle("active", filterPanel.classList.contains("open") || active.length > 0);

    if (!active.length) {
      activeChips.innerHTML = `<span class="chip-empty">Nessun filtro attivo</span>`;
      return;
    }

    activeChips.innerHTML = active.map(k => `
      <span class="chip">
        ${esc(FILTER_LABELS[k])}: ${esc(state[k])}
        <button class="chip-x" data-filter-key="${esc(k)}" type="button" aria-label="Rimuovi filtro ${esc(FILTER_LABELS[k])}">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </span>
    `).join("");

    activeChips.querySelectorAll("[data-filter-key]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        removeSingleFilter(btn.dataset.filterKey);
      });
    });
  }

  function buildUrl(page) {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("limit", String(PAGE_LIMIT));
    p.set("sort", state.sort);
    if (state.q) p.set("q", state.q);
    if (state.mediaKind) p.set("media_kind", state.mediaKind);
    if (state.ext) p.set("ext", state.ext);
    if (state.make) p.set("make", state.make);
    if (state.model) p.set("model", state.model);
    if (state.cameraId) p.set("camera_id", state.cameraId);
    if (state.lensModel) p.set("lens_model", state.lensModel);
    if (state.aiModel) p.set("ai_model", state.aiModel);
    if (state.folder) p.set("folder", state.folder);
    return `/media?${p}`;
  }

  function makeCard(item) {
    const card = document.createElement("article");
    card.className = "card" + (item.id === selectedId ? " selected" : "");
    card.dataset.id = item.id;

    const isVideo = item.media_kind === "video";
    const thumb = item.thumb_url || item.file_url;

    const thumbTag = isVideo
      ? `<video class="card-thumb" src="${esc(thumb)}" preload="metadata" muted playsinline></video>`
      : `<img class="card-thumb" src="${esc(thumb)}" alt="${esc(item.filename)}" loading="lazy" decoding="async">`;

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

  function makeGroupAlbumTile(item) {
    const tile = document.createElement("article");
    tile.className = "group-album-tile" + (item.id === selectedId ? " selected" : "");
    tile.dataset.id = item.id;

    const isVideo = item.media_kind === "video";
    const thumb = item.thumb_url || item.file_url;

    const thumbTag = isVideo
      ? `<video class="group-album-thumb" src="${esc(thumb)}" preload="metadata" muted playsinline></video>`
      : `<img class="group-album-thumb" src="${esc(thumb)}" alt="${esc(item.filename)}" loading="lazy" decoding="async">`;

    const badgeHTML = isVideo
      ? `<span class="card-badge badge-video">VIDEO</span>`
      : `<span class="card-badge">${esc(item.extension || "").toUpperCase()}</span>`;

    tile.innerHTML = `
      <div class="group-album-cover">
        ${thumbTag}
        ${badgeHTML}
        <div class="group-album-overlay">
          <span class="group-album-name">${esc(item.filename)}</span>
        </div>
      </div>`;

    tile.addEventListener("click", () => openDetail(item.id));
    return tile;
  }

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

  function makeAlbumCard(album) {
    const card = document.createElement("article");
    card.className = "album-card";

    const folderName = album.folder === "(radice)" ? "/ (radice)" : album.folder.split("/").pop();
    const folderPath = album.folder === "(radice)" ? "" : album.folder;
    const thumbs = Array.isArray(album.thumbs) ? album.thumbs.filter(Boolean) : [];
    const firstThumb = thumbs[0] || "";
    const dateStr = album.last_mtime ? fmtTs(album.last_mtime) : "";
    const subfolderParts = album.folder.split("/");
    const parentPath = subfolderParts.length > 1 ? subfolderParts.slice(0, -1).join(" / ") : "";

    card.innerHTML = `
      <div class="album-cover">
        ${firstThumb
          ? `<img class="album-rotating-thumb" src="${esc(firstThumb)}" alt="${esc(folderName)}" loading="lazy" decoding="async">`
          : `<div class="album-cover-placeholder"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>`}
        <div class="album-overlay"><span class="album-count">${album.count} elementi</span></div>
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

  function openAlbum(folderPath, folderName) {
    state.folder = folderPath;
    if (selFolder) selFolder.value = folderPath;
    if (albumBreadcrumbLabel) albumBreadcrumbLabel.textContent = folderName || folderPath || "radice";
    setViewMode("album-detail");
    syncFromUI();
    refreshMedia();
  }

  async function loadAlbums() {
    clearAlbumRotations();
    setViewMode("albums");
    gallery.innerHTML = "";
    gallery.className = "albums-grid";
    emptyState.classList.add("hidden");
    resultsText.textContent = "Caricamento album…";
    pageInfo.textContent = "";
    pageLabel.textContent = "";
    closeDetailPane(true);

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

  function getFolderState(folderName) {
    if (!folderGroupStates.has(folderName)) {
      folderGroupStates.set(folderName, { collapsed: false, albumView: false });
    }
    return folderGroupStates.get(folderName);
  }

  function renderFlatGallery(items, append = false) {
    if (!append) gallery.innerHTML = "";
    gallery.className = "gallery-grid" + (state.compact ? " compact" : "");
    emptyState.classList.toggle("hidden", items.length > 0 || append);

    if (!items.length && !append) {
      gallery.appendChild(emptyState);
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach(item => frag.appendChild(makeCard(item)));
    gallery.appendChild(frag);
  }

  function renderGroupedGallery(items) {
    gallery.innerHTML = "";
    gallery.className = "gallery-grid" + (state.compact ? " compact" : "");
    emptyState.classList.toggle("hidden", items.length > 0);

    if (!items.length) {
      gallery.appendChild(emptyState);
      return;
    }

    const groups = new Map();
    items.forEach(item => {
      const g = item.parent_folder || "(radice)";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(item);
    });

    groups.forEach((groupItems, folderName) => {
      const fs = getFolderState(folderName);
      const section = document.createElement("div");
      section.className = "folder-group";

      const header = document.createElement("div");
      header.className = "folder-group-header" + (fs.collapsed ? " collapsed" : "");
      header.innerHTML = `
        <button class="folder-group-toggle" aria-label="${fs.collapsed ? "Espandi" : "Comprimi"} cartella ${esc(folderName)}">
          <svg class="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <span class="folder-group-name">${esc(folderName)}</span>
        <span class="folder-group-count">(${groupItems.length})</span>
        <div class="folder-group-actions">
          <button class="btn btn-sm btn-ghost folder-album-toggle ${fs.albumView ? "active" : ""}" title="${fs.albumView ? "Vista griglia" : "Vista album"}" aria-pressed="${fs.albumView}">
            ${fs.albumView
              ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> Griglia`
              : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="m2 9 4-4 4 4 4-4 4 4"/><circle cx="7.5" cy="15.5" r="1.5"/></svg> Album`}
          </button>
        </div>`;

      const content = document.createElement("div");
      content.className = "folder-group-content" + (fs.collapsed ? " collapsed" : "");

      const renderInnerGrid = () => {
        const oldGrid = content.firstElementChild;
        if (oldGrid) oldGrid.remove();
        const grid = document.createElement("div");
        if (fs.albumView) {
          grid.className = "folder-group-album-grid";
          groupItems.forEach(item => grid.appendChild(makeGroupAlbumTile(item)));
        } else {
          grid.className = "folder-group-grid";
          groupItems.forEach(item => grid.appendChild(makeCard(item)));
        }
        content.appendChild(grid);
      };

      renderInnerGrid();
      section.appendChild(header);
      section.appendChild(content);

      header.addEventListener("click", e => {
        if (e.target.closest(".folder-group-actions")) return;
        fs.collapsed = !fs.collapsed;
        header.classList.toggle("collapsed", fs.collapsed);
        content.classList.toggle("collapsed", fs.collapsed);
        header.querySelector(".folder-group-toggle")?.setAttribute("aria-label", `${fs.collapsed ? "Espandi" : "Comprimi"} cartella ${folderName}`);
      });

      const albumToggleBtn = header.querySelector(".folder-album-toggle");
      albumToggleBtn.addEventListener("click", e => {
        e.stopPropagation();
        fs.albumView = !fs.albumView;
        albumToggleBtn.classList.toggle("active", fs.albumView);
        albumToggleBtn.setAttribute("aria-pressed", String(fs.albumView));
        albumToggleBtn.setAttribute("title", fs.albumView ? "Vista griglia" : "Vista album");
        albumToggleBtn.innerHTML = fs.albumView
          ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> Griglia`
          : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="m2 9 4-4 4 4 4-4 4 4"/><circle cx="7.5" cy="15.5" r="1.5"/></svg> Album`;
        renderInnerGrid();
      });

      gallery.appendChild(section);
    });

    updateSelectedCards();
  }

  function renderGallery(items, append = false) {
    if (state.groupFolder) {
      renderGroupedGallery(items);
      destroyInfiniteScroll();
      updateSentinel();
      return;
    }

    renderFlatGallery(items, append);
    ensureSentinel();
    updateSentinel();
    updateSelectedCards();
  }

  function updateProgress() {
    const loaded = currentItems.length;
    if (currentTotal === 0) {
      resultsText.textContent = "0 elementi";
      pageInfo.textContent = "";
      pageLabel.textContent = "";
      return;
    }

    resultsText.textContent = `${currentTotal} elementi — caricati ${loaded} / ${currentTotal}`;
    pageInfo.textContent = `Batch ${currentPage} / ${currentTotalPages}`;
    pageLabel.textContent = hasMore ? "Scroll infinito attivo" : "Fine risultati";
  }

  function getSelectedIndex() {
    return currentItems.findIndex(x => +x.id === +selectedId);
  }

  async function navigateDetail(direction) {
    if (!selectedId) return;

    let idx = getSelectedIndex();
    if (idx === -1) return;

    const target = currentItems[idx + direction];
    if (target) {
      openDetail(target.id);
      return;
    }

    if (direction > 0 && hasMore && !isLoading) {
      const token = currentQueryToken;
      await fetchMediaPage(currentPage + 1, true, token);
      idx = getSelectedIndex();
      const nextAfterLoad = currentItems[idx + direction];
      if (nextAfterLoad) openDetail(nextAfterLoad.id);
    }
  }

  function bindDetailInteractions() {
    detailContent.querySelector("[data-detail-prev]")?.addEventListener("click", () => navigateDetail(-1));
    detailContent.querySelector("[data-detail-next]")?.addEventListener("click", () => navigateDetail(1));

    const mediaZone = detailContent.querySelector(".d-media");
    if (!mediaZone) return;

    let startX = 0;
    let startY = 0;

    mediaZone.addEventListener("touchstart", e => {
      const t = e.changedTouches[0];
      startX = t.clientX;
      startY = t.clientY;
    }, { passive: true });

    mediaZone.addEventListener("touchend", e => {
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;

      if (Math.abs(dx) < 50) return;
      if (Math.abs(dx) < Math.abs(dy)) return;

      if (dx < 0) navigateDetail(1);
      else navigateDetail(-1);
    }, { passive: true });
  }

  async function fetchMediaPage(page, append = false, token = currentQueryToken) {
    if (isLoading) return;
    isLoading = true;
    updateSentinel();

    if (!append) {
      gallery.innerHTML = "";
      emptyState.classList.add("hidden");
      resultsText.textContent = "Caricamento…";
      pageInfo.textContent = "";
      pageLabel.textContent = "";
    }

    try {
      const data = await api(buildUrl(page));
      if (token !== currentQueryToken) return;

      const items = data.items || [];
      currentPage = data.page || page;
      currentTotal = data.total || 0;
      currentTotalPages = data.total_pages || Math.max(1, Math.ceil(currentTotal / PAGE_LIMIT));
      hasMore = currentPage < currentTotalPages && items.length > 0;

      if (append) {
        currentItems = currentItems.concat(items);
      } else {
        currentItems = items;
      }

      renderGallery(append ? items : currentItems, append);
      updateProgress();

      if (!currentItems.length) {
        hasMore = false;
        closeDetailPane(true);
        detailContent.innerHTML = `<div class="detail-placeholder"><p>Nessun elemento trovato.</p></div>`;
      } else if (selectedId && !currentItems.some(x => +x.id === +selectedId)) {
        closeDetailPane(true);
      }
    } catch (err) {
      if (token !== currentQueryToken) return;
      console.error(err);
      resultsText.textContent = "Errore di caricamento";
      detailContent.innerHTML = `<div class="detail-placeholder"><p>Errore: ${esc(err.message)}</p></div>`;
      hasMore = false;
    } finally {
      if (token === currentQueryToken) {
        isLoading = false;
        updateSentinel();
      }
    }
  }

  function refreshMedia() {
    currentQueryToken += 1;
    currentPage = 0;
    currentTotal = 0;
    currentTotalPages = 1;
    currentItems = [];
    hasMore = true;
    selectedId = null;
    closeDetailPane(true);
    renderChips();
    fetchMediaPage(1, false, currentQueryToken);
  }

  function loadNextPage() {
    if (isLoading || !hasMore || state.groupFolder || viewMode === "albums") return;
    fetchMediaPage(currentPage + 1, true, currentQueryToken);
  }

  async function openDetail(id) {
    selectedId = id;
    updateSelectedCards();
    setDetailOpen(true);

    const detailToken = ++currentDetailToken;
    detailContent.innerHTML = `<div class="detail-placeholder"><p>Caricamento…</p></div>`;

    try {
      const d = await api(`/media/${id}`);
      if (detailToken !== currentDetailToken) return;

      const chips = [
        d.media_kind && `Tipo: ${d.media_kind}`,
        d.extension && `Ext: .${d.extension}`,
        d.size_bytes != null && `Peso: ${fmtSize(d.size_bytes)}`,
        d.mtime && `Data: ${fmtTs(d.mtime)}`,
        d.model && `AI: ${d.model}`,
        d.language && `Lingua: ${d.language}`,
        d.parent_folder && `📁 ${d.parent_folder}`,
      ].filter(Boolean);

      const metaRows = [
        ["Nome", d.filename],
        ["Estensione", d.extension],
        ["Cartella", d.parent_folder],
        ["Percorso", d.relative_path],
        ["Peso", fmtSize(d.size_bytes)],
        ["Data file", fmtTs(d.mtime)],
        ["SHA256", d.sha256],
      ]
        .filter(r => r[1])
        .map(r => `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`)
        .join("");

      const exifKeys = ["Make","Model","CameraID","LensModel","CreateDate","DateTimeOriginal","ISO","FNumber","ExposureTime","ImageWidth","ImageHeight"];
      const meta = d.metadata || {};
      const allMetaKeys = [...new Set([...exifKeys, ...Object.keys(meta)])]
        .filter(k => meta[k] != null && String(meta[k]).trim());
      const metaExifRows = allMetaKeys
        .map(k => `<tr><th>${esc(k)}</th><td>${esc(String(meta[k]))}</td></tr>`)
        .join("");

      const mediaTag = d.media_kind === "video"
        ? `<video src="${esc(d.file_url)}" controls preload="metadata" style="width:100%;height:100%;object-fit:contain;"></video>`
        : `<img src="${esc(d.file_url)}" alt="${esc(d.filename)}" loading="eager" style="width:100%;height:100%;object-fit:contain;">`;

      const idx = getSelectedIndex();
      const canPrev = idx > 0;
      const canNext = idx < currentItems.length - 1 || hasMore;

      detailContent.innerHTML = `
        <div class="detail-nav">
          <div class="detail-nav-group">
            <button class="detail-nav-btn" data-detail-prev ${canPrev ? "" : "disabled"} aria-label="Contenuto precedente">←</button>
            <button class="detail-nav-btn" data-detail-next ${canNext ? "" : "disabled"} aria-label="Contenuto successivo">→</button>
          </div>
          <div class="detail-nav-meta">
            ${idx >= 0 ? `${idx + 1} / ${currentItems.length}` : ""}
          </div>
        </div>

        <div class="d-media">${mediaTag}</div>
        <div class="detail-swipe-hint">Swipe sinistra/destra per navigare</div>

        <div class="d-title">${esc(d.title || d.filename)}</div>
        ${d.relative_path ? `<div class="d-path">${esc(d.relative_path)}</div>` : ""}
        <div class="d-chips">${chips.map(c => `<span class="d-chip">${esc(c)}</span>`).join("")}</div>
        ${d.description ? `<div class="d-section">Descrizione AI</div><p class="d-desc">${esc(d.description)}</p>` : ""}
        <div class="d-section">Info file</div>
        <table class="d-table"><tbody>${metaRows}</tbody></table>
        ${metaExifRows ? `<div class="d-section">Metadati EXIF</div><table class="d-table"><tbody>${metaExifRows}</tbody></table>` : ""}
      `;

      bindDetailInteractions();
    } catch (e) {
      if (detailToken !== currentDetailToken) return;
      detailContent.innerHTML = `<div class="detail-placeholder"><p>Errore: ${esc(e.message)}</p></div>`;
    }
  }

  searchForm.addEventListener("submit", e => {
    e.preventDefault();
    if (viewMode === "albums") return;
    if (viewMode === "album-detail") setViewMode("all");
    syncFromUI();
    refreshMedia();
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    syncFromUI();
    renderChips();
    if (viewMode !== "albums") refreshMedia();
  });

  resetFiltersBtn?.addEventListener("click", () => {
    resetState();
    if (viewMode !== "albums") refreshMedia();
  });

  [selMediaKind, selExt, selMake, selModel, selCameraId, selLensModel, selAiModel, selFolder, selSort].forEach(el => {
    el.addEventListener("change", () => {
      if (viewMode === "albums") return;
      syncFromUI();
      renderChips();
      refreshMedia();
    });
  });

  searchInput.addEventListener("input", () => {
    syncFromUI();
    renderChips();
  });

  [chkFolder, chkCompact, chkGroupFolder].forEach(el => {
    el.addEventListener("change", () => {
      syncFromUI();
      renderChips();
      if (viewMode === "albums") return;

      if (el === chkGroupFolder) {
        if (state.groupFolder) destroyInfiniteScroll();
        else ensureSentinel();
      }

      renderGallery(currentItems, false);
      updateProgress();

      if (selectedId) {
        updateSelectedCards();
      }
    });
  });

  detailClose.addEventListener("click", () => closeDetailPane(true));

  btnViewAlbums.addEventListener("click", () => {
    loadAlbums();
  });

  btnViewAll.addEventListener("click", () => {
    state.folder = "";
    if (selFolder) selFolder.value = "";
    setViewMode("all");
    syncFromUI();
    refreshMedia();
  });

  btnAlbumBack?.addEventListener("click", () => {
    loadAlbums();
  });

  document.addEventListener("keydown", e => {
    if (!detailPane.classList.contains("open")) return;

    if (e.key === "Escape") {
      closeDetailPane(true);
      return;
    }
    if (e.key === "ArrowLeft") {
      navigateDetail(-1);
      return;
    }
    if (e.key === "ArrowRight") {
      navigateDetail(1);
    }
  });

  mobileMQ.addEventListener?.("change", () => {
    if (!isMobileViewport()) {
      document.body.classList.remove("detail-open-mobile");
      if (detailBackdrop) detailBackdrop.classList.remove("open");
      mainLayout?.classList.toggle("has-open-detail", detailPane.classList.contains("open"));
    } else if (detailPane.classList.contains("open")) {
      ensureDetailBackdrop();
      detailBackdrop.classList.add("open");
      document.body.classList.add("detail-open-mobile");
      mainLayout?.classList.remove("has-open-detail");
    }
  });

  async function init() {
    ensureDetailBackdrop();
    await loadFilters();
    syncFromUI();
    renderChips();
    setViewMode("all");
    closeDetailPane(true);
    refreshMedia();
  }

  init();
})();