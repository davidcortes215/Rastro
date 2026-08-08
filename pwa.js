/* ==========================================================================
   Rastro — instalación como app
   Registra el service worker y gestiona el botón "Instalar app".
   En Android/escritorio se usa el diálogo nativo del navegador; en iPhone
   no existe ese diálogo, así que se explican los pasos.
   ========================================================================== */
(function () {
  "use strict";

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function () {
        // Sin service worker la app funciona igual, solo que no se instala.
      });
    });
  }

  var deferred = null;   // diálogo de instalación que ofrece el navegador

  function esIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      // iPad moderno se identifica como Mac con pantalla táctil
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function yaInstalada() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true;
  }
  function boton() { return document.getElementById("btn-install"); }

  function actualizarBoton() {
    var b = boton();
    if (!b) return;
    b.hidden = yaInstalada() ? true : !(deferred || esIOS());
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferred = e;
    actualizarBoton();
  });

  window.addEventListener("appinstalled", function () {
    deferred = null;
    var b = boton();
    if (b) b.hidden = true;
  });

  function instalar() {
    if (deferred) {
      deferred.prompt();
      deferred.userChoice.then(function () {
        deferred = null;
        actualizarBoton();
      });
      return;
    }
    if (esIOS()) {
      alert("Para instalar Rastro en tu iPhone:\n\n" +
            "1. Pulsa el botón Compartir (el cuadrado con la flecha hacia arriba)\n" +
            "2. Baja y elige “Añadir a pantalla de inicio”\n" +
            "3. Pulsa “Añadir”\n\n" +
            "Te quedará con su icono, como una app más.");
    }
  }

  function iniciar() {
    var b = boton();
    if (b) b.addEventListener("click", instalar);
    actualizarBoton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else { iniciar(); }
})();
