/* ==========================================================================
   Rastro — lógica de la aplicación
   Dos modos de vista:
     · "mine" → tus puntos guardados (persisten en Store, ver store.js).
     · "all"  → sitios de OpenStreetMap en la zona visible (Overpass API),
                que puedes guardar en los tuyos con un clic.
   Configuración y marca en config.js. Mapa con Leaflet.
   ========================================================================== */
(function () {
  "use strict";

  var CFG = window.APP_CONFIG;
  var CATEGORIES = CFG.categories;
  var CAT_BY_ID = {};
  CATEGORIES.forEach(function (c) { CAT_BY_ID[c.id] = c; });
  function cat(id) { return CAT_BY_ID[id] || CAT_BY_ID.otro || CATEGORIES[CATEGORIES.length - 1]; }
  var DEFAULT_STATUS = (CFG.statuses[0] && CFG.statuses[0].id) || "visitado";
  var DISCOVER = CFG.discover || { enabled: false };

  // --- Estado -------------------------------------------------------------
  var points = [];          // tus puntos (owned), fuente de verdad: Store
  var discovered = [];       // sitios de OSM en la zona (transitorios)
  var viewMode = "mine";     // "mine" | "all"
  var map, markersLayer, markerById = {}, tileLayer = null, currentStyleId = null;
  var addMode = false;
  var editingId = null;
  var draft = null;
  var draftStars = 0;
  var draftStatus = DEFAULT_STATUS;

  var filters = { text: "", cats: {}, rating: 0, status: "todos" };
  CATEGORIES.forEach(function (c) { filters.cats[c.id] = true; });

  // --- Utilidades ---------------------------------------------------------
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function uid() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function starsText(n) { n = n || 0; return "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n); }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function statusLabel(id) {
    var s = CFG.statuses.filter(function (x) { return x.id === id; })[0];
    return s ? s.label : id;
  }

  var toastTimer;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // --- Configuración / marca ----------------------------------------------
  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [234, 115, 23];
  }
  function applyConfig() {
    var root = document.documentElement;
    var acc = CFG.accent || "#EA7317";
    var rgb = hexToRgb(acc);
    root.style.setProperty("--accent", acc);
    root.style.setProperty("--accent-weak", "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ",0.12)");
    root.style.setProperty("--accent-weak-2", "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ",0.24)");
    document.title = CFG.name;
    $("#brand-name").textContent = CFG.name;
    var mh = $("#panel-mhead-title");
    if (mh) mh.textContent = CFG.name;
    var ab = $("#auth-brand-name");
    if (ab) ab.textContent = CFG.name;
    if (!CFG.map.geocode || !CFG.map.geocode.enabled) $("#geosearch").hidden = true;
    if (!DISCOVER.enabled) $("#mode-toggle").hidden = true;
  }

  // --- Iconos -------------------------------------------------------------
  function makeIcon(p) { // pin (tus puntos)
    var c = cat(p.cat);
    var pending = p.status === "pendiente" ? " is-pending" : "";
    return L.divIcon({
      className: "",
      html: '<div class="poi-pin' + pending + '" style="background:' + c.color + '">' +
            '<span>' + c.emoji + "</span></div>",
      iconSize: [30, 30], iconAnchor: [15, 28], popupAnchor: [0, -26]
    });
  }
  function makeDot(p) { // círculo (sitios descubiertos)
    var c = cat(p.cat);
    return L.divIcon({
      className: "",
      html: '<div class="poi-dot" style="background:' + c.color + '"><span>' + c.emoji + "</span></div>",
      iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12]
    });
  }

  // --- Mapa ---------------------------------------------------------------
  function mapStyles() {
    if (CFG.map.styles && CFG.map.styles.length) return CFG.map.styles;
    // Compatibilidad con configuraciones antiguas que solo tenían "tiles".
    var t = CFG.map.tiles || {};
    return [{ id: "base", label: "Mapa", url: t.url, maxZoom: t.maxZoom, attribution: t.attribution }];
  }
  function styleStorageKey() { return (CFG.storageKey || "rastro") + ":estilo"; }
  function savedStyleId() {
    try { return localStorage.getItem(styleStorageKey()); } catch (e) { return null; }
  }
  function applyMapStyle(id) {
    var list = mapStyles();
    var st = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { st = list[i]; break; }
    if (!st) st = list[0];
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(st.url, {
      maxZoom: st.maxZoom || 19,
      subdomains: st.subdomains || "abc",
      detectRetina: !!st.retina,
      attribution: st.attribution || ""
    }).addTo(map);
    if (tileLayer.bringToBack) tileLayer.bringToBack();
    if (map.setMaxZoom) map.setMaxZoom(st.maxZoom || 19);
    currentStyleId = st.id;
    try { localStorage.setItem(styleStorageKey(), st.id); } catch (e) {}
    updateStyleUI();
  }
  function buildStyleControl() {
    var list = mapStyles();
    var box = $("#map-styles");
    if (!box) return;
    if (list.length < 2) { box.hidden = true; return; }
    var ul = $("#map-styles-list");
    ul.innerHTML = "";
    list.forEach(function (st) {
      var b = el("button", "map-style-opt", st.label);
      b.type = "button"; b.dataset.style = st.id;
      b.addEventListener("click", function () {
        applyMapStyle(st.id);
        ul.hidden = true;
        $("#map-styles-toggle").setAttribute("aria-expanded", "false");
      });
      ul.appendChild(b);
    });
    $("#map-styles-toggle").addEventListener("click", function () {
      var open = ul.hidden;
      ul.hidden = !open;
      this.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", function (e) {
      if (!box.contains(e.target)) {
        ul.hidden = true;
        $("#map-styles-toggle").setAttribute("aria-expanded", "false");
      }
    });
  }
  function updateStyleUI() {
    document.querySelectorAll("#map-styles-list .map-style-opt").forEach(function (b) {
      b.classList.toggle("is-on", b.dataset.style === currentStyleId);
    });
  }

  function initMap() {
    var m = CFG.map;
    map = L.map("map", { zoomControl: true }).setView(m.center, m.zoom);
    buildStyleControl();
    applyMapStyle(savedStyleId() || m.defaultStyle || mapStyles()[0].id);
    markersLayer = L.layerGroup().addTo(map);

    map.on("click", function (e) {
      if (addMode) { openEditor(null, e.latlng.lat, e.latlng.lng); setAddMode(false); }
    });
    map.on("moveend", function () { if (viewMode === "all") scheduleDiscover(); });

    if (m.tryGeolocateOnLoad && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function (pos) {
        map.setView([pos.coords.latitude, pos.coords.longitude], 13, { animate: true });
      }, function () {}, { enableHighAccuracy: false, timeout: 6000, maximumAge: 600000 });
    }
  }

  // --- Conjunto activo ----------------------------------------------------
  function activeSet() { return viewMode === "mine" ? points : discovered; }
  function itemById(id) {
    var set = activeSet();
    for (var i = 0; i < set.length; i++) if (set[i].id === id) return set[i];
    return null;
  }

  function filteredItems() {
    var txt = filters.text.trim().toLowerCase();
    var all = viewMode === "all";
    return activeSet().filter(function (p) {
      if (!filters.cats[p.cat]) return false;
      if (!all) { // los filtros de valoración/estado solo aplican a tus puntos
        if (filters.rating > 0 && (p.stars || 0) < filters.rating) return false;
        if (filters.status !== "todos" && p.status !== filters.status) return false;
      }
      if (txt) {
        var hay = (p.name + " " + (p.notes || "") + " " + cat(p.cat).label).toLowerCase();
        if (hay.indexOf(txt) === -1) return false;
      }
      return true;
    });
  }
  function filtersActive() {
    if (filters.text) return true;
    if (viewMode === "mine" && (filters.rating > 0 || filters.status !== "todos")) return true;
    return CATEGORIES.some(function (c) { return !filters.cats[c.id]; });
  }

  // --- Marcadores ---------------------------------------------------------
  function renderMarkers() {
    markersLayer.clearLayers();
    markerById = {};
    var mine = viewMode === "mine";
    filteredItems().forEach(function (p) {
      var mk = L.marker([p.lat, p.lng], { icon: mine ? makeIcon(p) : makeDot(p), title: p.name });
      mk.bindPopup(popupHtml(p), { closeButton: true });
      mk.on("popupopen", function () { wirePopup(p.id); highlightCard(p.id); });
      mk.addTo(markersLayer);
      markerById[p.id] = mk;
    });
  }
  function popupHtml(p) {
    var c = cat(p.cat);
    if (p.osm) {
      return '<div class="popup" data-id="' + p.id + '">' +
        '<div class="popup-name">' + escapeHtml(p.name) + "</div>" +
        '<div class="popup-meta">' + escapeHtml(c.label) + " · OpenStreetMap</div>" +
        '<div class="popup-actions">' +
          '<button type="button" data-act="save">＋ Guardar en mis puntos</button>' +
        "</div></div>";
    }
    var meta = c.label + (p.status === "pendiente" ? " · " + statusLabel("pendiente").toLowerCase() : "");
    var stars = (p.status === "pendiente" && !p.stars) ? "" :
      '<span class="popup-stars">' + starsText(p.stars) + "</span> ";
    var notes = p.notes ? '<div class="popup-notes">' + escapeHtml(p.notes) + "</div>" : "";
    var fotos = "";
    if (p.photos && p.photos.length) {
      fotos = '<div class="popup-photos">' + p.photos.map(function (ph) {
        return '<img src="' + escapeHtml(ph.url) + '" alt="" loading="lazy">';
      }).join("") + "</div>";
    }
    return '<div class="popup" data-id="' + p.id + '">' +
      '<div class="popup-name">' + escapeHtml(p.name) + "</div>" +
      '<div class="popup-meta">' + stars + escapeHtml(meta) + "</div>" +
      fotos +
      notes +
      '<div class="popup-actions">' +
        '<button type="button" data-act="edit">Editar</button>' +
        '<button type="button" data-act="delete">Eliminar</button>' +
      "</div></div>";
  }
  function wirePopup(id) {
    var node = document.querySelector('.popup[data-id="' + id + '"]');
    if (!node) return;
    var p = itemById(id);
    if (!p) return;
    if (p.osm) {
      node.querySelector('[data-act="save"]').onclick = function () {
        map.closePopup();
        openEditor(null, p.lat, p.lng, { name: p.name, cat: p.cat });
      };
      return;
    }
    node.querySelector('[data-act="edit"]').onclick = function () {
      map.closePopup(); openEditor(p.id, p.lat, p.lng);
    };
    node.querySelector('[data-act="delete"]').onclick = function () {
      if (confirm("¿Eliminar este punto?")) deletePoint(id);
    };
  }

  // --- Lista --------------------------------------------------------------
  function renderList() {
    var ul = $("#poi-list");
    ul.innerHTML = "";
    var visible = filteredItems().slice().sort(function (a, b) {
      return (b.stars || 0) - (a.stars || 0) || a.name.localeCompare(b.name);
    });
    $("#count-visible").textContent = visible.length;
    $("#count-total").textContent = activeSet().length;
    $("#btn-reset-filters").hidden = !filtersActive();

    if (activeSet().length === 0) {
      if (viewMode === "mine") {
        ul.appendChild(emptyState("Aún no tienes puntos.",
          "Pulsa “Añadir” y toca el mapa, o usa el modo “Todos” para descubrir sitios."));
      } else {
        ul.appendChild(emptyState("Sin sitios en esta zona.",
          "Acércate o mueve el mapa para buscar en otra zona."));
      }
      return;
    }
    if (visible.length === 0) { ul.appendChild(emptyState("Nada coincide con los filtros.", "")); return; }

    visible.forEach(function (p) {
      var c = cat(p.cat);
      var li = el("li", "poi-card"); li.dataset.id = p.id;
      var top = el("div", "poi-card-top");
      var icon = el("span", "poi-card-icon"); icon.style.background = c.color; icon.textContent = c.emoji;
      top.appendChild(icon);
      top.appendChild(el("span", "poi-card-name", p.name));
      if (p.photos && p.photos.length) {
        var mini = document.createElement("img");
        mini.className = "poi-card-photo";
        mini.src = p.photos[0].url; mini.alt = ""; mini.loading = "lazy";
        top.appendChild(mini);
      }
      li.appendChild(top);
      var meta = el("div", "poi-card-meta");
      if (p.osm) {
        meta.appendChild(el("span", "poi-card-cat", c.label));
      } else if (p.status === "pendiente" && !p.stars) {
        meta.appendChild(el("span", "poi-card-pend", statusLabel("pendiente")));
        meta.appendChild(el("span", "poi-card-cat", c.label));
      } else {
        meta.appendChild(el("span", "poi-card-stars", starsText(p.stars)));
        meta.appendChild(el("span", "poi-card-cat", c.label));
      }
      li.appendChild(meta);
      if (p.notes) li.appendChild(el("div", "poi-card-notes", p.notes));
      li.addEventListener("click", function () { focusItem(p.id); });
      ul.appendChild(li);
    });
  }
  function emptyState(title, sub) {
    var d = el("div", "poi-empty");
    d.appendChild(el("div", null, title));
    if (sub) { var s = el("div", null, sub); s.style.marginTop = "0.4rem"; d.appendChild(s); }
    var li = el("li"); li.appendChild(d); return li;
  }
  function highlightCard(id) {
    document.querySelectorAll(".poi-card").forEach(function (c) {
      c.classList.toggle("is-active", c.dataset.id === id);
    });
  }
  function focusItem(id) {
    var p = itemById(id); if (!p) return;
    map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15), { animate: true });
    var mk = markerById[id]; if (mk) mk.openPopup();
    highlightCard(id);
    if (window.innerWidth <= 720) setPanelHidden(true);
  }

  // --- CRUD (tus puntos) --------------------------------------------------
  function pointById(id) {
    for (var i = 0; i < points.length; i++) if (points[i].id === id) return points[i];
    return null;
  }
  function deletePoint(id) {
    var p = pointById(id);
    var fotos = (p && p.photos) || [];
    Store.remove(id).then(function () {
      points = points.filter(function (x) { return x.id !== id; });
      refresh(); toast("Punto eliminado.");
      // Las fotos se borran después: si alguna falla, el punto ya no está.
      if (Store.deletePhoto) fotos.forEach(function (ph) { Store.deletePhoto(ph); });
    }).catch(function () { toast("No se pudo eliminar."); });
  }

  // --- Fotos ---------------------------------------------------------------
  var PHOTOS = CFG.photos || { enabled: false };
  var draftPhotos = [];       // fotos del punto que se está editando
  var initialPhotos = [];     // las que ya tenía al abrir el editor
  var photosBusy = 0;

  // Las fotos de móvil pesan varios MB: se reescalan y recomprimen en el
  // propio navegador antes de subirlas (quedan en torno a 150 KB).
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) { reject(new Error("no-imagen")); return; }
      var maxSize = PHOTOS.maxSize || 1600;
      var quality = PHOTOS.quality || 0.72;
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, maxSize / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement("canvas");
        canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch); // evita fondo negro en PNG con transparencia
        ctx.drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) {
          blob ? resolve(blob) : reject(new Error("compresion"));
        }, "image/jpeg", quality);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("carga")); };
      img.src = url;
    });
  }

  function renderDraftPhotos() {
    var box = $("#poi-photos");
    if (!box) return;
    box.innerHTML = "";
    draftPhotos.forEach(function (ph, i) {
      var fig = el("div", "photo-thumb");
      var im = document.createElement("img");
      im.src = ph.url; im.alt = "Foto " + (i + 1); im.loading = "lazy";
      fig.appendChild(im);
      var del = el("button", "photo-del", "×");
      del.type = "button";
      del.title = "Quitar foto";
      del.setAttribute("aria-label", "Quitar foto " + (i + 1));
      del.addEventListener("click", function () {
        var removed = draftPhotos.splice(i, 1)[0];
        if (removed && removed.path && Store.deletePhoto) Store.deletePhoto(removed);
        renderDraftPhotos();
      });
      fig.appendChild(del);
      box.appendChild(fig);
    });
    var max = PHOTOS.maxPerPoint || 6;
    $("#poi-photo-add").hidden = draftPhotos.length >= max;
    $("#poi-photo-count").textContent = draftPhotos.length
      ? draftPhotos.length + " de " + max : "";
  }

  function addPhotoFiles(files) {
    var max = PHOTOS.maxPerPoint || 6;
    var list = Array.prototype.slice.call(files);
    if (!list.length) return;
    var libres = max - draftPhotos.length;
    if (libres <= 0) { toast("Máximo " + max + " fotos por punto."); return; }
    if (list.length > libres) { list = list.slice(0, libres); toast("Solo caben " + libres + " fotos más."); }

    photosBusy += list.length;
    updatePhotoBusy();
    list.forEach(function (file) {
      compressImage(file)
        .then(function (blob) { return Store.uploadPhoto(blob, editingId || draftId()); })
        .then(function (photo) {
          draftPhotos.push(photo);
          renderDraftPhotos();
        })
        .catch(function (err) {
          if (window.console) console.warn("[Rastro] foto:", err);
          toast("No se pudo añadir una foto.");
        })
        .then(function () { photosBusy--; updatePhotoBusy(); });
    });
  }
  function updatePhotoBusy() {
    var n = $("#poi-photo-busy");
    if (n) n.hidden = photosBusy <= 0;
    var submit = document.querySelector("#editor-form button[type=submit]");
    if (submit) submit.disabled = photosBusy > 0;
  }
  // Id provisional para agrupar las fotos de un punto aún sin guardar.
  var pendingDraftId = null;
  function draftId() {
    if (!pendingDraftId) pendingDraftId = uid();
    return pendingDraftId;
  }

  // --- Editor -------------------------------------------------------------
  function buildStarInput() {
    var box = $("#poi-stars"); box.innerHTML = "";
    for (var i = 1; i <= 5; i++) (function (val) {
      var b = el("button", "star", "★");
      b.type = "button"; b.setAttribute("role", "radio");
      b.setAttribute("aria-label", val + " estrella" + (val > 1 ? "s" : ""));
      b.addEventListener("click", function () { setStars(val); });
      box.appendChild(b);
    })(i);
  }
  function setStars(n) {
    draftStars = (draftStars === n) ? n - 1 : n; if (draftStars < 0) draftStars = 0;
    var kids = $("#poi-stars").children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle("is-on", i < draftStars);
      kids[i].setAttribute("aria-checked", (i + 1) === draftStars ? "true" : "false");
    }
  }
  function buildStatusInput() {
    var box = $("#poi-status"); box.innerHTML = "";
    CFG.statuses.forEach(function (s) {
      var b = el("button", "toggle", s.label);
      b.type = "button"; b.dataset.status = s.id; b.setAttribute("role", "radio");
      b.addEventListener("click", function () { setStatus(s.id); });
      box.appendChild(b);
    });
  }
  function setStatus(s) {
    draftStatus = s;
    document.querySelectorAll("#poi-status .toggle").forEach(function (t) {
      t.setAttribute("aria-checked", t.dataset.status === s ? "true" : "false");
    });
  }
  function openEditor(id, lat, lng, prefill) {
    editingId = id;
    var p = id ? pointById(id) : null;
    $("#editor-title").textContent = p ? "Editar punto" : "Nuevo punto";
    $("#poi-name").value = p ? p.name : (prefill && prefill.name ? prefill.name : "");
    $("#poi-cat").value = p ? p.cat : (prefill && prefill.cat ? prefill.cat : CATEGORIES[0].id);
    $("#poi-notes").value = p ? (p.notes || "") : "";
    draftStars = 0; setStars(0);
    if (p) setStars(p.stars || 0);
    setStatus(p ? (p.status || DEFAULT_STATUS) : DEFAULT_STATUS);
    draft = { lat: lat, lng: lng };
    pendingDraftId = id || null;
    draftPhotos = p && p.photos ? p.photos.slice() : [];
    initialPhotos = draftPhotos.slice();   // para poder descartar las nuevas al cancelar
    photosBusy = 0;
    if (PHOTOS.enabled) { renderDraftPhotos(); updatePhotoBusy(); }
    var pf = $("#poi-photos-field"); if (pf) pf.hidden = !PHOTOS.enabled;
    $("#poi-coords").textContent = "📍 " + lat.toFixed(5) + ", " + lng.toFixed(5);
    $("#poi-delete").hidden = !p;
    $("#editor-backdrop").hidden = false;
    $("#editor").hidden = false;
    setTimeout(function () { $("#poi-name").focus(); }, 30);
  }
  // Al cerrar sin guardar, las fotos subidas en esta sesión de edición se
  // descartan para que no queden ocupando espacio sin pertenecer a nada.
  function discardNewPhotos() {
    if (!Store.deletePhoto) return;
    var previas = {};
    initialPhotos.forEach(function (ph) { if (ph && ph.url) previas[ph.url] = true; });
    draftPhotos.forEach(function (ph) {
      if (ph && ph.path && !previas[ph.url]) Store.deletePhoto(ph);
    });
  }
  function closeEditor(saved) {
    if (!saved) discardNewPhotos();
    $("#editor").hidden = true; $("#editor-backdrop").hidden = true;
    editingId = null; draft = null;
    draftPhotos = []; initialPhotos = []; pendingDraftId = null;
  }
  function submitEditor(e) {
    e.preventDefault();
    var name = $("#poi-name").value.trim();
    if (!name) { $("#poi-name").focus(); return; }
    var data = {
      name: name, cat: $("#poi-cat").value, stars: draftStars,
      status: draftStatus, notes: $("#poi-notes").value.trim(),
      photos: draftPhotos.slice()
    };
    if (editingId) {
      var id = editingId;
      var updated = Object.assign({}, pointById(id), data); // punto completo (para la nube)
      Store.update(id, updated).then(function () {
        var p = pointById(id); if (p) Object.assign(p, data);
        refresh(); closeEditor(true); toast("Punto actualizado.");
      }).catch(function () { toast("No se pudo guardar."); });
    } else {
      // Se reutiliza el id provisional para que las fotos ya subidas queden
      // en la carpeta de este punto.
      var np = Object.assign({ id: pendingDraftId || uid(), lat: draft.lat, lng: draft.lng, created: Date.now() }, data);
      Store.create(np).then(function () {
        points.push(np);
        closeEditor(true);
        toast(viewMode === "all" ? "Guardado en tus puntos." : "Punto guardado.");
        refresh();
      }).catch(function () { toast("No se pudo guardar."); });
    }
  }

  // --- Modo añadir --------------------------------------------------------
  function setAddMode(on) {
    addMode = on;
    document.querySelector(".app").classList.toggle("adding", on);
    $("#btn-add").setAttribute("aria-pressed", on ? "true" : "false");
    $("#map-hint").hidden = !on;
    if (on && window.innerWidth <= 720) setPanelHidden(true);
  }

  // --- Panel --------------------------------------------------------------
  function setPanelHidden(hidden) {
    $("#panel").classList.toggle("is-hidden", hidden);
    var bd = $("#panel-backdrop");
    if (bd) bd.hidden = hidden || window.innerWidth > 720; // fondo solo en móvil con panel abierto
    setTimeout(function () { if (map) map.invalidateSize(); }, 260);
  }
  function togglePanel() { setPanelHidden(!$("#panel").classList.contains("is-hidden")); }

  // --- Modo de vista (Mis PDI / Todos) ------------------------------------
  function setViewMode(mode) {
    if (mode === viewMode) return;
    viewMode = mode;
    document.querySelector(".app").classList.toggle("mode-all", mode === "all");
    document.querySelectorAll("#mode-toggle .mode-btn").forEach(function (b) {
      var on = b.dataset.mode === mode;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    $("#filter-text").placeholder = mode === "all" ? "Buscar en la zona…" : "Nombre, nota, lugar…";
    $("#filter-text-label").textContent = mode === "all" ? "Buscar en la zona" : "Buscar en mis puntos";
    if (mode === "all") { refresh(); scheduleDiscover(); }
    else { setDiscoverStatus(""); refresh(); }
  }

  // --- Descubrir (Overpass) -----------------------------------------------
  // Los servidores Overpass públicos se saturan con frecuencia y responden
  // 429/504. Por eso se prueban varios en orden hasta que uno conteste.
  var discoverTimer, discoverSeq = 0;
  // Última descarga: permite reutilizar resultados al mover o acercar el mapa
  // dentro de la zona ya consultada, en vez de volver a pedirlos al servidor.
  var lastFetch = null;
  function countText(n) {
    return n ? n + (n === 1 ? " sitio" : " sitios") + " en esta zona"
             : "Sin sitios de estas categorías aquí.";
  }
  function overpassEndpoints() {
    if (DISCOVER.overpassEndpoints && DISCOVER.overpassEndpoints.length) return DISCOVER.overpassEndpoints;
    return [DISCOVER.overpassEndpoint || "https://overpass-api.de/api/interpreter"];
  }
  function setDiscoverStatus(msg, withRetry) {
    var d = $("#discover-status");
    if (!msg) { d.hidden = true; d.textContent = ""; return; }
    d.textContent = msg;
    if (withRetry) {
      var btn = el("button", "linkbtn discover-retry", "Reintentar");
      btn.type = "button";
      btn.addEventListener("click", function () { runDiscover(); });
      d.appendChild(document.createTextNode(" "));
      d.appendChild(btn);
    }
    d.hidden = false;
  }
  function scheduleDiscover() {
    clearTimeout(discoverTimer);
    discoverTimer = setTimeout(runDiscover, 450);
  }
  function selectedOsmSelectors() {
    var out = [];
    CATEGORIES.forEach(function (c) {
      if (!filters.cats[c.id]) return;
      var sels = DISCOVER.osm[c.id];
      if (sels) out = out.concat(sels);
    });
    return out;
  }
  function runDiscover() {
    if (viewMode !== "all" || !DISCOVER.enabled) return;
    if (map.getZoom() < (DISCOVER.minZoom || 12)) {
      discovered = []; renderMarkers(); renderList();
      setDiscoverStatus("Acércate para ver los sitios de la zona.");
      return;
    }
    var selectors = selectedOsmSelectors();
    if (!selectors.length) {
      discovered = []; renderMarkers(); renderList();
      setDiscoverStatus("Selecciona alguna categoría para buscar.");
      return;
    }
    var view = map.getBounds();
    var sig = selectors.join("|");
    var ttl = (DISCOVER.cacheMinutes || 10) * 60000;

    // Si la vista actual cabe dentro de lo ya descargado (y con las mismas
    // categorías), se reutiliza: instantáneo y sin molestar al servidor.
    if (lastFetch && lastFetch.sig === sig &&
        (Date.now() - lastFetch.ts) < ttl &&
        lastFetch.bounds.contains(view)) {
      discovered = lastFetch.items;
      renderMarkers(); renderList();
      setDiscoverStatus(countText(discovered.length));
      return;
    }

    // Se pide un área mayor que la visible para que los desplazamientos
    // pequeños queden cubiertos por la caché.
    var area = view.pad(DISCOVER.padding == null ? 0.35 : DISCOVER.padding);
    var bbox = area.getSouth().toFixed(5) + "," + area.getWest().toFixed(5) + "," +
               area.getNorth().toFixed(5) + "," + area.getEast().toFixed(5);
    var timeout = DISCOVER.queryTimeout || 25;
    var query = "[out:json][timeout:" + timeout + "];(";
    selectors.forEach(function (sel) { query += "nwr" + sel + "(" + bbox + ");"; });
    query += ");out center " + (DISCOVER.maxResults || 250) + ";";

    var seq = ++discoverSeq;
    var servers = overpassEndpoints();
    var lastError = "";
    setDiscoverStatus("Buscando sitios…");

    // Prueba los servidores en orden hasta que uno responda. Se distingue el
    // tipo de fallo: un 400 significa consulta mal formada (reintentar en otro
    // servidor no sirve de nada), mientras que 429/504 sí son saturación.
    function attempt(i) {
      if (seq !== discoverSeq) return;               // hay una búsqueda más nueva
      if (i >= servers.length) {
        setDiscoverStatus("No se pudieron cargar los sitios (" + (lastError || "sin respuesta") + ").", true);
        return;
      }
      if (i > 0) setDiscoverStatus("Servidor ocupado, probando otro…");

      fetch(servers[i], {
        method: "POST",
        // Formato canónico de Overpass: más compatible que enviar el texto plano.
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query)
      }).then(function (r) {
        if (!r.ok) {
          var e = new Error("HTTP " + r.status);
          e.status = r.status;
          throw e;
        }
        return r.json();
      }).then(function (data) {
        if (seq !== discoverSeq) return;
        discovered = parseOverpass(data);
        lastFetch = { sig: sig, ts: Date.now(), bounds: area, items: discovered };
        renderMarkers(); renderList();
        setDiscoverStatus(countText(discovered.length));
      }).catch(function (err) {
        lastError = err && err.status ? ("error " + err.status) : "sin conexión";
        if (window.console) console.warn("[Rastro] Overpass falló:", servers[i], lastError, err);
        if (err && err.status === 400) {           // consulta inválida: no insistir
          setDiscoverStatus("La consulta no es válida (error 400).", true);
          return;
        }
        attempt(i + 1);
      });
    }
    attempt(0);
  }
  function parseOverpass(data) {
    var out = [];
    var els = (data && data.elements) || [];
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      var lat = e.lat != null ? e.lat : (e.center && e.center.lat);
      var lng = e.lon != null ? e.lon : (e.center && e.center.lon);
      if (lat == null || lng == null) continue;
      var tags = e.tags || {};
      var name = tags.name || tags["name:es"] || "(sin nombre)";
      out.push({
        id: "osm-" + e.type + "-" + e.id,
        lat: lat, lng: lng, name: name,
        cat: osmCategoryOf(tags), osm: true
      });
    }
    return out;
  }
  function osmCategoryOf(t) {
    if (t.amenity === "restaurant") return "restaurante";
    if (t.amenity === "bar" || t.amenity === "cafe" || t.amenity === "pub") return "bar";
    if (t.tourism === "viewpoint") return "mirador";
    if (t.man_made === "lighthouse") return "faro";
    if (t.natural === "beach") return "playa";
    if (t.tourism === "camp_site") return "acampada";
    if (t.place === "town" || t.place === "village" || t.place === "hamlet") return "pueblo";
    if (t.tourism === "hotel" || t.tourism === "hostel" || t.tourism === "guest_house" ||
        t.tourism === "motel" || t.tourism === "chalet") return "alojamiento";
    if (t.historic) return "monumento";
    if (t.natural) return "naturaleza";
    return "otro";
  }

  // --- Filtros UI ---------------------------------------------------------
  function buildCategoryUI() {
    var box = $("#filter-cats");
    CATEGORIES.forEach(function (c) {
      var b = el("button", "chip"); b.type = "button"; b.dataset.cat = c.id;
      b.setAttribute("aria-pressed", "true");
      var dot = el("span", "chip-dot"); dot.style.background = c.color;
      b.appendChild(dot); b.appendChild(el("span", null, c.label));
      b.addEventListener("click", function () {
        filters.cats[c.id] = !filters.cats[c.id];
        b.setAttribute("aria-pressed", filters.cats[c.id] ? "true" : "false");
        refresh();
        if (viewMode === "all") scheduleDiscover();
      });
      box.appendChild(b);
    });
    var sel = $("#poi-cat");
    CATEGORIES.forEach(function (c) {
      var o = el("option", null, c.emoji + "  " + c.label); o.value = c.id; sel.appendChild(o);
    });
    var fs = $("#filter-status");
    CFG.statuses.forEach(function (s) {
      var o = el("option", null, s.label + "s"); o.value = s.id; fs.appendChild(o);
    });
  }
  function refresh() { renderMarkers(); renderList(); updateMapEmpty(); }

  // Aviso sobre el mapa cuando estás en "Mis PDI" y todavía no has guardado
  // nada: sin él, el mapa vacío parece un error.
  function updateMapEmpty() {
    var box = $("#map-empty");
    if (!box) return;
    if (viewMode !== "mine" || points.length > 0) { box.hidden = true; return; }
    box.innerHTML = "";
    box.appendChild(el("div", "map-empty-title", "Aún no tienes puntos guardados"));
    box.appendChild(el("div", "map-empty-sub",
      "Pulsa “+ Añadir” y toca el mapa para guardar un sitio con tu valoración y tus notas."));
    if (DISCOVER.enabled) {
      var b = el("button", "btn btn--solid map-empty-btn", "Descubrir sitios de la zona");
      b.type = "button";
      b.addEventListener("click", function () { setViewMode("all"); });
      box.appendChild(b);
    }
    box.hidden = false;
  }
  function resetFilters() {
    filters.text = ""; filters.rating = 0; filters.status = "todos";
    CATEGORIES.forEach(function (c) { filters.cats[c.id] = true; });
    $("#filter-text").value = ""; $("#filter-rating").value = "0"; $("#filter-status").value = "todos";
    document.querySelectorAll("#filter-cats .chip").forEach(function (b) { b.setAttribute("aria-pressed", "true"); });
    refresh();
    if (viewMode === "all") scheduleDiscover();
  }

  // --- Exportar / importar ------------------------------------------------
  function exportData() {
    if (points.length === 0) { toast("No hay puntos que exportar."); return; }
    var blob = new Blob([JSON.stringify(points, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = (CFG.shortName || "rastro").toLowerCase().replace(/\s+/g, "-") +
                 "-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("Exportados " + points.length + " puntos.");
  }
  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var incoming = JSON.parse(reader.result);
        if (!Array.isArray(incoming)) throw new Error("formato");
        var existing = {}; points.forEach(function (p) { existing[p.id] = true; });
        var toAdd = [], added = 0;
        incoming.forEach(function (p) {
          if (p && typeof p.lat === "number" && typeof p.lng === "number" && p.name) {
            if (!p.id || existing[p.id]) p.id = uid();
            if (!p.cat || !CAT_BY_ID[p.cat]) p.cat = (CAT_BY_ID.otro ? "otro" : CATEGORIES[0].id);
            if (!p.status) p.status = DEFAULT_STATUS;
            p.stars = Math.max(0, Math.min(5, p.stars || 0));
            delete p.osm;
            toAdd.push(p); existing[p.id] = true; added++;
          }
        });
        var merged = points.concat(toAdd);
        Store.replaceAll(merged).then(function () {
          points = merged;
          if (viewMode === "mine") refresh();
          toast("Importados " + added + " puntos.");
        }).catch(function () { toast("No se pudo importar."); });
      } catch (e) { toast("Archivo no válido."); }
    };
    reader.readAsText(file);
  }

  // --- Buscador de lugares (geocodificación) ------------------------------
  // Nominatim limita a ~1 consulta por segundo: si se le lanzan varias
  // seguidas responde con error. Por eso se espera entre pulsaciones, se
  // distingue "sin resultados" de "servicio no disponible" y hay un
  // proveedor de respaldo (Photon) cuando el principal falla o no encuentra.
  var geoTimer, geoActiveIndex = -1, geoItems = [], geoSeq = 0, geoLastQuery = "";

  function fetchNominatim(q, restrictCountry) {
    var g = CFG.map.geocode;
    var url = g.endpoint + "?format=jsonv2&limit=8&addressdetails=0" +
      (restrictCountry && g.countrycodes ? "&countrycodes=" + encodeURIComponent(g.countrycodes) : "") +
      (g.language ? "&accept-language=" + encodeURIComponent(g.language) : "") +
      "&q=" + encodeURIComponent(q);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("nominatim " + r.status);
      return r.json();
    }).then(function (list) {
      return (list || []).map(function (x) {
        return { lat: parseFloat(x.lat), lon: parseFloat(x.lon), label: x.display_name };
      });
    });
  }

  function fetchPhoton(q) {
    var g = CFG.map.geocode;
    var base = g.fallbackEndpoint || "https://photon.komoot.io/api/";
    var url = base + "?limit=8&q=" + encodeURIComponent(q);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("photon " + r.status);
      return r.json();
    }).then(function (data) {
      var feats = (data && data.features) || [];
      var cc = (g.countrycodes || "").toUpperCase();
      return feats.filter(function (f) {
        if (!f.geometry || !f.geometry.coordinates) return false;
        if (!cc) return true;
        var c = (f.properties && f.properties.countrycode) || "";
        return c.toUpperCase() === cc;
      }).map(function (f) {
        var p = f.properties || {};
        var parts = [p.name, p.city || p.county, p.state, p.country].filter(Boolean);
        return {
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          label: parts.join(", ")
        };
      });
    });
  }

  function geosearch(q) {
    var seq = ++geoSeq;
    geoLastQuery = q;
    geoMessage("Buscando…");
    fetchNominatim(q, true)
      .then(function (list) {
        if (list.length) return list;
        return fetchPhoton(q); // no encontró: probamos el de respaldo
      })
      .catch(function () {
        return fetchPhoton(q); // falló (p. ej. límite de uso): respaldo
      })
      .then(function (list) {
        if (seq !== geoSeq) return; // respuesta antigua
        showGeoResults(list || []);
      })
      .catch(function () {
        if (seq !== geoSeq) return;
        geoMessage("No se pudo buscar ahora. Inténtalo en unos segundos.");
      });
  }

  function geoMessage(msg) {
    var ul = $("#geosearch-results");
    ul.innerHTML = "";
    geoItems = []; geoActiveIndex = -1;
    ul.appendChild(el("li", "empty", msg));
    ul.hidden = false;
  }

  function showGeoResults(list) {
    var ul = $("#geosearch-results"); ul.innerHTML = "";
    geoItems = list; geoActiveIndex = -1;
    if (!list.length) {
      ul.appendChild(el("li", "empty", "Sin resultados para “" + geoLastQuery + "”"));
      ul.hidden = false; return;
    }
    list.forEach(function (item, i) {
      var li = el("li", null, item.label);
      li.addEventListener("click", function () { pickGeo(i); });
      ul.appendChild(li);
    });
    ul.hidden = false;
  }

  function pickGeo(i) {
    var item = geoItems[i]; if (!item) return;
    map.setView([item.lat, item.lon], 15, { animate: true });
    $("#geosearch-results").hidden = true; $("#geosearch-input").value = "";
    if (viewMode === "all") scheduleDiscover();
    else toast("¿Buen sitio? Pulsa “Añadir” para guardarlo.");
  }

  // --- Eventos ------------------------------------------------------------
  function wireEvents() {
    $("#btn-add").addEventListener("click", function () { setAddMode(!addMode); });
    $("#btn-cancel-add").addEventListener("click", function () { setAddMode(false); });
    $("#btn-panel").addEventListener("click", togglePanel);
    var pClose = $("#panel-close"); if (pClose) pClose.addEventListener("click", function () { setPanelHidden(true); });
    var pBack = $("#panel-backdrop"); if (pBack) pBack.addEventListener("click", function () { setPanelHidden(true); });
    $("#btn-locate").addEventListener("click", function () {
      if (!navigator.geolocation) { toast("Geolocalización no disponible."); return; }
      toast("Buscando tu ubicación…");
      navigator.geolocation.getCurrentPosition(function (pos) {
        map.setView([pos.coords.latitude, pos.coords.longitude], 14, { animate: true });
      }, function () { toast("No se pudo obtener tu ubicación."); },
      { enableHighAccuracy: true, timeout: 8000 });
    });

    document.querySelectorAll("#mode-toggle .mode-btn").forEach(function (b) {
      b.addEventListener("click", function () { setViewMode(b.dataset.mode); });
    });

    if (PHOTOS.enabled) {
      $("#poi-photo-add").addEventListener("click", function () { $("#poi-photo-input").click(); });
      $("#poi-photo-input").addEventListener("change", function () {
        if (this.files && this.files.length) addPhotoFiles(this.files);
        this.value = "";
      });
    } else {
      var pf0 = $("#poi-photos-field"); if (pf0) pf0.hidden = true;
    }

    $("#editor-form").addEventListener("submit", submitEditor);
    // Se envuelven: pasar closeEditor directamente le colaría el evento de
    // clic como argumento "saved" y no descartaría las fotos nuevas.
    $("#editor-close").addEventListener("click", function () { closeEditor(); });
    $("#poi-cancel").addEventListener("click", function () { closeEditor(); });
    $("#editor-backdrop").addEventListener("click", function () { closeEditor(); });
    $("#poi-delete").addEventListener("click", function () {
      if (editingId && confirm("¿Eliminar este punto?")) { deletePoint(editingId); closeEditor(true); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!$("#editor").hidden) closeEditor();
        else if (addMode) setAddMode(false);
      }
    });

    $("#filter-text").addEventListener("input", function () { filters.text = this.value; refresh(); });
    $("#filter-rating").addEventListener("change", function () { filters.rating = parseInt(this.value, 10) || 0; refresh(); });
    $("#filter-status").addEventListener("change", function () { filters.status = this.value; refresh(); });
    $("#btn-reset-filters").addEventListener("click", resetFilters);
    $("#cats-toggle-all").addEventListener("click", function () {
      var anyOff = CATEGORIES.some(function (c) { return !filters.cats[c.id]; });
      CATEGORIES.forEach(function (c) { filters.cats[c.id] = anyOff; });
      document.querySelectorAll("#filter-cats .chip").forEach(function (b) { b.setAttribute("aria-pressed", anyOff ? "true" : "false"); });
      refresh();
      if (viewMode === "all") scheduleDiscover();
    });

    $("#btn-export").addEventListener("click", exportData);
    $("#btn-import").addEventListener("click", function () { $("#import-file").click(); });
    $("#import-file").addEventListener("change", function () {
      if (this.files && this.files[0]) importData(this.files[0]);
      this.value = "";
    });

    if (CFG.map.geocode && CFG.map.geocode.enabled) {
      var input = $("#geosearch-input");
      input.addEventListener("input", function () {
        var q = this.value.trim();
        clearTimeout(geoTimer);
        if (q.length < 3) { $("#geosearch-results").hidden = true; return; }
        // 700 ms: respeta el límite de ~1 consulta/segundo del geocodificador.
        geoTimer = setTimeout(function () { geosearch(q); }, 700);
      });
      input.addEventListener("keydown", function (e) {
        var ul = $("#geosearch-results");
        // Enter fuerza la búsqueda ya, sin esperar, y elige si ya hay resultados.
        if (e.key === "Enter") {
          e.preventDefault();
          clearTimeout(geoTimer);
          if (geoItems.length) { pickGeo(geoActiveIndex >= 0 ? geoActiveIndex : 0); }
          else {
            var q = this.value.trim();
            if (q.length >= 2) geosearch(q);
          }
          return;
        }
        if (ul.hidden) return;
        var items = ul.querySelectorAll("li:not(.empty)");
        if (e.key === "ArrowDown") { e.preventDefault(); geoActiveIndex = Math.min(geoActiveIndex + 1, items.length - 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); geoActiveIndex = Math.max(geoActiveIndex - 1, 0); }
        else { return; }
        items.forEach(function (li, i) { li.classList.toggle("active", i === geoActiveIndex); });
      });
      document.addEventListener("click", function (e) {
        if (!$("#geosearch").contains(e.target)) $("#geosearch-results").hidden = true;
      });
      $("#geosearch").addEventListener("submit", function (e) { e.preventDefault(); });
    }
  }

  // --- Arranque -----------------------------------------------------------
  // La app no arranca sola: el controlador de sesión (cloud.js) decide cuándo,
  // según haya o no que iniciar sesión. Así funciona igual en modo local o nube.
  function start() {
    applyConfig();
    initMap();
    buildCategoryUI();
    buildStarInput();
    buildStatusInput();
    wireEvents();
    if (window.innerWidth <= 720) $("#panel").classList.add("is-hidden");
  }
  function loadPoints() {
    return Store.getAll().then(function (list) {
      points = Array.isArray(list) ? list : [];
      refresh();
    }).catch(function () { points = []; refresh(); });
  }
  function clearData() {
    points = []; discovered = []; viewMode = "mine";
    document.querySelector(".app").classList.remove("mode-all");
    refresh();
  }

  window.RastroApp = { start: start, loadPoints: loadPoints, clearData: clearData };
})();
