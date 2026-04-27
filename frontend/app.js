"use strict";
(function () {

  /* ─── DOM refs ──────────────────────────────────────────── */
  const mainLayout        = document.querySelector(".main-layout");
  const gallery           = document.getElementById("gallery");
  const galleryContainer  = document.getElementById("gallery-container");
  const emptyState        = document.getElementById("empty-state");
  const detailContent     = document.getElementById("detail-content");
  const detailPane        = document.getElementById("detail-pane");
  const detailClose       = document.getElementById("detail-close");
  const detailPrev        = document.getElementById("detail-prev");
  const detailNext        = document.getElementById("detail-next");
  const detailBackdropEl  = document.getElementById("detail-backdrop");

  const searchForm        = document.getElementById("search-form");
  const searchInput       = document.getElementById("search-input");
  const clearBtn          = document.getElementById("clear-btn");
  const resetFiltersBtn   = document.getElementById("reset-filters-btn");

  const toggleFiltersBtn  = document.getElementById("toggle-filters-btn");
  const filterPanel       = document.getElementById("filter-panel");
  const filterBadge       = document.getElementById("filter-badge");
  const activeChips       = document.getElementById("active-chips");

  const selMediaKind      = document.getElementById("filter-media-kind");
  const selExt            = document.getElementById("filter-ext");
  const selMake           = document.getElementById("filter-make");
  const selModel          = document.getElementById("filter-model");
  const selCameraId       = document.getElementById("filter-camera-id");
  const selLensModel      = document.getElementById("filter-lens-model");
  const selAiModel        = document.getElementById("filter-ai-model");
  const selFolder         = document.getElementById("filter-folder");
  const selSort           = document.getElementById("sort-select");

  const chkFolder         = document.getElementById("toggle-folder");
  const chkCompact        = document.getElementById("toggle-compact");
  const chkGroupFolder    = document.getElementById("toggle-group-folder");

  const resultsText       = document.getElementById("results-text");
  const pageInfo          = document.getElementById("page-info");
  const pageLabel         = document.getElementById("page-label");
  const paginationEl      = document.querySelector(".pagination");

  const btnViewAlbums     = document.getElementById("btn-view-albums");
  const btnViewAll        = document.getElementById("btn-view-all");
  const albumBreadcrumb   = document.getElementById("album-breadcrumb");
  const albumBreadcrumbLabel = document.getElementById("album-breadcrumb-label");
  const btnAlbumBack      = document.getElementById("btn-album-back");

  /* ─── Constants ─────────────────────────────────────────── */
  const PAGE_LIMIT      = 100;
  const ALBUM_ROTATE_MS = 3500;
  const MOBILE_BP       = 900;

  /* ─── State ─────────────────────────────────────────────── */
  let viewMode          = "all";
  let selectedId        = null;
  let currentTotal      = 0;
  let currentTotalPages = 1;
  let currentPage       = 0;
  let currentItems      = [];
  let isLoading         = false;
  let hasMore           = true;
  let currentQueryToken = 0;
  let currentDetailToken = 0;
  let infiniteObserver  = null;
  let sentinelEl        = null;

  const mobileMQ            = window.matchMedia(`(max-width: ${MOBILE_BP}px)`);
  const folderGroupStates   = new Map();
  const albumRotationTimers = new Set();

  const state = {
    q: "", page: 1,
    mediaKind: "", ext: "", make: "", model: "",
    cameraId: "", lensModel: "", aiModel: "", folder: "",
    sort: "created_desc",
    showFolder: false, compact: false, groupFolder: false,
  };

  /* ─── Helpers ───────────────────────────────────────────── */
  const esc = s => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const isMobile = () => mobileMQ.matches;

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

  /* ─── Detail pane open/close ────────────────────────────── */

  function setDetailOpen(open) {
    const desktop = !isMobile();
    mainLayout?.classList.toggle("has-open-detail", open && desktop);
    detailPane.classList.toggle("open", open);
    if (isMobile()) {
      detailBackdropEl?.classList.toggle("open", open);
      document.body.classList.toggle("detail-open-mobile", open);
    } else {
      document.body.classList.remove("detail-open-mobile");
      detailBackdropEl?.classList.remove("open");
    }
    // aggiorna stato pulsanti prev/next nella toolbar
    updateNavButtons();
  }

  function closeDetailPane(clearSel = false) {
    setDetailOpen(false);
    if (clearSel) { selectedId = null; updateSelectedCards(); }
  }

  /* ─── Nav buttons (toolbar del detail pane) ─────────────── */

  function updateNavButtons() {
    if (!detailPrev || !detailNext) return;
    const idx = getSelectedIndex();
    const open = detailPane.classList.contains("open");
    detailPrev.disabled = !open || idx <= 0;
    detailNext.disabled = !open || (idx >= currentItems.length - 1 && !hasMore);
  }

  detailPrev?.addEventListener("click", () => navigateDetail(-1));
  detailNext?.addEventListener("click", () => navigateDetail(1));

  /* ─── Utilities ─────────────────────────────────────────── */

  function updateSelectedCards() {
    document.querySelectorAll(".card, .group-album-tile").forEach(c =>
      c.classList.toggle("selected", +c.dataset.id === +selectedId)
    );
  }

  function clearAlbumRotations() {
    for (const t of albumRotationTimers) clearInterval(t);
    albumRotationTimers.clear();
  }

  /* ─── Infinite scroll sentinel ──────────────────────────── */

  function destroyInfiniteScroll() {
    if (infiniteObserver) { infiniteObserver.disconnect(); infiniteObserver = null; }
    if (sentinelEl?.parentNode) sentinelEl.parentNode.removeChild(sentinelEl);
    sentinelEl = null;
  }

  function ensureSentinel() {
    destroyInfiniteScroll();
    sentinelEl = document.createElement("div");
    sentinelEl.className = "infinite-scroll-sentinel";
    sentinelEl.innerHTML = '<span class="loading-more-text">Scorri per caricare altri 100 elementi</span>';
    galleryContainer.appendChild(sentinelEl);

    infiniteObserver = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting) return;
      if (viewMode === "albums" || state.groupFolder || isLoading || !hasMore) return;
      loadNextPage();
    }, { root: galleryContainer, rootMargin: "400px 0px", threshold: 0 });

    infiniteObserver.observe(sentinelEl);
    updateSentinel();
  }

  function updateSentinel() {
    if (!sentinelEl) return;
    const hide = viewMode === "albums" || state.groupFolder ||
                 (!currentItems.length && !isLoading) ||
                 (!hasMore && currentItems.length > 0);
    sentinelEl.classList.toggle("hidden", hide);
    sentinelEl.classList.toggle("is-loading", isLoading);
    const label = sentinelEl.querySelector(".loading-more-text");
    if (!label) return;
    if (state.groupFolder)                          label.textContent = "Scroll infinito disattivato con raggruppamento per cartella";
    else if (isLoading && currentItems.length > 0)  label.textContent = "Caricamento altri 100 elementi…";
    else if (hasMore)                               label.textContent = "Scorri per caricare altri 100 elementi";
    else                                            label.textContent = "Hai raggiunto la fine della galleria";
  }

  /* ─── View mode ─────────────────────────────────────────── */

  function setViewMode(mode) {
    viewMode = mode;
    const isAlbums      = mode === "albums";
    const isAlbumDetail = mode === "album-detail";
    const isAll         = mode === "all";

    btnViewAlbums.classList.toggle("active", isAlbums || isAlbumDetail);
    btnViewAlbums.setAttribute("aria-pressed", String(isAlbums || isAlbumDetail));
    btnViewAll.classList.toggle("active", isAll);
    btnViewAll.setAttribute("aria-pressed", String(isAll));

    albumBreadcrumb.classList.toggle("hidden", !isAlbumDetail);

    const searchWrap = document.querySelector(".topbar-search-wrap");
    if (searchWrap) searchWrap.style.display = isAlbums ? "none" : "";
    if (toggleFiltersBtn) toggleFiltersBtn.style.display = isAlbums ? "none" : "";

    if (isAlbums) {
      filterPanel.classList.remove("open");
      toggleFiltersBtn.setAttribute("aria-expanded", "false");
      destroyInfiniteScroll();
      closeDetailPane(true);
    } else if (!state.groupFolder) {
      ensureSentinel();
    }

    paginationEl?.classList.add("hidden");
    if (!isAlbums) clearAlbumRotations();
    renderChips();
    updateSentinel();
  }

  /* ─── Filter panel ──────────────────────────────────────── */

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
      o.value = v; o.textContent = v;
      if (v === prev) o.selected = true;
      el.appendChild(o);
    });
  }

  async function loadFilters() {
    try {
      const d = await api("/filters");
      fillSelect(selMediaKind, d.media_kind, "Tutti");
      fillSelect(selExt,       d.extension,  "Tutte");
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
    } catch (e) { console.warn("loadFilters:", e); }
  }

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
    state.groupFolder = chkGroupFolder.checked;
  }

  function resetState() {
    searchInput.value = "";
    selMediaKind.value = ""; selExt.value = "";
    selMake.value = "";      selModel.value = "";
    selCameraId.value = "";  selLensModel.value = "";
    selAiModel.value = "";   selFolder.value = "";
    selSort.value = "created_desc";
    chkFolder.checked = false; chkCompact.checked = false; chkGroupFolder.checked = false;
    syncFromUI(); renderChips();
  }

  const FILTER_LABELS = {
    q: "Testo", mediaKind: "Tipo", ext: "Ext", make: "Marca",
    model: "Modello", cameraId: "CameraID", lensModel: "Obiettivo",
    aiModel: "AI", folder: "Cartella",
  };

  function removeSingleFilter(key) {
    const map = {
      q: searchInput, mediaKind: selMediaKind, ext: selExt,
      make: selMake, model: selModel, cameraId: selCameraId,
      lensModel: selLensModel, aiModel: selAiModel, folder: selFolder,
    };
    if (!map[key]) return;
    map[key].value = "";
    syncFromUI();
    if (viewMode !== "albums") refreshMedia();
  }

  function renderChips() {
    syncFromUI();
    const keys   = ["q","mediaKind","ext","make","model","cameraId","lensModel","aiModel","folder"];
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
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </span>`).join("");
    activeChips.querySelectorAll("[data-filter-key]").forEach(btn =>
      btn.addEventListener("click", e => {
        e.preventDefault(); e.stopPropagation();
        removeSingleFilter(btn.dataset.filterKey);
      })
    );
  }

  /* ─── API query builder ─────────────────────────────────── */

  function buildUrl(page) {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("limit", String(PAGE_LIMIT));
    p.set("sort", state.sort);
    if (state.q)          p.set("q",          state.q);
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

  /* ─── Card / tile factories ─────────────────────────────── */

  function makeCard(item) {
    const card   = document.createElement("article");
    card.className = "card" + (item.id === selectedId ? " selected" : "");
    card.dataset.id = item.id;
    const isVideo = item.media_kind === "video";
    const thumb   = item.thumb_url || item.file_url;
    const thumbTag = isVideo
      ? `<video class="card-thumb" src="${esc(thumb)}" preload="metadata" muted playsinline></video>`
      : `<img class="card-thumb" src="${esc(thumb)}" alt="${esc(item.filename)}" loading="lazy" decoding="async">`;
    const badgeHTML = isVideo
      ? `<span class="card-badge badge-video">VIDEO</span>`
      : `<span class="card-badge">${esc((item.extension || "").toUpperCase())}</span>`;
    const folderHTML = state.showFolder && item.parent_folder
      ? `<div class="card-folder">📁 ${esc(item.parent_folder)}</div>` : "";
    card.innerHTML = `
      <div class="card-thumb-wrap">${thumbTag}${badgeHTML}</div>
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
    const isVideo  = item.media_kind === "video";
    const thumb    = item.thumb_url || item.file_url;
    const thumbTag = isVideo
      ? `<video class="group-album-thumb" src="${esc(thumb)}" preload="metadata" muted playsinline></video>`
      : `<img class="group-album-thumb" src="${esc(thumb)}" alt="${esc(item.filename)}" loading="lazy" decoding="async">`;
    const badgeHTML = isVideo
      ? `<span class="card-badge badge-video">VIDEO</span>`
      : `<span class="card-badge">${esc((item.extension || "").toUpperCase())}</span>`;
    tile.innerHTML = `
      <div class="group-album-cover">
        ${thumbTag}${badgeHTML}
        <div class="group-album-overlay">
          <span class="group-album-name">${esc(item.filename)}</span>
        </div>
      </div>`;
    tile.addEventListener("click", () => openDetail(item.id));
    return tile;
  }

  /* ─── Album card + rotation ─────────────────────────────── */

  function startAlbumRotation(card, thumbs) {
    if (!Array.isArray(thumbs) || thumbs.length <= 1) return;
    const img = card.querySelector(".album-rotating-thumb");
    if (!img) return;
    let idx = 0;
    const timer = setInterval(() => {
      if (!document.body.contains(card)) { clearInterval(timer); albumRotationTimers.delete(timer); return; }
      const nextIdx = (idx + 1) % thumbs.length;
      const preload = new Image();
      preload.onload = () => {
        img.classList.add("is-fading");
        setTimeout(() => { img.src = thumbs[nextIdx]; img.classList.remove("is-fading"); idx = nextIdx; }, 180);
      };
      preload.src = thumbs[nextIdx];
    }, ALBUM_ROTATE_MS + Math.floor(Math.random() * 1200));
    albumRotationTimers.add(timer);
  }

  function makeAlbumCard(album) {
    const card = document.createElement("article");
    card.className = "album-card";
    const folderName = album.folder === "(radice)" ? "/ (radice)" : album.folder.split("/").pop();
    const folderPath = album.folder === "(radice)" ? "" : album.folder;
    const thumbs     = (Array.isArray(album.thumbs) ? album.thumbs : []).filter(Boolean);
    const firstThumb = thumbs[0] || "";
    const dateStr    = album.last_mtime ? fmtTs(album.last_mtime) : "";
    const parts      = album.folder.split("/");
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join(" / ") : "";
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
        ${dateStr    ? `<div class="album-date">${esc(dateStr)}</div>`    : ""}
      </div>`;
    card.addEventListener("click", () => openAlbum(folderPath, folderName));
    startAlbumRotation(card, thumbs);
    return card;
  }

  /* ─── Albums view ───────────────────────────────────────── */

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
        emptyState.textContent = "Nessun album trovato.";
        emptyState.classList.remove("hidden");
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

  /* ─── Gallery render ────────────────────────────────────── */

  function getFolderState(name) {
    if (!folderGroupStates.has(name)) folderGroupStates.set(name, { collapsed: false, albumView: false });
    return folderGroupStates.get(name);
  }

  function renderFlatGallery(items, append = false) {
    if (!append) gallery.innerHTML = "";
    gallery.className = "gallery-grid" + (state.compact ? " compact" : "");
    emptyState.classList.toggle("hidden", items.length > 0 || append);
    if (!items.length && !append) { gallery.appendChild(emptyState); return; }
    const frag = document.createDocumentFragment();
    items.forEach(item => frag.appendChild(makeCard(item)));
    gallery.appendChild(frag);
  }

  function renderGroupedGallery(items) {
    gallery.innerHTML = "";
    gallery.className = "gallery-grid" + (state.compact ? " compact" : "");
    emptyState.classList.toggle("hidden", items.length > 0);
    if (!items.length) { gallery.appendChild(emptyState); return; }

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
          <button class="btn btn-sm btn-ghost folder-album-toggle ${fs.albumView ? "active" : ""}" aria-pressed="${fs.albumView}" title="${fs.albumView ? "Vista griglia" : "Vista album"}">
            ${fs.albumView
              ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> Griglia`
              : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="m2 9 4-4 4 4 4-4 4 4"/><circle cx="7.5" cy="15.5" r="1.5"/></svg> Album`}
          </button>
        </div>`;

      const content = document.createElement("div");
      content.className = "folder-group-content" + (fs.collapsed ? " collapsed" : "");

      const renderInnerGrid = () => {
        const old = content.firstElementChild;
        if (old) old.remove();
        const grid = document.createElement("div");
        grid.className = fs.albumView ? "folder-group-album-grid" : "folder-group-grid";
        groupItems.forEach(item => grid.appendChild(
          fs.albumView ? makeGroupAlbumTile(item) : makeCard(item)
        ));
        content.appendChild(grid);
      };
      renderInnerGrid();

      header.addEventListener("click", e => {
        if (e.target.closest(".folder-group-actions")) return;
        fs.collapsed = !fs.collapsed;
        header.classList.toggle("collapsed", fs.collapsed);
        content.classList.toggle("collapsed", fs.collapsed);
        header.querySelector(".folder-group-toggle")?.setAttribute(
          "aria-label", `${fs.collapsed ? "Espandi" : "Comprimi"} cartella ${folderName}`
        );
      });

      const albumToggle = header.querySelector(".folder-album-toggle");
      albumToggle.addEventListener("click", e => {
        e.stopPropagation();
        fs.albumView = !fs.albumView;
        albumToggle.classList.toggle("active", fs.albumView);
        albumToggle.setAttribute("aria-pressed", String(fs.albumView));
        albumToggle.setAttribute("title", fs.albumView ? "Vista griglia" : "Vista album");
        albumToggle.innerHTML = fs.albumView
          ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> Griglia`
          : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="m2 9 4-4 4 4 4-4 4 4"/><circle cx="7.5" cy="15.5" r="1.5"/></svg> Album`;
        renderInnerGrid();
      });

      section.appendChild(header);
      section.appendChild(content);
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

  /* ─── Progress ──────────────────────────────────────────── */

  function updateProgress() {
    const loaded = currentItems.length;
    if (currentTotal === 0) {
      resultsText.textContent = "0 elementi";
      pageInfo.textContent = pageLabel.textContent = "";
      return;
    }
    resultsText.textContent = `${currentTotal} elementi — caricati ${loaded} / ${currentTotal}`;
    pageInfo.textContent    = `Batch ${currentPage} / ${currentTotalPages}`;
    pageLabel.textContent   = hasMore ? "Scroll infinito attivo" : "Fine risultati";
  }

  /* ─── Detail navigation ─────────────────────────────────── */

  function getSelectedIndex() {
    return currentItems.findIndex(x => +x.id === +selectedId);
  }

  async function navigateDetail(direction) {
    if (!selectedId) return;
    const idx = getSelectedIndex();
    if (idx === -1) return;
    const target = currentItems[idx + direction];
    if (target) { openDetail(target.id); return; }
    if (direction > 0 && hasMore && !isLoading) {
      const token = currentQueryToken;
      await fetchMediaPage(currentPage + 1, true, token);
      const next = currentItems[getSelectedIndex() + direction];
      if (next) openDetail(next.id);
    }
  }

  /* ─── Media fetching ────────────────────────────────────── */

  async function fetchMediaPage(page, append = false, token = currentQueryToken) {
    if (isLoading) return;
    isLoading = true;
    updateSentinel();
    if (!append) {
      gallery.innerHTML = "";
      emptyState.classList.add("hidden");
      resultsText.textContent = "Caricamento…";
      pageInfo.textContent = pageLabel.textContent = "";
    }
    try {
      const data = await api(buildUrl(page));
      if (token !== currentQueryToken) return;
      const items = data.items || [];
      currentPage       = data.page || page;
      currentTotal      = data.total || 0;
      currentTotalPages = data.total_pages || Math.max(1, Math.ceil(currentTotal / PAGE_LIMIT));
      hasMore           = currentPage < currentTotalPages && items.length > 0;
      currentItems      = append ? currentItems.concat(items) : items;
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
      if (token === currentQueryToken) { isLoading = false; updateSentinel(); updateNavButtons(); }
    }
  }

  function refreshMedia() {
    currentQueryToken += 1;
    currentPage = 0; currentTotal = 0; currentTotalPages = 1;
    currentItems = []; hasMore = true;
    selectedId = null;
    closeDetailPane(true);
    renderChips();
    fetchMediaPage(1, false, currentQueryToken);
  }

  function loadNextPage() {
    if (isLoading || !hasMore || state.groupFolder || viewMode === "albums") return;
    fetchMediaPage(currentPage + 1, true, currentQueryToken);
  }

  /* ─── Detail panel content ──────────────────────────────── */

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

      const exifKeys = ["Make","Model","CameraID","LensModel","CreateDate",
        "DateTimeOriginal","ISO","FNumber","ExposureTime","ImageWidth","ImageHeight"];
      const meta     = d.metadata || {};
      const exifRows = [...new Set([...exifKeys, ...Object.keys(meta)])]
        .filter(k => meta[k] != null && String(meta[k]).trim())
        .map(k => `<tr><th>${esc(k)}</th><td>${esc(String(meta[k]))}</td></tr>`)
        .join("");

      const mediaTag = d.media_kind === "video"
        ? `<video src="${esc(d.file_url)}" controls preload="metadata" style="width:100%;height:100%;object-fit:contain;"></video>`
        : `<img src="${esc(d.file_url)}" alt="${esc(d.filename)}" loading="eager" style="width:100%;height:100%;object-fit:contain;">`;

      detailContent.innerHTML = `
        <div class="d-media">${mediaTag}</div>
        <div class="detail-swipe-hint">← Swipe per navigare →</div>
        <div class="d-title">${esc(d.title || d.filename)}</div>
        ${d.relative_path ? `<div class="d-path">${esc(d.relative_path)}</div>` : ""}
        <div class="d-chips">${chips.map(c => `<span class="d-chip">${esc(c)}</span>`).join("")}</div>
        ${d.description ? `<div class="d-section">Descrizione AI</div><p class="d-desc">${esc(d.description)}</p>` : ""}
        <div class="d-section">Info file</div>
        <table class="d-table"><tbody>${metaRows}</tbody></table>
        ${exifRows ? `<div class="d-section">Metadati EXIF</div><table class="d-table"><tbody>${exifRows}</tbody></table>` : ""}
      `;

      // touch swipe sul media
      const mediaZone = detailContent.querySelector(".d-media");
      if (mediaZone) {
        let sx = 0, sy = 0;
        mediaZone.addEventListener("touchstart", e => { const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
        mediaZone.addEventListener("touchend",   e => {
          const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
          if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
          navigateDetail(dx < 0 ? 1 : -1);
        }, { passive: true });
      }

      updateNavButtons();
    } catch (e) {
      if (detailToken !== currentDetailToken) return;
      detailContent.innerHTML = `<div class="detail-placeholder"><p>Errore: ${esc(e.message)}</p></div>`;
    }
  }

  /* ─── Event listeners ───────────────────────────────────── */

  searchForm.addEventListener("submit", e => {
    e.preventDefault();
    if (viewMode === "albums") return;
    if (viewMode === "album-detail") setViewMode("all");
    syncFromUI(); refreshMedia();
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    syncFromUI(); renderChips();
    if (viewMode !== "albums") refreshMedia();
  });

  resetFiltersBtn?.addEventListener("click", () => {
    resetState();
    if (viewMode !== "albums") refreshMedia();
  });

  [selMediaKind, selExt, selMake, selModel, selCameraId, selLensModel, selAiModel, selFolder, selSort]
    .forEach(el => el.addEventListener("change", () => {
      if (viewMode === "albums") return;
      syncFromUI(); renderChips(); refreshMedia();
    }));

  searchInput.addEventListener("input", () => { syncFromUI(); renderChips(); });

  [chkFolder, chkCompact, chkGroupFolder].forEach(el => {
    el.addEventListener("change", () => {
      syncFromUI(); renderChips();
      if (viewMode === "albums") return;
      if (el === chkGroupFolder) {
        if (state.groupFolder) destroyInfiniteScroll();
        else ensureSentinel();
      }
      renderGallery(currentItems, false);
      updateProgress();
      if (selectedId) updateSelectedCards();
    });
  });

  detailClose.addEventListener("click", () => closeDetailPane(true));
  detailBackdropEl?.addEventListener("click", () => closeDetailPane(true));

  btnViewAlbums.addEventListener("click", () => loadAlbums());
  btnViewAll.addEventListener("click", () => {
    state.folder = ""; if (selFolder) selFolder.value = "";
    setViewMode("all"); syncFromUI(); refreshMedia();
  });
  btnAlbumBack?.addEventListener("click", () => loadAlbums());

  document.addEventListener("keydown", e => {
    if (!detailPane.classList.contains("open")) return;
    if (e.key === "Escape")     { closeDetailPane(true); return; }
    if (e.key === "ArrowLeft")  { navigateDetail(-1); return; }
    if (e.key === "ArrowRight") { navigateDetail(1); }
  });

  mobileMQ.addEventListener?.("change", () => {
    if (!isMobile()) {
      document.body.classList.remove("detail-open-mobile");
      detailBackdropEl?.classList.remove("open");
      mainLayout?.classList.toggle("has-open-detail", detailPane.classList.contains("open"));
    } else if (detailPane.classList.contains("open")) {
      detailBackdropEl?.classList.add("open");
      document.body.classList.add("detail-open-mobile");
      mainLayout?.classList.remove("has-open-detail");
    }
  });

  /* ─── Init ──────────────────────────────────────────────── */

  async function init() {
    await loadFilters();
    syncFromUI();
    renderChips();
    setViewMode("all");
    closeDetailPane(true);
    refreshMedia();
  }

  init();

})();
