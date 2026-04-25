(function () {
  const galleryEl = document.getElementById("gallery");
  const emptyStateEl = document.getElementById("empty-state");
  const detailContentEl = document.getElementById("detail-content");
  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  const clearSearchBtn = document.getElementById("clear-search");

  let currentItems = [];
  let currentPage = 1;
  let currentLimit = 100;
  let currentQuery = "";
  let hasMore = false;
  let totalItems = 0;

  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  function ensurePaginationEl() {
    let el = document.getElementById("pagination");
    if (!el) {
      el = document.createElement("div");
      el.id = "pagination";
      el.className = "pagination";
      galleryEl.parentElement.appendChild(el);
    }
    return el;
  }

  function renderPagination() {
    const el = ensurePaginationEl();
    el.innerHTML = "";

    const prevBtn = document.createElement("button");
    prevBtn.textContent = "← Precedente";
    prevBtn.disabled = currentPage <= 1;
    prevBtn.addEventListener("click", async () => {
      await loadPage(currentPage - 1, currentQuery);
    });

    const info = document.createElement("span");
    const start = totalItems === 0 ? 0 : (currentPage - 1) * currentLimit + 1;
    const end = Math.min(currentPage * currentLimit, totalItems);
    info.textContent = `Pagina ${currentPage} • ${start}-${end} di ${totalItems}`;

    const nextBtn = document.createElement("button");
    nextBtn.textContent = "Successiva →";
    nextBtn.disabled = !hasMore;
    nextBtn.addEventListener("click", async () => {
      await loadPage(currentPage + 1, currentQuery);
    });

    el.appendChild(prevBtn);
    el.appendChild(info);
    el.appendChild(nextBtn);
  }

  function renderGallery(items) {
    currentItems = items;
    galleryEl.innerHTML = "";

    if (!items || items.length === 0) {
      emptyStateEl.classList.remove("hidden");
      return;
    }

    emptyStateEl.classList.add("hidden");

    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const card = document.createElement("article");
      card.className = "card";
      card.dataset.id = item.id;

      let thumb;
      if (item.media_kind === "video") {
        thumb = document.createElement("video");
        thumb.muted = true;
        thumb.preload = "none";
        thumb.src = item.thumb_url || item.file_url;
      } else {
        thumb = document.createElement("img");
        thumb.loading = "lazy";
        thumb.src = item.thumb_url || item.file_url;
        thumb.alt = item.filename || "Foto";
      }

      const body = document.createElement("div");
      body.className = "card-body";

      const title = document.createElement("h2");
      title.className = "card-title";
      title.textContent = item.filename;

      const desc = document.createElement("p");
      desc.className = "card-desc";
      desc.textContent = item.description || "";

      body.appendChild(title);
      body.appendChild(desc);
      card.appendChild(thumb);
      card.appendChild(body);

      card.addEventListener("click", () => openDetail(item.id));

      fragment.appendChild(card);
    });

    galleryEl.appendChild(fragment);
  }

  function renderMetadataTable(metadata) {
    if (!metadata || typeof metadata !== "object") return "";
    const keys = Object.keys(metadata);
    if (keys.length === 0) return "";

    const primary = ["Make", "Model", "LensModel", "CreateDate", "ISO", "FNumber", "ExposureTime"];
    const sorted = [
      ...primary.filter((k) => Object.prototype.hasOwnProperty.call(metadata, k)),
      ...keys.filter((k) => !primary.includes(k)).sort((a, b) => a.localeCompare(b)),
    ];

    const rows = sorted.map(
      (key) => `<tr><th>${esc(key)}</th><td>${esc(String(metadata[key]))}</td></tr>`
    );

    return `
      <table class="meta-table">
        <tbody>
          ${rows.join("")}
        </tbody>
      </table>
    `;
  }

  async function openDetail(id) {
    detailContentEl.innerHTML = `<p class="placeholder">Caricamento dettagli...</p>`;
    try {
      const data = await fetchJSON(`/media/${id}`);

      const chips = [];
      if (data.ai_description && data.ai_description.model) {
        chips.push(`Modello AI: ${esc(data.ai_description.model)}`);
      }
      if (data.ai_description && data.ai_description.language) {
        chips.push(`Lingua: ${esc(data.ai_description.language)}`);
      }
      if (data.size_bytes != null) {
        chips.push(`${(data.size_bytes / (1024 * 1024)).toFixed(1)} MB`);
      }

      const metaTable = renderMetadataTable(data.metadata);

      const mediaTag =
        data.media_kind === "video"
          ? `<video class="detail-image" src="${esc(data.file_url)}" controls></video>`
          : `<img class="detail-image" src="${esc(data.file_url)}" alt="${esc(data.filename)}" />`;

      detailContentEl.innerHTML = `
        ${mediaTag}
        <h2 class="detail-title">${esc(data.title || data.filename)}</h2>
        <p class="detail-path">${esc(data.absolute_path)}</p>

        ${
          chips.length
            ? `<div class="chip-row">${chips.map((c) => `<span class="chip">${c}</span>`).join("")}</div>`
            : ""
        }

        <h3 class="detail-section-title">Descrizione AI</h3>
        <p class="detail-description">${esc(
          (data.ai_description && data.ai_description.text) || "Nessuna descrizione disponibile."
        )}</p>

        ${metaTable ? `<h3 class="detail-section-title">Metadati</h3>${metaTable}` : ""}
      `;
    } catch (err) {
      console.error(err);
      detailContentEl.innerHTML =
        '<p class="placeholder">Errore nel caricamento dei dettagli.</p>';
    }
  }

  async function loadPage(page = 1, q = "") {
    const url = q
      ? `/search?q=${encodeURIComponent(q)}&page=${page}&limit=${currentLimit}`
      : `/media?page=${page}&limit=${currentLimit}`;

    const data = await fetchJSON(url);
    currentPage = data.page || 1;
    hasMore = !!data.has_more;
    totalItems = data.total || 0;
    renderGallery(data.items || []);
    renderPagination();
  }

  async function loadInitial() {
    try {
      await loadPage(1, "");
      if (currentItems.length > 0) {
        openDetail(currentItems[0].id);
      }
    } catch (err) {
      console.error(err);
      emptyStateEl.classList.remove("hidden");
      emptyStateEl.textContent =
        "Errore nel caricamento della libreria. Verifica che il backend sia in esecuzione.";
    }
  }

  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    currentQuery = searchInput.value.trim();
    try {
      await loadPage(1, currentQuery);
      detailContentEl.innerHTML =
        '<p class="placeholder">Seleziona una foto per vedere i dettagli.</p>';
    } catch (err) {
      console.error(err);
    }
  });

  clearSearchBtn.addEventListener("click", async () => {
    searchInput.value = "";
    currentQuery = "";
    try {
      await loadPage(1, "");
      detailContentEl.innerHTML =
        '<p class="placeholder">Seleziona una foto per vedere i dettagli.</p>';
    } catch (err) {
      console.error(err);
    }
  });

  loadInitial();
})();