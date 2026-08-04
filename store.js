/* ==========================================================================
   CAPA DE DATOS — intercambiable
   Interfaz asíncrona (Promesas) que hoy guarda en localStorage y mañana
   puede guardar en un backend SIN tocar la interfaz de usuario.

   Para migrar a la nube: crea otro objeto con estos mismos métodos que use
   fetch() contra tu API y asígnalo a window.Store. Como app.js ya usa
   `await Store.*`, el resto de la aplicación no cambia.

     window.Store = {
       async getAll()            → Promise<Point[]>
       async create(point)       → Promise<Point>
       async update(id, data)    → Promise<Point|null>
       async remove(id)          → Promise<void>
       async replaceAll(points)  → Promise<void>   // usado al importar
     }
   ========================================================================== */
(function () {
  "use strict";

  function key() {
    return (window.APP_CONFIG && window.APP_CONFIG.storageKey) || "mapa-lugares:puntos:v1";
  }
  function read() {
    try {
      var raw = localStorage.getItem(key());
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function write(list) {
    try {
      localStorage.setItem(key(), JSON.stringify(list));
      return true;
    } catch (e) { return false; }
  }

  var LocalStore = {
    getAll: function () {
      return Promise.resolve(read());
    },
    create: function (point) {
      var list = read();
      list.push(point);
      if (!write(list)) return Promise.reject(new Error("storage-full"));
      return Promise.resolve(point);
    },
    update: function (id, data) {
      var list = read();
      var p = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { p = Object.assign(list[i], data); break; }
      }
      if (!write(list)) return Promise.reject(new Error("storage-full"));
      return Promise.resolve(p);
    },
    remove: function (id) {
      var list = read().filter(function (p) { return p.id !== id; });
      if (!write(list)) return Promise.reject(new Error("storage-full"));
      return Promise.resolve();
    },
    replaceAll: function (list) {
      if (!write(Array.isArray(list) ? list : [])) return Promise.reject(new Error("storage-full"));
      return Promise.resolve();
    }
  };

  window.Store = LocalStore;
})();
