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
  // Las categorías de la configuración (iguales para todos) más las que cada
  // usuario crea, que son privadas de su cuenta.
  var BASE_CATEGORIES = CFG.categories;
  var customCats = [];
  var CATEGORIES = BASE_CATEGORIES.slice();
  var CAT_BY_ID = {};
  CATEGORIES.forEach(function (c) { CAT_BY_ID[c.id] = c; });
  function cat(id) { return CAT_BY_ID[id] || CAT_BY_ID.otro || CATEGORIES[CATEGORIES.length - 1]; }
  function esPropia(id) {
    return customCats.some(function (c) { return c.id === id; });
  }
  function reindexarCategorias() {
    CATEGORIES = BASE_CATEGORIES.concat(customCats);
    CAT_BY_ID = {};
    CATEGORIES.forEach(function (c) { CAT_BY_ID[c.id] = c; });
    CATEGORIES.forEach(function (c) {
      if (filters.cats[c.id] === undefined) filters.cats[c.id] = true;
    });
  }
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

  var filters = { text: "", cats: {}, rating: 0, status: "todos", lista: "todas" };
  CATEGORIES.forEach(function (c) { filters.cats[c.id] = true; });

  var sortBy = "valoracion";   // valoracion | cercania | nombre | recientes
  var userPos = null;          // última ubicación conocida del usuario

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

  // --- Distancias ----------------------------------------------------------
  // Fórmula del semiverseno: distancia en metros sobre la superficie terrestre.
  function distanciaM(lat1, lng1, lat2, lng2) {
    var R = 6371000;
    var t = Math.PI / 180;
    var dLat = (lat2 - lat1) * t, dLng = (lng2 - lng1) * t;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function formatoDistancia(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + " m";
    var km = m / 1000;
    return (km < 10 ? km.toFixed(1).replace(".", ",") : Math.round(km)) + " km";
  }
  // Referencia para medir: la ubicación del usuario y, si no la hay, el
  // centro del mapa (así la función sirve aunque no dé permiso).
  function posReferencia() {
    if (userPos) return userPos;
    if (map) { var c = map.getCenter(); return { lat: c.lat, lng: c.lng }; }
    return null;
  }
  function distanciaDe(p) {
    var ref = posReferencia();
    if (!ref) return null;
    return distanciaM(ref.lat, ref.lng, p.lat, p.lng);
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

  // --- Navegación hasta un punto -------------------------------------------
  function urlComoLlegar(p) {
    var modo = CFG.navigation || "auto";
    var esApple = modo === "apple" ||
      (modo === "auto" && /iphone|ipad|ipod|macintosh/i.test(navigator.userAgent));
    var destino = p.lat + "," + p.lng;
    var nombre = encodeURIComponent(p.name || "");
    return esApple
      ? "https://maps.apple.com/?daddr=" + destino + "&q=" + nombre
      : "https://www.google.com/maps/dir/?api=1&destination=" + destino;
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
    map.on("moveend", function () {
      if (viewMode === "all") scheduleDiscover();
      // Sin ubicación propia la referencia es el centro del mapa: al moverlo
      // cambian las distancias, así que hay que reordenar.
      if (sortBy === "cercania" && !userPos) renderList();
    });

    if (m.tryGeolocateOnLoad && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function (pos) {
        userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setView([userPos.lat, userPos.lng], 13, { animate: true });
        renderList();   // ya se pueden mostrar distancias
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
      if (!all) { // valoración, estado y listas solo aplican a tus puntos
        if (filters.rating > 0 && (p.stars || 0) < filters.rating) return false;
        if (filters.status !== "todos" && p.status !== filters.status) return false;
        if (filters.lista === "sin") { if ((p.lists || []).length) return false; }
        else if (filters.lista !== "todas") {
          if ((p.lists || []).indexOf(filters.lista) === -1) return false;
        }
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
    if (viewMode === "mine" && (filters.rating > 0 || filters.status !== "todos" || filters.lista !== "todas")) return true;
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
          '<button type="button" data-act="save">＋ Guardar</button>' +
          '<button type="button" data-act="ir">Cómo llegar</button>' +
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
        '<button type="button" data-act="ir">Cómo llegar</button>' +
        '<button type="button" data-act="edit">Editar</button>' +
        '<button type="button" data-act="delete">Eliminar</button>' +
      "</div></div>";
  }
  function wirePopup(id) {
    var node = document.querySelector('.popup[data-id="' + id + '"]');
    if (!node) return;
    var p = itemById(id);
    if (!p) return;
    var ir = node.querySelector('[data-act="ir"]');
    if (ir) ir.onclick = function () { window.open(urlComoLlegar(p), "_blank", "noopener"); };
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
    var visible = ordenar(filteredItems().slice());
    $("#count-visible").textContent = visible.length;
    $("#count-total").textContent = activeSet().length;

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
      // El contenido va en una capa que se desplaza al deslizar, dejando a la
      // vista las acciones que hay detrás.
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
      // La distancia se muestra si sabemos dónde está el usuario, o siempre
      // que se esté ordenando por cercanía (midiendo desde el centro del mapa).
      if (userPos || sortBy === "cercania") {
        var d = distanciaDe(p);
        if (d != null) meta.appendChild(el("span", "poi-card-dist", formatoDistancia(d)));
      }
      var inner = el("div", "poi-card-inner");
      inner.appendChild(top);
      inner.appendChild(meta);
      if (p.notes) inner.appendChild(el("div", "poi-card-notes", p.notes));

      // Deslizar solo tiene sentido en los puntos propios: los descubiertos
      // ni se editan ni se borran.
      if (!p.osm) {
        li.appendChild(accionDeslizar("edit", "Editar", function () {
          cerrarTarjetas(); openEditor(p.id, p.lat, p.lng);
        }));
        li.appendChild(accionDeslizar("del", "Eliminar", function () {
          cerrarTarjetas();
          if (confirm("¿Eliminar “" + p.name + "”?")) deletePoint(p.id);
        }));
      }
      li.appendChild(inner);
      if (!p.osm) activarDeslizamiento(li, inner, p.id);
      else inner.addEventListener("click", function () { focusItem(p.id); });
      ul.appendChild(li);
    });
  }
  function sortStorageKey() { return (CFG.storageKey || "rastro") + ":orden"; }

  // Al ordenar por cercanía se pide la ubicación; si no hay permiso se mide
  // desde el centro del mapa, avisando de ello.
  function pedirUbicacion() {
    if (!navigator.geolocation) {
      toast("Sin ubicación: se mide desde el centro del mapa.");
      return;
    }
    navigator.geolocation.getCurrentPosition(function (pos) {
      userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      renderList();
    }, function () {
      toast("Sin permiso de ubicación: se mide desde el centro del mapa.");
    }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  }

  function ordenar(lista) {
    if (sortBy === "cercania") {
      var ref = posReferencia();
      if (ref) {
        lista.forEach(function (p) { p._d = distanciaM(ref.lat, ref.lng, p.lat, p.lng); });
        return lista.sort(function (a, b) { return a._d - b._d; });
      }
    }
    if (sortBy === "nombre") {
      return lista.sort(function (a, b) { return a.name.localeCompare(b.name, "es"); });
    }
    if (sortBy === "recientes") {
      return lista.sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
    }
    return lista.sort(function (a, b) {   // valoración (por defecto)
      return (b.stars || 0) - (a.stars || 0) || a.name.localeCompare(b.name, "es");
    });
  }

  // --- Deslizar tarjetas para editar o eliminar ----------------------------
  var ANCHO_ACCION = 96;   // lo que se destapa al deslizar

  function accionDeslizar(tipo, texto, alPulsar) {
    var caja = el("div", "poi-card-act poi-card-act--" + tipo);
    var b = el("button", null, texto);
    b.type = "button";
    b.addEventListener("click", function (e) { e.stopPropagation(); alPulsar(); });
    caja.appendChild(b);
    return caja;
  }

  function cerrarTarjetas(excepto) {
    document.querySelectorAll(".poi-card.is-open-left, .poi-card.is-open-right")
      .forEach(function (c) {
        if (c === excepto) return;
        c.classList.remove("is-open-left", "is-open-right", "is-swiping");
        var i = c.querySelector(".poi-card-inner");
        if (i) i.style.transform = "";
      });
  }

  function activarDeslizamiento(li, inner, id) {
    var x0 = 0, y0 = 0, base = 0;
    var siguiendo = false, horizontal = false, arrastrado = false;

    li.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      x0 = e.clientX; y0 = e.clientY;
      base = li.classList.contains("is-open-left") ? -ANCHO_ACCION
           : li.classList.contains("is-open-right") ? ANCHO_ACCION : 0;
      siguiendo = true; horizontal = false; arrastrado = false;
      inner.style.transition = "none";
    });

    li.addEventListener("pointermove", function (e) {
      if (!siguiendo) return;
      var dx = e.clientX - x0, dy = e.clientY - y0;
      if (!horizontal) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        // Si el gesto es mas vertical, se deja pasar para que la lista ruede.
        if (Math.abs(dx) <= Math.abs(dy)) { siguiendo = false; inner.style.transition = ""; return; }
        horizontal = true;
        li.classList.add("is-swiping");
        if (li.setPointerCapture) { try { li.setPointerCapture(e.pointerId); } catch (err) {} }
        cerrarTarjetas(li);
      }
      arrastrado = true;
      var t = Math.max(-ANCHO_ACCION - 24, Math.min(ANCHO_ACCION + 24, base + dx));
      inner.style.transform = "translateX(" + t + "px)";
    });

    function soltar(e) {
      if (!siguiendo) return;
      siguiendo = false;
      inner.style.transition = "";
      if (!horizontal) return;
      var t = base + (e.clientX - x0);
      li.classList.remove("is-open-left", "is-open-right");
      if (t <= -ANCHO_ACCION / 2) {
        li.classList.add("is-open-left");           // queda a la vista "Eliminar"
        inner.style.transform = "translateX(-" + ANCHO_ACCION + "px)";
      } else if (t >= ANCHO_ACCION / 2) {
        li.classList.add("is-open-right");          // queda a la vista "Editar"
        inner.style.transform = "translateX(" + ANCHO_ACCION + "px)";
      } else {
        inner.style.transform = "";
      }
      // Se mantiene visible mientras la tarjeta vuelve a su sitio.
      setTimeout(function () {
        if (!li.classList.contains("is-open-left") && !li.classList.contains("is-open-right")) {
          li.classList.remove("is-swiping");
        }
      }, 240);
    }
    li.addEventListener("pointerup", soltar);
    li.addEventListener("pointercancel", soltar);

    inner.addEventListener("click", function (e) {
      // Un arrastre no debe contar como pulsacion, y con la tarjeta abierta
      // el primer toque simplemente la cierra.
      if (arrastrado) { arrastrado = false; e.stopPropagation(); return; }
      if (li.classList.contains("is-open-left") || li.classList.contains("is-open-right")) {
        e.stopPropagation(); cerrarTarjetas(); return;
      }
      focusItem(id);
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
    construirListasEditor(p && p.lists ? p.lists.slice() : []);
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
      photos: draftPhotos.slice(),
      lists: listasSeleccionadas()
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
        limpiarMarcadorBusqueda();   // ya es un punto tuyo: sobra el de búsqueda
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
  function countText(n, truncated) {
    if (!n) return "Sin sitios de estas categorías aquí.";
    return n + (n === 1 ? " sitio" : " sitios") +
      (truncated ? " · hay más, acércate para verlos" : " en esta zona");
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
    // Salvo que aquella descarga tocara el tope de resultados: en ese caso
    // solo trajo una parte de los sitios, así que al acercarse hay que
    // volver a preguntar para ver los de la zona concreta.
    if (lastFetch && lastFetch.sig === sig &&
        (Date.now() - lastFetch.ts) < ttl &&
        !lastFetch.truncated &&
        lastFetch.bounds.contains(view)) {
      discovered = lastFetch.items;
      renderMarkers(); renderList();
      setDiscoverStatus(countText(discovered.length, false));
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
        // El servidor corta en maxResults: si vino lleno, hay más sitios que
        // no han llegado y estos resultados no valen para acercarse.
        var recibidos = (data && data.elements && data.elements.length) || 0;
        var truncated = recibidos >= (DISCOVER.maxResults || 250);
        lastFetch = { sig: sig, ts: Date.now(), bounds: area, items: discovered, truncated: truncated };
        renderMarkers(); renderList();
        setDiscoverStatus(countText(discovered.length, truncated));
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
  function todasActivas() {
    return CATEGORIES.every(function (x) { return filters.cats[x.id]; });
  }
  function soloActiva(id) {
    return filters.cats[id] && CATEGORIES.every(function (x) {
      return x.id === id || !filters.cats[x.id];
    });
  }
  // Refleja el estado de los filtros en los chips y explica en el título qué
  // hará la siguiente pulsación.
  function sincronizarChips() {
    var todas = todasActivas();
    document.querySelectorAll("#filter-cats .chip").forEach(function (b) {
      var id = b.dataset.cat;
      var activa = !!filters.cats[id];
      b.setAttribute("aria-pressed", activa ? "true" : "false");
      var etiqueta = (CAT_BY_ID[id] || {}).label || id;
      b.title = todas ? "Ver solo " + etiqueta
              : soloActiva(id) ? "Ver todas las categorías"
              : (activa ? "Ocultar " + etiqueta : "Mostrar " + etiqueta);
    });
  }

  // --- Categorías propias del usuario --------------------------------------
  function cargarCategoriasPropias() {
    if (!Store.getSettings) { reindexarCategorias(); return Promise.resolve(); }
    return Store.getSettings().then(function (ajustes) {
      var lista = (ajustes && ajustes.categorias) || [];
      listas = ((ajustes && ajustes.listas) || []).filter(function (l) { return l && l.id && l.nombre; })
        .map(function (l) { return { id: l.id, nombre: l.nombre }; });
      customCats = lista.filter(function (c) {
        return c && c.id && c.label;
      }).map(function (c) {
        return { id: c.id, label: c.label, emoji: c.emoji || "📍", color: c.color || "#616161", propia: true };
      });
      reindexarCategorias();
    }).catch(function () { reindexarCategorias(); });
  }
  function guardarCategoriasPropias() {
    if (!Store.getSettings) return Promise.resolve();
    return Store.getSettings().then(function (ajustes) {
      ajustes = ajustes || {};
      ajustes.categorias = customCats.map(function (c) {
        return { id: c.id, label: c.label, emoji: c.emoji, color: c.color };
      });
      return Store.saveSettings(ajustes);
    });
  }
  // Reconstruye todo lo que depende de la lista de categorías.
  function refrescarCategorias() {
    reindexarCategorias();
    construirChips();
    construirSelectorCategoria();
    sincronizarChips();
    refresh();
  }

  function construirChips() {
    var box = $("#filter-cats");
    box.innerHTML = "";
    CATEGORIES.forEach(function (c) {
      var b = el("button", "chip"); b.type = "button"; b.dataset.cat = c.id;
      b.setAttribute("aria-pressed", filters.cats[c.id] ? "true" : "false");
      var dot = el("span", "chip-dot"); dot.style.background = c.color;
      b.appendChild(dot); b.appendChild(el("span", null, c.label));
      b.addEventListener("click", function () {
        // Con todas encendidas, pulsar una deja solo esa (lo habitual es
        // querer ver una categoría suelta, no apagar las demás una a una).
        // Y si ya era la única, se vuelven a encender todas.
        if (todasActivas()) {
          CATEGORIES.forEach(function (x) { filters.cats[x.id] = (x.id === c.id); });
        } else if (soloActiva(c.id)) {
          CATEGORIES.forEach(function (x) { filters.cats[x.id] = true; });
        } else {
          filters.cats[c.id] = !filters.cats[c.id];
        }
        sincronizarChips();
        refresh();
        if (viewMode === "all") scheduleDiscover();
      });
      box.appendChild(b);
    });
  }
  function construirSelectorCategoria() {
    var sel = $("#poi-cat");
    var previo = sel.value;
    sel.innerHTML = "";
    CATEGORIES.forEach(function (c) {
      var o = el("option", null, c.emoji + "  " + c.label); o.value = c.id; sel.appendChild(o);
    });
    if (previo && CAT_BY_ID[previo]) sel.value = previo;
  }

  // --- Hoja de filtros ------------------------------------------------------
  function abrirFiltros() {
    actualizarResultadoFiltros();
    $("#filters-backdrop").hidden = false;
    $("#filters-sheet").hidden = false;
  }
  function cerrarFiltros() {
    $("#filters-sheet").hidden = true;
    $("#filters-backdrop").hidden = true;
  }
  // Cuántos filtros hay puestos: sirve para la insignia del botón. La búsqueda
  // por texto no cuenta, porque se ve escrita en su propio campo.
  function filtrosPuestos() {
    var n = 0;
    if (CATEGORIES.some(function (c) { return !filters.cats[c.id]; })) n++;
    if (filters.rating > 0) n++;
    if (viewMode === "mine") {
      if (filters.status !== "todos") n++;
      if (filters.lista !== "todas") n++;
    }
    return n;
  }
  function actualizarBotonFiltros() {
    var n = filtrosPuestos();
    var b = $("#btn-filters"), ins = $("#filters-count");
    b.classList.toggle("has-filters", n > 0);
    ins.hidden = n === 0;
    ins.textContent = String(n);
    b.setAttribute("aria-label", n ? "Filtros, " + n + " puestos" : "Filtros");
    $("#btn-reset-filters").hidden = n === 0 && !filters.text;
    actualizarResultadoFiltros();
  }
  function actualizarResultadoFiltros() {
    var r = $("#filters-result");
    if (r) r.textContent = String(filteredItems().length);
  }

  // --- Resumen -------------------------------------------------------------
  // Cada barra lleva siempre su nombre y su cifra escritos: el color repite la
  // identidad que ya usa la app, pero nunca es el único modo de distinguirla
  // (con doce categorías ninguna paleta llega a ser separable por color).
  function fichaResumen(valor, etiqueta) {
    var d = el("div", "stat");
    d.appendChild(el("div", "stat-num", valor));
    d.appendChild(el("div", "stat-lab", etiqueta));
    return d;
  }
  function barras(titulo, filas, maximo) {
    var sec = el("section", "chart");
    sec.appendChild(el("h3", "chart-title", titulo));
    var lista = el("div", "bars");
    filas.forEach(function (f) {
      var fila = el("div", "bar-row");
      fila.title = f.etiqueta + ": " + f.valor;
      var lab = el("div", "bar-label");
      if (f.emoji) {
        var pt = el("span", "bar-dot", f.emoji);
        pt.style.background = f.color;
        lab.appendChild(pt);
      }
      lab.appendChild(el("span", "bar-name", f.etiqueta));
      fila.appendChild(lab);
      var pista = el("div", "bar-track");
      var relleno = el("div", "bar-fill");
      relleno.style.width = Math.max(2, Math.round((f.valor / maximo) * 100)) + "%";
      relleno.style.background = f.color || "var(--accent)";
      pista.appendChild(relleno);
      fila.appendChild(pista);
      fila.appendChild(el("div", "bar-val", String(f.valor)));
      lista.appendChild(fila);
    });
    sec.appendChild(lista);
    return sec;
  }

  function abrirResumen() {
    var cuerpo = $("#stats-body");
    cuerpo.innerHTML = "";

    if (!points.length) {
      cuerpo.appendChild(emptyState("Todavía no hay nada que resumir.",
        "Guarda algunos puntos y aquí verás tus números."));
      $("#stats-backdrop").hidden = false;
      $("#stats-modal").hidden = false;
      return;
    }

    var visitados = points.filter(function (p) { return p.status !== "pendiente"; }).length;
    var pendientes = points.length - visitados;
    var fotos = points.reduce(function (n, p) { return n + ((p.photos && p.photos.length) || 0); }, 0);
    var valorados = points.filter(function (p) { return p.stars > 0; });
    var media = valorados.length
      ? (valorados.reduce(function (n, p) { return n + p.stars; }, 0) / valorados.length) : 0;
    var cincoEstrellas = points.filter(function (p) { return p.stars === 5; }).length;

    var tiles = el("div", "stats-grid");
    tiles.appendChild(fichaResumen(String(points.length), points.length === 1 ? "punto" : "puntos"));
    tiles.appendChild(fichaResumen(String(visitados), "visitados"));
    tiles.appendChild(fichaResumen(String(pendientes), "pendientes"));
    tiles.appendChild(fichaResumen(media ? media.toFixed(1).replace(".", ",") : "—", "media ★"));
    tiles.appendChild(fichaResumen(String(cincoEstrellas), "de 5 ★"));
    tiles.appendChild(fichaResumen(String(fotos), fotos === 1 ? "foto" : "fotos"));
    cuerpo.appendChild(tiles);

    // Por categoría
    var porCat = {};
    points.forEach(function (p) { porCat[p.cat] = (porCat[p.cat] || 0) + 1; });
    var filasCat = Object.keys(porCat).map(function (id) {
      var c = cat(id);
      return { etiqueta: c.label, valor: porCat[id], color: c.color, emoji: c.emoji };
    }).sort(function (a, b) { return b.valor - a.valor; });
    if (filasCat.length) {
      cuerpo.appendChild(barras("Por categoría", filasCat, filasCat[0].valor));
    }

    // Por lista
    if (listas.length) {
      var filasLista = listas.map(function (l) {
        return {
          etiqueta: l.nombre,
          valor: points.filter(function (p) { return (p.lists || []).indexOf(l.id) !== -1; }).length
        };
      }).filter(function (f) { return f.valor > 0; })
        .sort(function (a, b) { return b.valor - a.valor; });
      if (filasLista.length) {
        cuerpo.appendChild(barras("Por lista", filasLista, filasLista[0].valor));
      }
    }

    // Añadidos por mes (últimos 12), solo si hay fechas
    var conFecha = points.filter(function (p) { return p.created; });
    if (conFecha.length >= 2) {
      var meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
      var hoy = new Date();
      var claves = [], cuenta = {};
      for (var i = 11; i >= 0; i--) {
        var d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
        var k = d.getFullYear() + "-" + d.getMonth();
        claves.push({ k: k, etiqueta: meses[d.getMonth()] });
        cuenta[k] = 0;
      }
      conFecha.forEach(function (p) {
        var d = new Date(p.created);
        var k = d.getFullYear() + "-" + d.getMonth();
        if (cuenta[k] !== undefined) cuenta[k]++;
      });
      var maxMes = Math.max.apply(null, claves.map(function (c) { return cuenta[c.k]; }));
      if (maxMes > 0) {
        var sec = el("section", "chart");
        sec.appendChild(el("h3", "chart-title", "Añadidos en los últimos 12 meses"));
        var cols = el("div", "cols");
        claves.forEach(function (c) {
          var n = cuenta[c.k];
          var col = el("div", "col");
          col.title = c.etiqueta + ": " + n;
          var caja = el("div", "col-track");
          var f = el("div", "col-fill");
          f.style.height = n ? Math.max(4, Math.round((n / maxMes) * 100)) + "%" : "0";
          caja.appendChild(f);
          col.appendChild(el("div", "col-val", n ? String(n) : ""));
          col.appendChild(caja);
          col.appendChild(el("div", "col-lab", c.etiqueta));
          cols.appendChild(col);
        });
        sec.appendChild(cols);
        cuerpo.appendChild(sec);
      }
    }

    $("#stats-backdrop").hidden = false;
    $("#stats-modal").hidden = false;
  }
  function cerrarResumen() {
    $("#stats-modal").hidden = true;
    $("#stats-backdrop").hidden = true;
  }

  // --- Listas del usuario ---------------------------------------------------
  var listas = [];
  var editandoLista = null;

  function listaPorId(id) {
    for (var i = 0; i < listas.length; i++) if (listas[i].id === id) return listas[i];
    return null;
  }
  function guardarListas() {
    if (!Store.getSettings) return Promise.resolve();
    return Store.getSettings().then(function (a) {
      a = a || {};
      a.listas = listas.map(function (l) { return { id: l.id, nombre: l.nombre }; });
      return Store.saveSettings(a);
    });
  }
  function construirSelectorListas() {
    var sel = $("#filter-list");
    var previo = sel.value;
    sel.innerHTML = "";
    sel.appendChild(new Option("Todas", "todas"));
    listas.forEach(function (l) { sel.appendChild(new Option(l.nombre, l.id)); });
    if (listas.length) sel.appendChild(new Option("Sin lista", "sin"));
    sel.value = (previo && sel.querySelector('option[value="' + previo + '"]')) ? previo : "todas";
    filters.lista = sel.value;
    $("#poi-lists-field").hidden = false;
  }

  // Chips para asignar el punto a una o varias listas
  function construirListasEditor(seleccion) {
    var box = $("#poi-lists");
    box.innerHTML = "";
    if (!listas.length) {
      box.appendChild(el("span", "cats-help", "Aún no tienes listas."));
      return;
    }
    listas.forEach(function (l) {
      var b = el("button", "chip"); b.type = "button"; b.dataset.lista = l.id;
      var activa = seleccion.indexOf(l.id) !== -1;
      b.setAttribute("aria-pressed", activa ? "true" : "false");
      b.appendChild(el("span", null, l.nombre));
      b.addEventListener("click", function () {
        var on = b.getAttribute("aria-pressed") === "true";
        b.setAttribute("aria-pressed", on ? "false" : "true");
      });
      box.appendChild(b);
    });
  }
  function listasSeleccionadas() {
    var out = [];
    document.querySelectorAll("#poi-lists .chip").forEach(function (b) {
      if (b.getAttribute("aria-pressed") === "true") out.push(b.dataset.lista);
    });
    return out;
  }

  function abrirListas() {
    editandoLista = null;
    resetFormularioLista();
    pintarListas();
    $("#lists-backdrop").hidden = false;
    $("#lists-modal").hidden = false;
  }
  function cerrarListas() {
    $("#lists-modal").hidden = true;
    $("#lists-backdrop").hidden = true;
    // Si se abrió desde el editor, refrescar sus chips conservando lo marcado.
    if (!$("#editor").hidden) construirListasEditor(listasSeleccionadas());
  }
  function resetFormularioLista() {
    editandoLista = null;
    $("#list-name").value = "";
    $("#lists-form-title").textContent = "Nueva lista";
    $("#list-submit").textContent = "Añadir";
    $("#list-cancel").hidden = true;
  }
  function pintarListas() {
    var ul = $("#lists-list");
    ul.innerHTML = "";
    if (!listas.length) {
      ul.appendChild(el("li", "poi-empty", "Todavía no has creado ninguna lista."));
      return;
    }
    listas.forEach(function (l) {
      var li = el("li", "cats-item");
      li.appendChild(el("span", "cats-item-name", l.nombre));
      var usos = points.filter(function (p) { return (p.lists || []).indexOf(l.id) !== -1; }).length;
      li.appendChild(el("span", "cats-item-count", usos ? usos + "" : ""));
      var ed = el("button", "linkbtn", "Renombrar"); ed.type = "button";
      ed.addEventListener("click", function () {
        editandoLista = l.id;
        $("#list-name").value = l.nombre;
        $("#lists-form-title").textContent = "Renombrar lista";
        $("#list-submit").textContent = "Guardar";
        $("#list-cancel").hidden = false;
        $("#list-name").focus();
      });
      var bo = el("button", "linkbtn cats-del", "Borrar"); bo.type = "button";
      bo.addEventListener("click", function () { borrarLista(l.id); });
      var acc = el("span", "cats-item-actions");
      acc.appendChild(ed); acc.appendChild(bo);
      li.appendChild(acc);
      ul.appendChild(li);
    });
  }
  function borrarLista(id) {
    var afectados = points.filter(function (p) { return (p.lists || []).indexOf(id) !== -1; });
    var aviso = afectados.length
      ? "La lista tiene " + afectados.length + (afectados.length === 1 ? " punto" : " puntos") +
        ". Los puntos NO se borran, solo dejan de pertenecer a ella. ¿Continuar?"
      : "¿Borrar esta lista?";
    if (!confirm(aviso)) return;

    listas = listas.filter(function (l) { return l.id !== id; });
    var pendientes = afectados.map(function (p) {
      p.lists = (p.lists || []).filter(function (x) { return x !== id; });
      return Store.update(p.id, p);
    });
    Promise.all(pendientes).then(guardarListas).then(function () {
      construirSelectorListas();
      pintarListas();
      refresh();
      toast("Lista borrada.");
    }).catch(function () { toast("No se pudo borrar."); });
  }
  function enviarFormularioLista(e) {
    e.preventDefault();
    var nombre = $("#list-name").value.trim();
    if (!nombre) { $("#list-name").focus(); return; }
    var repetida = listas.some(function (l) {
      return l.id !== editandoLista && l.nombre.toLowerCase() === nombre.toLowerCase();
    });
    if (repetida) { toast("Ya existe una lista con ese nombre."); return; }

    var nuevaId = null;
    if (editandoLista) {
      listas.forEach(function (l) { if (l.id === editandoLista) l.nombre = nombre; });
    } else {
      nuevaId = "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      listas.push({ id: nuevaId, nombre: nombre });
    }
    var eraEdicion = !!editandoLista;
    guardarListas().then(function () {
      construirSelectorListas();
      pintarListas();
      resetFormularioLista();
      // Creada desde el editor de un punto: se marca y se vuelve al punto.
      if (nuevaId && !$("#editor").hidden) {
        var sel = listasSeleccionadas(); sel.push(nuevaId);
        construirListasEditor(sel);
        cerrarListas();
      }
      refresh();
      toast(eraEdicion ? "Lista renombrada." : "Lista creada.");
    }).catch(function () { toast("No se pudo guardar."); });
  }

  // --- Mi cuenta y privacidad ----------------------------------------------
  function abrirCuenta() {
    var s = window.RastroCuenta || {};
    $("#account-mail").textContent = s.email || "Sesión iniciada";
    var fotos = points.reduce(function (n, p) { return n + ((p.photos && p.photos.length) || 0); }, 0);
    $("#account-stats").textContent =
      points.length + (points.length === 1 ? " punto guardado" : " puntos guardados") +
      (fotos ? " · " + fotos + (fotos === 1 ? " foto" : " fotos") : "");
    $("#account-backdrop").hidden = false;
    $("#account-modal").hidden = false;
  }
  function cerrarCuenta() {
    $("#account-modal").hidden = true;
    $("#account-backdrop").hidden = true;
  }

  function textoLegal() {
    var L = CFG.legal || {};
    var quien = L.responsable ? escapeHtml(L.responsable) : "el titular de esta aplicación";
    var contacto = L.contacto
      ? '<a href="mailto:' + escapeHtml(L.contacto) + '">' + escapeHtml(L.contacto) + "</a>"
      : "el canal de contacto que se te haya facilitado";
    var donde = escapeHtml(L.ubicacionDatos || "la Unión Europea");
    return "" +
      "<h3>Quién trata tus datos</h3>" +
      "<p>El responsable del tratamiento es " + quien + ". Para cualquier consulta " +
      "sobre tus datos puedes escribir a " + contacto + ".</p>" +

      "<h3>Qué datos guardamos</h3>" +
      "<ul>" +
        "<li><b>Tu correo electrónico</b> y una versión cifrada de tu contraseña, para poder identificarte.</li>" +
        "<li><b>Los puntos que creas</b>: nombre, coordenadas, categoría, valoración, estado y tus notas.</li>" +
        "<li><b>Las fotos</b> que añadas a esos puntos.</li>" +
        "<li><b>Tu ubicación</b>, solo si das permiso, y únicamente para centrar el mapa y calcular distancias. " +
        "No se almacena ni se envía a ningún sitio: se usa en tu dispositivo y se descarta.</li>" +
      "</ul>" +

      "<h3>Para qué</h3>" +
      "<p>Únicamente para prestarte el servicio: guardar tus lugares y mostrártelos " +
      "cuando entras con tu cuenta. No se usan con fines publicitarios ni se elaboran perfiles.</p>" +

      "<h3>Quién puede verlos</h3>" +
      "<p>Tus puntos, notas, fotos y categorías son <b>privados</b>: solo los ve tu cuenta. " +
      "No se ceden a terceros ni se venden.</p>" +

      "<h3>Dónde se guardan</h3>" +
      "<p>En servidores de Supabase situados en " + donde + ". Los mapas se muestran con " +
      "OpenStreetMap y servicios asociados, que reciben las coordenadas de la zona que estás " +
      "viendo para poder dibujar el mapa.</p>" +

      "<h3>Cuánto tiempo</h3>" +
      "<p>Mientras mantengas la cuenta. Si la borras, tus datos se eliminan.</p>" +

      "<h3>Tus derechos</h3>" +
      "<p>Puedes acceder a tus datos y llevártelos en cualquier momento con <b>Exportar</b>, " +
      "corregirlos editando cada punto, y <b>borrar tu cuenta y todos tus datos</b> desde " +
      "«Mi cuenta». También puedes reclamar ante la Agencia Española de Protección de Datos " +
      "si consideras que no se respetan tus derechos.</p>" +

      "<h3>Cookies</h3>" +
      "<p>No se usan cookies publicitarias ni de seguimiento. Solo se guarda en tu navegador " +
      "lo imprescindible para mantener la sesión y tus preferencias (estilo de mapa y orden).</p>";
  }
  function abrirPrivacidad() {
    $("#privacy-body").innerHTML = textoLegal();
    $("#privacy-backdrop").hidden = false;
    $("#privacy-modal").hidden = false;
  }
  function cerrarPrivacidad() {
    $("#privacy-modal").hidden = true;
    $("#privacy-backdrop").hidden = true;
  }

  // --- Diálogo de categorías ------------------------------------------------
  var editandoCat = null;   // id de la categoría propia en edición
  var nuevaCatId = null;    // id de la última creada, para seleccionarla

  function abrirCategorias() {
    editandoCat = null;
    resetFormularioCat();
    pintarListaCategorias();
    $("#cats-backdrop").hidden = false;
    $("#cats-modal").hidden = false;
  }
  function cerrarCategorias() {
    $("#cats-modal").hidden = true;
    $("#cats-backdrop").hidden = true;
  }
  function resetFormularioCat() {
    editandoCat = null;
    $("#cat-emoji").value = "📍";
    $("#cat-color").value = "#EA7317";
    $("#cat-label").value = "";
    $("#cats-form-title").textContent = "Nueva categoría";
    $("#cat-submit").textContent = "Añadir";
    $("#cat-cancel").hidden = true;
  }
  function pintarListaCategorias() {
    var ul = $("#cats-list");
    ul.innerHTML = "";
    CATEGORIES.forEach(function (c) {
      var li = el("li", "cats-item");
      var ic = el("span", "cats-item-icon", c.emoji);
      ic.style.background = c.color;
      li.appendChild(ic);
      li.appendChild(el("span", "cats-item-name", c.label));
      var usos = points.filter(function (p) { return p.cat === c.id; }).length;
      li.appendChild(el("span", "cats-item-count", usos ? usos + "" : ""));

      if (esPropia(c.id)) {
        li.appendChild(el("span", "cats-item-tag cats-item-tag--privada", "privada"));
        var ed = el("button", "linkbtn", "Editar");
        ed.type = "button";
        ed.addEventListener("click", function () { editarCategoria(c.id); });
        var bo = el("button", "linkbtn cats-del", "Borrar");
        bo.type = "button";
        bo.addEventListener("click", function () { borrarCategoria(c.id); });
        var acc = el("span", "cats-item-actions");
        acc.appendChild(ed); acc.appendChild(bo);
        li.appendChild(acc);
      } else {
        li.appendChild(el("span", "cats-item-tag", "común"));
      }
      ul.appendChild(li);
    });
  }
  function editarCategoria(id) {
    var c = CAT_BY_ID[id];
    if (!c) return;
    editandoCat = id;
    $("#cat-emoji").value = c.emoji;
    $("#cat-color").value = /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : "#EA7317";
    $("#cat-label").value = c.label;
    $("#cats-form-title").textContent = "Editar categoría";
    $("#cat-submit").textContent = "Guardar";
    $("#cat-cancel").hidden = false;
    $("#cat-label").focus();
  }
  function borrarCategoria(id) {
    var usos = points.filter(function (p) { return p.cat === id; });
    var aviso = usos.length
      ? "Hay " + usos.length + (usos.length === 1 ? " punto" : " puntos") +
        " con esta categoría. Pasarán a “Otro”. ¿Borrarla igualmente?"
      : "¿Borrar esta categoría?";
    if (!confirm(aviso)) return;

    customCats = customCats.filter(function (c) { return c.id !== id; });
    delete filters.cats[id];

    // Los puntos afectados se reasignan para que no queden sin categoría.
    var destino = CAT_BY_ID.otro ? "otro" : BASE_CATEGORIES[0].id;
    var pendientes = usos.map(function (p) {
      p.cat = destino;
      return Store.update(p.id, p);
    });

    Promise.all(pendientes)
      .then(guardarCategoriasPropias)
      .then(function () {
        refrescarCategorias();
        pintarListaCategorias();
        toast("Categoría borrada.");
      })
      .catch(function () { toast("No se pudo borrar."); });
  }
  function enviarFormularioCat(e) {
    e.preventDefault();
    var label = $("#cat-label").value.trim();
    if (!label) { $("#cat-label").focus(); return; }
    var emoji = $("#cat-emoji").value.trim() || "📍";
    var color = $("#cat-color").value || "#EA7317";

    var repetida = CATEGORIES.some(function (c) {
      return c.id !== editandoCat && c.label.toLowerCase() === label.toLowerCase();
    });
    if (repetida) { toast("Ya existe una categoría con ese nombre."); return; }

    if (editandoCat) {
      customCats.forEach(function (c) {
        if (c.id === editandoCat) { c.label = label; c.emoji = emoji; c.color = color; }
      });
    } else {
      var max = (CFG.categoriesMax || 20);
      if (customCats.length >= max) { toast("Máximo " + max + " categorías propias."); return; }
      var id = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      customCats.push({ id: id, label: label, emoji: emoji, color: color, propia: true });
      filters.cats[id] = true;
      nuevaCatId = id;
    }

    var eraEdicion = !!editandoCat;   // resetFormularioCat lo pone a null
    guardarCategoriasPropias().then(function () {
      refrescarCategorias();
      pintarListaCategorias();
      resetFormularioCat();
      // Si se estaba registrando un punto, se deja elegida la recién creada
      // y se vuelve al punto para no perder el hilo.
      if (nuevaCatId && !$("#editor").hidden) {
        $("#poi-cat").value = nuevaCatId;
        cerrarCategorias();
      }
      nuevaCatId = null;
      toast(eraEdicion ? "Categoría guardada." : "Categoría creada.");
    }).catch(function () { toast("No se pudo guardar."); });
  }

  function buildCategoryUI() {
    construirChips();
    sincronizarChips();
    construirSelectorCategoria();
    var fs = $("#filter-status");
    CFG.statuses.forEach(function (s) {
      var o = el("option", null, s.label + "s"); o.value = s.id; fs.appendChild(o);
    });
  }
  function refresh() { renderMarkers(); renderList(); updateMapEmpty(); actualizarBotonFiltros(); }

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
    filters.text = ""; filters.rating = 0; filters.status = "todos"; filters.lista = "todas";
    CATEGORIES.forEach(function (c) { filters.cats[c.id] = true; });
    $("#filter-text").value = ""; $("#filter-rating").value = "0"; $("#filter-status").value = "todos";
    $("#filter-list").value = "todas";
    sincronizarChips();
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
        var etiquetas = {};
        if (x.category && x.type) etiquetas[x.category] = x.type;
        return {
          lat: parseFloat(x.lat), lon: parseFloat(x.lon),
          label: x.display_name,
          name: x.name || String(x.display_name || "").split(",")[0].trim(),
          cat: osmCategoryOf(etiquetas)
        };
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
        var etiquetas = {};
        if (p.osm_key && p.osm_value) etiquetas[p.osm_key] = p.osm_value;
        return {
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          label: parts.join(", "),
          name: p.name || parts[0] || "",
          cat: osmCategoryOf(etiquetas)
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

  // Marcador del sitio buscado. Va suelto sobre el mapa (no en la capa de
  // puntos) para que no lo borren los refrescos ni los filtros.
  var searchMarker = null;
  function limpiarMarcadorBusqueda() {
    if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
  }
  function marcarResultado(item) {
    limpiarMarcadorBusqueda();
    var c = cat(item.cat);
    var nombre = item.name || String(item.label || "").split(",")[0].trim();
    searchMarker = L.marker([item.lat, item.lon], {
      zIndexOffset: 1000,
      icon: L.divIcon({
        className: "",
        html: '<div class="poi-pin is-search" style="background:' + c.color + '">' +
              '<span>' + c.emoji + "</span></div>",
        iconSize: [34, 34], iconAnchor: [17, 32], popupAnchor: [0, -30]
      })
    }).addTo(map);

    searchMarker.bindPopup(
      '<div class="popup popup-search">' +
        '<div class="popup-name">' + escapeHtml(nombre) + "</div>" +
        '<div class="popup-meta">' + escapeHtml(cat(item.cat).label) + " · resultado de búsqueda</div>" +
        '<div class="popup-actions">' +
          '<button type="button" data-act="save">＋ Guardar</button>' +
          '<button type="button" data-act="ir">Cómo llegar</button>' +
          '<button type="button" data-act="close">Quitar</button>' +
        "</div></div>");

    searchMarker.on("popupopen", function () {
      var nodo = document.querySelector('.popup-search');
      if (!nodo) return;
      nodo.querySelector('[data-act="save"]').onclick = function () {
        map.closePopup();
        openEditor(null, item.lat, item.lon, { name: nombre, cat: item.cat });
      };
      nodo.querySelector('[data-act="ir"]').onclick = function () {
        window.open(urlComoLlegar({ lat: item.lat, lng: item.lon, name: nombre }), "_blank", "noopener");
      };
      nodo.querySelector('[data-act="close"]').onclick = function () {
        map.closePopup();
        limpiarMarcadorBusqueda();
      };
    });
    searchMarker.openPopup();
  }

  function pickGeo(i) {
    var item = geoItems[i]; if (!item) return;
    map.setView([item.lat, item.lon], 17, { animate: true });
    $("#geosearch-results").hidden = true; $("#geosearch-input").value = "";
    marcarResultado(item);
    if (viewMode === "all") scheduleDiscover();
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
        userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setView([userPos.lat, userPos.lng], 14, { animate: true });
        renderList();
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
        if (!$("#filters-sheet").hidden) cerrarFiltros();
        else if (!$("#stats-modal").hidden) cerrarResumen();
        else if (!$("#privacy-modal").hidden) cerrarPrivacidad();
        else if (!$("#lists-modal").hidden) cerrarListas();
        else if (!$("#account-modal").hidden) cerrarCuenta();
        else if (!$("#cats-modal").hidden) cerrarCategorias();
        else if (!$("#editor").hidden) closeEditor();
        else if (addMode) setAddMode(false);
      }
    });

    $("#filter-text").addEventListener("input", function () { filters.text = this.value; refresh(); });
    $("#filter-rating").addEventListener("change", function () { filters.rating = parseInt(this.value, 10) || 0; refresh(); });
    $("#filter-status").addEventListener("change", function () { filters.status = this.value; refresh(); });

    $("#sort-by").addEventListener("change", function () {
      sortBy = this.value;
      try { localStorage.setItem(sortStorageKey(), sortBy); } catch (e) {}
      if (sortBy === "cercania" && !userPos) pedirUbicacion();
      renderList();
    });
    $("#filter-list").addEventListener("change", function () { filters.lista = this.value; refresh(); });
    $("#lists-manage").addEventListener("click", abrirListas);
    $("#poi-list-new").addEventListener("click", abrirListas);
    $("#lists-close").addEventListener("click", cerrarListas);
    $("#lists-done").addEventListener("click", cerrarListas);
    $("#lists-backdrop").addEventListener("click", cerrarListas);
    $("#lists-form").addEventListener("submit", enviarFormularioLista);
    $("#list-cancel").addEventListener("click", resetFormularioLista);

    $("#btn-filters").addEventListener("click", abrirFiltros);
    $("#filters-close").addEventListener("click", cerrarFiltros);
    $("#filters-done").addEventListener("click", cerrarFiltros);
    $("#filters-backdrop").addEventListener("click", cerrarFiltros);

    $("#btn-stats").addEventListener("click", abrirResumen);
    $("#stats-close").addEventListener("click", cerrarResumen);
    $("#stats-done").addEventListener("click", cerrarResumen);
    $("#stats-backdrop").addEventListener("click", cerrarResumen);

    $("#btn-reset-filters").addEventListener("click", resetFilters);

    $("#btn-account").addEventListener("click", abrirCuenta);
    $("#account-close").addEventListener("click", cerrarCuenta);
    $("#account-done").addEventListener("click", cerrarCuenta);
    $("#account-backdrop").addEventListener("click", cerrarCuenta);
    $("#account-privacy").addEventListener("click", abrirPrivacidad);
    $("#auth-privacy").addEventListener("click", abrirPrivacidad);
    $("#privacy-close").addEventListener("click", cerrarPrivacidad);
    $("#privacy-done").addEventListener("click", cerrarPrivacidad);
    $("#privacy-backdrop").addEventListener("click", cerrarPrivacidad);

    $("#cats-manage").addEventListener("click", abrirCategorias);
    $("#poi-cat-new").addEventListener("click", abrirCategorias);
    $("#cats-close").addEventListener("click", cerrarCategorias);
    $("#cats-done").addEventListener("click", cerrarCategorias);
    $("#cats-backdrop").addEventListener("click", cerrarCategorias);
    $("#cats-form").addEventListener("submit", enviarFormularioCat);
    $("#cat-cancel").addEventListener("click", resetFormularioCat);
    $("#cats-toggle-all").addEventListener("click", function () {
      var anyOff = CATEGORIES.some(function (c) { return !filters.cats[c.id]; });
      CATEGORIES.forEach(function (c) { filters.cats[c.id] = anyOff; });
      sincronizarChips();
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
    try {
      var orden = localStorage.getItem(sortStorageKey());
      if (orden) { sortBy = orden; $("#sort-by").value = orden; }
    } catch (e) {}
    // Si al abrir ya está elegido "cercanía", hay que pedir la ubicación:
    // de lo contrario se mediría en silencio desde el centro del mapa.
    if (sortBy === "cercania") pedirUbicacion();
    if (window.innerWidth <= 720) $("#panel").classList.add("is-hidden");
  }
  function loadPoints() {
    // Primero las categorías propias: los puntos las necesitan para pintarse
    // con su emoji y su color.
    return cargarCategoriasPropias().then(function () {
      construirChips();
      construirSelectorCategoria();
      construirSelectorListas();
      sincronizarChips();
      return Store.getAll();
    }).then(function (list) {
      points = Array.isArray(list) ? list : [];
      refresh();
    }).catch(function () { points = []; refresh(); });
  }
  function clearData() {
    points = []; discovered = []; viewMode = "mine";
    customCats = []; listas = [];   // son privadas de cada cuenta
    filters.lista = "todas";
    reindexarCategorias();
    construirChips(); construirSelectorCategoria(); construirSelectorListas(); sincronizarChips();
    document.querySelector(".app").classList.remove("mode-all");
    refresh();
  }

  window.RastroApp = { start: start, loadPoints: loadPoints, clearData: clearData,
    cerrarCuenta: cerrarCuenta, abrirPrivacidad: abrirPrivacidad, puntos: function () { return points; } };
})();
