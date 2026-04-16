(function () {
  const galleryEl = document.getElementById("gallery");
  const emptyStateEl = document.getElementById("empty-state");
  const detailPanelEl = document.getElementById("detail-panel");
  const detailContentEl = document.getElementById("detail-content");
  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  const clearSearchBtn = document.getElementById("clear-search");

  let currentItems = [];

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
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

      const img = document.createElement("img");
      img.loading = "lazy";
      img.src = item.thumb_url || item.file_url;
      img.alt = item.filename || "Foto";

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
      card.appendChild(img);
      card.appendChild(body);

      card.addEventListener("click", () => openDetail(item.id));

      fragment.appendChild(card);
    });

    galleryEl.appendChild(fragment);
  }

  // Renders ALL metadata keys (not just a fixed subset)
  function renderMetadataTable(metadata) {
    if (!metadata || typeof metadata !== "object") {
      return "";
    }

    const keys = Object.keys(metadata);
    if (keys.length === 0) {
      return "";
    }

    // Sort keys: known "primary" ones first, then the rest alphabetically
    const primary = ["Make", "Model", "LensModel", "CreateDate", "ISO", "FNumber", "ExposureTime"];
    const sorted = [
      ...primary.filter((k) => Object.prototype.hasOwnProperty.call(metadata, k)),
      ...keys
        .filter((k) => !primary.includes(k))
        .sort((a, b) => a.localeCompare(b)),
    ];

    const rows = sorted.map(
      (key) =>
        `<tr><th>${key}</th><td>${String(metadata[key])}</td></tr>`
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
        chips.push(`Modello AI: ${data.ai_description.model}`);
      }
      if (data.ai_description && data.ai_description.language) {
        chips.push(`Lingua: ${data.ai_description.language}`);
      }
      if (data.size_bytes != null) {
        chips.push(`${(data.size_bytes / (1024 * 1024)).toFixed(1)} MB`);
      }

      const metaTable = renderMetadataTable(data.metadata);

      detailContentEl.innerHTML = `
        <img class="detail-image" src="${data.file_url}" alt="${data.filename}" />
        <h2 class="detail-title">${data.title || data.filename}</h2>
        <p class="detail-path">${data.absolute_path}</p>

        ${
          chips.length
            ? `<div class="chip-row">${chips
                .map((c) => `<span class="chip">${c}</span>`)
                .join("")}</div>`
            : ""
        }

        <h3 class="detail-section-title">Descrizione AI</h3>
        <p class="detail-description">${
          (data.ai_description && data.ai_description.text) || "Nessuna descrizione disponibile."
        }</p>

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

  async function loadInitial() {
    try {
      const items = await fetchJSON("/media");
      renderGallery(items);
      if (items.length > 0) {
        openDetail(items[0].id);
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
    const url = q ? `/search?q=${encodeURIComponent(q)}` : "/media";
    try {
      const items = await fetchJSON(url);
      renderGallery(items);
      detailContentEl.innerHTML =
        '<p class="placeholder">Seleziona una foto per vedere i dettagli.</p>';
    } catch (err) {
      console.error(err);
    }
  });

  clearSearchBtn.addEventListener("click", async () => {
    searchInput.value = "";
    try {
      const items = await fetchJSON("/media");
      renderGallery(items);
      detailContentEl.innerHTML =
        '<p class="placeholder">Seleziona una foto per vedere i dettagli.</p>';
    } catch (err) {
      console.error(err);
    }
  });

  document.addEventListener("DOMContentLoaded", loadInitial);
})();