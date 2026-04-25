(function () {
  const galleryEl = document.getElementById("gallery");
  const emptyStateEl = document.getElementById("empty-state");
  const detailPanelEl = document.getElementById("detail-panel");
  const detailContentEl = document.getElementById("detail-content");
  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  const clearSearchBtn = document.getElementById("clear-search");

  let currentItems = [];
  let currentPage = 1;
  const pageLimit = 100;

  const esc = (s) =>
    String(s ?? "")
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

  function renderGallery(items) {
    currentItems = items || [];
    galleryEl.innerHTML = "";

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

      let thumb;
      if (item.media_kind === "video") {
        thumb = document.createElement("video");
        thumb.className = "card-thumb";
        thumb.preload = "metadata";
        thumb.muted = true;
        thumb.playsInline = true;
        thumb.src = item.thumb_url || item.file_url;
      } else {
        thumb = document.createElement("img");
        thumb.className = "card-thumb";
        thumb.loading = "lazy";
        thumb.decoding = "async";
        thumb.src = item.thumb_url || item.file_url;
        thumb.alt = item.filename || "Media";
      }

      const body = document.createElement("div");
      body.className = "card-body";

      const title = document.createElement("h2");
      title.className = "card-title";
      title.textContent = item.filename || "Senza nome";

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
    if (!metadata || typeof metadata !== "object") {
      return "";
    }

    const keys = Object.keys(metadata);
    if (!keys.length) {
      return "";
    }

    const primary = [
      "Make",
      "Model",
      "LensModel",
      "CreateDate",
      "ISO",
      "FNumber",
      "ExposureTime",
      "Duration",
      "ImageWidth",
      "ImageHeight",
    ];

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

  function formatSize(bytes) {
    if (bytes == null || Number.isNaN(Number(bytes))) return "";
    const mb = Number(bytes) / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  }

  async function openDetail(id) {
    detailContentEl.innerHTML = `<p class="placeholder">Caricamento dettagli...</p>`;

    try {
      const data = await fetchJSON(`/media/${id}`);
      const chips = [];

      if (data.model) {
        chips.push(`Modello AI: ${esc(data.model)}`);
      }
      if (data.language) {
        chips.push(`Lingua: ${esc(data.language)}`);
      }
      if (data.size_bytes != null) {
        chips.push(formatSize(data.size_bytes));
      }
      if (data.media_kind) {
        chips.push(data.media_kind);
      }

      const metaTable = renderMetadataTable(data.metadata);

      const mediaTag =
        data.media_kind === "video"
          ? `<video class="detail-image" src="${esc(data.file_url)}" controls preload="metadata"></video>`
          : `<img class="detail-image" src="${esc(data.file_url)}" alt="${esc(data.filename)}" loading="eager" />`;

      detailContentEl.innerHTML = `
        ${mediaTag}
        <h2 class="detail-title">${esc(data.title || data.filename || "Dettaglio")}</h2>

        ${
          chips.length
            ? `<div class="chip-row">${chips
                .map((c) => `<span class="chip">${c}</span>`)
                .join("")}</div>`
            : ""
        }

        <h3 class="detail-section-title">Descrizione AI</h3>
        <p class="detail-description">${esc(
          data.description || "Nessuna descrizione disponibile."
        )}</p>

        ${
          metaTable
            ? `<h3 class="detail-section-title">Metadati</h3>${metaTable}`
            : ""
        }
      `;
    } catch (err) {
      console.error(err);
      detailContentEl.innerHTML =
        '<p class="placeholder">Errore nel caricamento dei dettagli.</p>';
    }
  }

  async function loadInitial(page = 1) {
    try {
      const payload = await fetchJSON(`/media?page=${page}&limit=${pageLimit}`);
      renderGallery(payload.items || []);
      currentPage = payload.page || 1;

      if (payload.items && payload.items.length > 0) {
        openDetail(payload.items[0].id);
      } else {
        detailContentEl.innerHTML =
          '<p class="placeholder">Seleziona un elemento per vedere i dettagli.</p>';
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
    const q = searchInput.value.trim();
    const url = q
      ? `/search?q=${encodeURIComponent(q)}`
      : `/media?page=1&limit=${pageLimit}`;

    try {
      const payload = await fetchJSON(url);
      const items = Array.isArray(payload) ? payload : payload.items || [];
      renderGallery(items);
      detailContentEl.innerHTML =
        '<p class="placeholder">Seleziona un elemento per vedere i dettagli.</p>';

      if (items.length > 0) {
        openDetail(items[0].id);
      }
    } catch (err) {
      console.error(err);
    }
  });

  clearSearchBtn.addEventListener("click", async () => {
    searchInput.value = "";
    await loadInitial(1);
  });

  loadInitial(1);
})();