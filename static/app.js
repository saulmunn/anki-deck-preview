(function () {
  const FIELD_SEP = "\x1f";

  const byId = (id) => document.getElementById(id);
  const qs = (sel, el = document) => el.querySelector(sel);
  const qsa = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  const state = {
    db: null,
    files: {}, // path -> Uint8Array
    mediaMap: {}, // index(str) -> filename
    filenameToBlobUrl: {}, // filename -> objectURL
    cards: [],
  };

  function arrayToText(u8) {
    return new TextDecoder("utf-8").decode(u8);
  }

  function inferMime(filename) {
    const ext = (filename.split(".").pop() || "").toLowerCase();
    if (["png", "apng"].includes(ext)) return "image/png";
    if (["jpg", "jpeg", "jfif", "pjpeg", "pjp"].includes(ext))
      return "image/jpeg";
    if (ext === "gif") return "image/gif";
    if (ext === "svg") return "image/svg+xml";
    if (ext === "webp") return "image/webp";
    if (ext === "mp3") return "audio/mpeg";
    if (ext === "ogg") return "audio/ogg";
    if (ext === "wav") return "audio/wav";
    if (ext === "m4a" || ext === "aac") return "audio/aac";
    return "application/octet-stream";
  }

  function buildMediaBlobs() {
    const filenameToIndex = {}; // filename -> index str
    for (const [k, v] of Object.entries(state.mediaMap)) {
      filenameToIndex[v] = String(k);
    }

    // Build blob URLs for all media entries we can find
    Object.entries(filenameToIndex).forEach(([filename, indexStr]) => {
      const fileKeyExact = indexStr;
      let fileBytes = state.files[fileKeyExact];
      if (!fileBytes) {
        // try to find path that ends with /indexStr
        const matchKey = Object.keys(state.files).find((p) =>
          p.endsWith("/" + indexStr)
        );
        if (matchKey) fileBytes = state.files[matchKey];
      }
      if (fileBytes) {
        const blob = new Blob([fileBytes], { type: inferMime(filename) });
        const url = URL.createObjectURL(blob);
        state.filenameToBlobUrl[filename] = url;
      }
    });
  }

  function applyCloze(text, maskForQuestion) {
    const pattern = /\{\{c\d+::(.*?)(?:::(.*?))?\}\}/gs;
    return String(text || "").replace(pattern, (_, inner, hint) => {
      if (maskForQuestion) return "[… ]";
      return hint ? `${inner} (${hint})` : inner;
    });
  }

  function applySections(html, fieldsByName) {
    // Handle {{#Field}}...{{/Field}} (show if non-empty)
    // and {{^Field}}...{{/Field}} (show if empty)
    // Repeat until no change to handle nesting reasonably in simple cases
    let prev;
    do {
      prev = html;
      html = html.replace(
        /\{\{#\s*([^}]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g,
        (m, name, block) => {
          const v = fieldsByName[(name || "").trim()] || "";
          return v.trim() ? block : "";
        }
      );
      html = html.replace(
        /\{\{\^\s*([^}]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g,
        (m, name, block) => {
          const v = fieldsByName[(name || "").trim()] || "";
          return v.trim() ? "" : block;
        }
      );
    } while (html !== prev);
    return html;
  }

  function replaceFieldTags(templateHtml, fieldsByName, maskCloze) {
    let html = String(templateHtml || "");

    // Sections before inline fields
    html = applySections(html, fieldsByName);

    html = html.replace(/\{\{\s*cloze:([^}]+)\}\}/g, (_, name) => {
      const v = fieldsByName[(name || "").trim()] || "";
      return applyCloze(v, maskCloze);
    });

    html = html.replace(
      /\{\{\s*([a-zA-Z_]+):([^}]+)\}\}/g,
      (_, _filter, name) => {
        const v = fieldsByName[(name || "").trim()] || "";
        return v;
      }
    );

    html = html.replace(/\{\{\s*([^}:]+)\s*\}\}/g, (_, name) => {
      const v = fieldsByName[(name || "").trim()] || "";
      return v;
    });

    return html;
  }

  function rewriteMedia(html) {
    // [sound:filename] -> <audio>
    html = html.replace(/\[sound:([^\]]+)\]/g, (_, filename) => {
      const url = state.filenameToBlobUrl[filename] || "";
      if (!url) return "";
      return `<audio controls preload="none" src="${url}"></audio>`;
    });

    // rewrite src attributes to blob URLs if they are relative
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;

    qsa("[src]", wrapper).forEach((el) => {
      const src = el.getAttribute("src") || "";
      if (/^(?:https?:\/\/|data:|\/)/i.test(src)) return;
      const url = state.filenameToBlobUrl[src];
      if (url) el.setAttribute("src", url);
    });

    return wrapper.innerHTML;
  }

  function renderCards() {
    const cardsEl = byId("cards");
    cardsEl.innerHTML = "";

    state.cards.forEach((c) => {
      const article = document.createElement("article");
      article.className = "card";
      article.setAttribute("data-model", c.model_name || "");
      if (c.tags) article.setAttribute("data-tags", c.tags);

      article.innerHTML = `
        <div class="card-inner">
          <div class="card-face card-front">
            <div class="card-html">${rewriteMedia(c.front_html)}</div>
          </div>
          <div class="card-face card-back">
            <div class="card-html">${rewriteMedia(c.back_html)}</div>
          </div>
        </div>
        <div class="card-meta">
          <span class="badge">${c.model_name || "Model"}</span>
          ${c.tags ? `<span class="tags">${c.tags}</span>` : ""}
          <button class="flip" aria-label="Flip">Flip</button>
        </div>
      `;

      const flipBtn = qs(".flip", article);
      flipBtn.addEventListener("click", () =>
        article.classList.toggle("flipped")
      );

      cardsEl.appendChild(article);
    });

    // enable search panel
    byId("searchPanel").style.display = "";

    const search = byId("search");
    const allCards = () => qsa(".card", cardsEl);
    search.addEventListener("input", () => {
      const term = (search.value || "").trim().toLowerCase();
      allCards().forEach((card) => {
        const text = card.innerText.toLowerCase();
        card.style.display = text.includes(term) ? "" : "none";
      });
    });
  }

  function parseDeckWithDb(db) {
    // models
    const colRes = db.exec("SELECT models FROM col");
    const modelsJson =
      colRes && colRes[0] && colRes[0].values && colRes[0].values[0]
        ? colRes[0].values[0][0]
        : "{}";
    const models = JSON.parse(modelsJson || "{}");
    const modelById = {};
    Object.values(models).forEach((m) => {
      if (!m) return;
      modelById[String(m.id)] = m;
    });

    // notes
    const notes = {};
    const notesRes = db.exec("SELECT id, mid, flds, tags FROM notes");
    if (notesRes[0]) {
      const rows = notesRes[0].values || [];
      rows.forEach((row) => {
        const [id, mid, flds, tags] = row;
        const model = modelById[String(mid)] || {};
        const fieldNames = (model.flds || []).map((f, i) =>
          f && f.name ? f.name : `Field ${i}`
        );
        const fieldValues = String(flds || "").split(FIELD_SEP);
        const byName = {};
        fieldNames.forEach(
          (name, i) =>
            (byName[name] = i < fieldValues.length ? fieldValues[i] : "")
        );
        notes[id] = { model, fields_by_name: byName, tags: tags || "" };
      });
    }

    // cards
    const cards = [];
    const cardsRes = db.exec(
      "SELECT id, nid, ord, did FROM cards ORDER BY nid, ord"
    );
    if (cardsRes[0]) {
      (cardsRes[0].values || []).forEach((row) => {
        const [id, nid, ord, did] = row;
        const note = notes[nid];
        if (!note) return;
        const model = note.model || {};
        const templates = model.tmpls || [];
        const ordIndex = Number(ord) || 0;
        const template = templates[ordIndex];
        if (!template) return;
        const qfmt = template.qfmt || "";
        const afmt = template.afmt || "";
        const isCloze = model.type === 1;
        const front = replaceFieldTags(qfmt, note.fields_by_name, isCloze);
        let back = replaceFieldTags(afmt, note.fields_by_name, false);
        // Handle {{FrontSide}} on the back
        back = back.replace(/\{\{\s*FrontSide\s*\}\}/g, front);
        cards.push({
          id,
          note_id: nid,
          ord: ordIndex,
          deck_id: did,
          model_name: model.name || "Model",
          front_html: front,
          back_html: back,
          tags: note.tags || "",
        });
      });
    }

    state.cards = cards;
  }

  function summarize() {
    const el = byId("summary");
    el.style.display = "";
    el.innerHTML = `<strong>Loaded:</strong> ${state.cards.length} cards`;
  }

  async function maybeDecompressIfAnki21b(bytes) {
    // Detect zstd magic: 0x28 B5 2F FD at start
    if (bytes && bytes.length >= 4) {
      if (
        bytes[0] === 0x28 &&
        bytes[1] === 0xb5 &&
        bytes[2] === 0x2f &&
        bytes[3] === 0xfd
      ) {
        if (typeof ZstdCodec === "undefined") return bytes; // library not loaded
        await new Promise((resolve) => ZstdCodec.run(resolve));
        const simple = new ZstdCodec.Simple();
        const out = simple.decompress(bytes);
        return out;
      }
    }
    return bytes;
  }

  async function onLoadClicked() {
    const fileInput = byId("file");
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      alert("Please choose a .apkg file");
      return;
    }

    // Read file
    const buf = await file.arrayBuffer();

    // Unzip
    const u8 = new Uint8Array(buf);
    const files = fflate.unzipSync(u8);
    state.files = files;

    // Read media mapping
    let mediaJson = {};
    if (files["media"]) {
      try {
        mediaJson = JSON.parse(arrayToText(files["media"]));
      } catch (e) {}
    } else {
      // try any path ending with '/media'
      const key = Object.keys(files).find((k) => k.endsWith("/media"));
      if (key) {
        try {
          mediaJson = JSON.parse(arrayToText(files[key]));
        } catch (e) {}
      }
    }
    state.mediaMap = mediaJson || {};

    // Build blob URLs for media
    buildMediaBlobs();

    // Find collection file
    let collectionKey = [
      "collection.anki21",
      "collection.anki2",
      "collection.anki21b",
    ].find((k) => files[k]);
    if (!collectionKey) {
      const key21b = Object.keys(files).find((k) =>
        k.endsWith("/collection.anki21b")
      );
      const key21 = Object.keys(files).find((k) =>
        k.endsWith("/collection.anki21")
      );
      const key2 = Object.keys(files).find((k) =>
        k.endsWith("/collection.anki2")
      );
      collectionKey = key21b || key21 || key2;
    }
    if (!collectionKey) {
      alert("Could not find collection.anki2/anki21/anki21b in the archive");
      return;
    }

    // Prepare DB bytes, handling zstd if needed
    let dbBytes = files[collectionKey];
    dbBytes = await maybeDecompressIfAnki21b(dbBytes);

    // Init sql.js
    const SQL = await initSqlJs({
      locateFile: (f) =>
        `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`,
    });
    const db = new SQL.Database(dbBytes);
    state.db = db;

    // Parse DB -> cards
    parseDeckWithDb(db);

    // Render
    summarize();
    renderCards();
  }

  function init() {
    byId("loadBtn").addEventListener("click", onLoadClicked);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
