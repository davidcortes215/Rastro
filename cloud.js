/* ==========================================================================
   Rastro — capa de nube (Supabase)
   Registro / inicio de sesión + almacenamiento de los puntos POR USUARIO.
   Si config.cloud.url / anonKey están vacíos, la app funciona en modo local
   (sin registro). Si están configurados, exige iniciar sesión y guarda los
   datos de cada usuario en la nube (tabla "points" con RLS).

   Implementa la misma interfaz que store.js (getAll/create/update/remove/
   replaceAll), así que el resto de la app no cambia.
   ========================================================================== */
(function () {
  "use strict";

  var CFG = window.APP_CONFIG || {};
  var cloud = CFG.cloud || {};
  var sb = null;
  var currentUserId = null;

  function cloudEnabled() {
    return !!(cloud && cloud.url && cloud.anonKey && window.supabase && window.supabase.createClient);
  }
  function q(s) { return document.querySelector(s); }

  // --- Store contra Supabase ---------------------------------------------
  function check(r) { if (r && r.error) throw r.error; return r; }
  function makeSupabaseStore() {
    return {
      getAll: function () {
        return sb.from("points").select("data").then(function (r) {
          check(r);
          return (r.data || []).map(function (x) { return x.data; });
        });
      },
      create: function (p) {
        return sb.from("points").insert({ id: p.id, user_id: currentUserId, data: p }).then(check);
      },
      update: function (id, p) {
        return sb.from("points").update({ data: p }).eq("id", id).then(check);
      },
      remove: function (id) {
        return sb.from("points").delete().eq("id", id).then(check);
      },
      replaceAll: function (list) {
        var rows = (list || []).map(function (p) {
          return { id: p.id, user_id: currentUserId, data: p };
        });
        if (!rows.length) return Promise.resolve();
        return sb.from("points").upsert(rows).then(check);
      },
      // Las fotos van a Supabase Storage, cada usuario en su propia carpeta.
      uploadPhoto: function (blob, pointId) {
        var bucket = cloud.photoBucket || "fotos";
        var path = currentUserId + "/" + (pointId || "sueltas") + "/" +
                   Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".jpg";
        return sb.storage.from(bucket).upload(path, blob, {
          contentType: "image/jpeg", upsert: false
        }).then(function (r) {
          check(r);
          var pub = sb.storage.from(bucket).getPublicUrl(path);
          return { url: pub.data.publicUrl, path: path };
        });
      },
      deletePhoto: function (photo) {
        if (!photo || !photo.path) return Promise.resolve();
        var bucket = cloud.photoBucket || "fotos";
        return sb.storage.from(bucket).remove([photo.path]).then(function () {});
      },

      // Ajustes del usuario (por ahora, sus categorías propias).
      getSettings: function () {
        return sb.from("settings").select("data").eq("user_id", currentUserId).maybeSingle()
          .then(function (r) {
            if (r && r.error && r.error.code !== "PGRST116") throw r.error;
            return (r && r.data && r.data.data) || {};
          })
          .catch(function () { return {}; });   // sin tabla o sin fila: ajustes vacíos
      },
      saveSettings: function (obj) {
        return sb.from("settings")
          .upsert({ user_id: currentUserId, data: obj || {}, updated_at: new Date().toISOString() },
                  { onConflict: "user_id" })
          .then(check);
      }
    };
  }

  // --- Interfaz de autenticación -----------------------------------------
  var mode = "signin";
  function setAuthMode(m) {
    mode = m;
    q("#auth-title").textContent = m === "signup" ? "Crear cuenta" : "Entrar";
    q("#auth-submit").textContent = m === "signup" ? "Crear cuenta" : "Entrar";
    q("#auth-switch-text").textContent = m === "signup" ? "¿Ya tienes cuenta?" : "¿No tienes cuenta?";
    q("#auth-switch-btn").textContent = m === "signup" ? "Entrar" : "Crear cuenta";
    q("#auth-password").setAttribute("autocomplete", m === "signup" ? "new-password" : "current-password");
    authError("");
  }
  function showAuth(show) { q("#auth-screen").hidden = !show; }
  function authError(msg) { q("#auth-error").textContent = msg || ""; }
  function busy(on) { q("#auth-submit").disabled = on; q("#auth-submit").textContent = on ? "Un momento…" : (mode === "signup" ? "Crear cuenta" : "Entrar"); }

  function traducirError(m) {
    m = (m || "").toLowerCase();
    if (m.indexOf("invalid login") !== -1) return "Correo o contraseña incorrectos.";
    if (m.indexOf("already registered") !== -1) return "Ese correo ya tiene cuenta. Pulsa “Entrar”.";
    if (m.indexOf("at least 6") !== -1 || (m.indexOf("password") !== -1 && m.indexOf("6") !== -1))
      return "La contraseña debe tener al menos 6 caracteres.";
    if (m.indexOf("confirm") !== -1) return "Confirma tu correo antes de entrar.";
    if (m.indexOf("rate") !== -1) return "Demasiados intentos. Espera un momento.";
    return "No se pudo: " + m;
  }

  function handleSubmit(e) {
    e.preventDefault();
    var email = q("#auth-email").value.trim();
    var pass = q("#auth-password").value;
    if (!email || !pass) { authError("Escribe correo y contraseña."); return; }
    busy(true); authError("");
    var op = mode === "signup"
      ? sb.auth.signUp({ email: email, password: pass })
      : sb.auth.signInWithPassword({ email: email, password: pass });
    op.then(function (r) {
      busy(false);
      if (r.error) { authError(traducirError(r.error.message)); return; }
      if (mode === "signup" && r.data && !r.data.session) {
        // Requiere confirmación por correo
        setAuthMode("signin");
        authError("Cuenta creada. Revisa tu correo para confirmarla y luego entra.");
        return;
      }
      // Si hay sesión, onAuthStateChange se encarga del resto.
    }).catch(function () { busy(false); authError("No se pudo conectar. Inténtalo de nuevo."); });
  }

  function onSignedIn(session) {
    var uid = session.user.id;
    var already = (currentUserId === uid && window.Store && window.Store.__cloud);
    currentUserId = uid;
    var store = makeSupabaseStore();
    store.__cloud = true;
    window.Store = store;
    showAuth(false);
    var lo = q("#btn-logout");
    if (lo) { lo.hidden = false; lo.textContent = "Cerrar sesión"; lo.title = session.user.email || ""; }
    if (!already) window.RastroApp.loadPoints();
  }
  function onSignedOut() {
    currentUserId = null;
    window.Store = window.LocalStore;
    var lo = q("#btn-logout"); if (lo) lo.hidden = true;
    window.RastroApp.clearData();
    setAuthMode("signin");
    q("#auth-email").value = ""; q("#auth-password").value = "";
    showAuth(true);
  }

  function bootCloud() {
    sb = window.supabase.createClient(cloud.url, cloud.anonKey);
    q("#auth-form").addEventListener("submit", handleSubmit);
    q("#auth-switch-btn").addEventListener("click", function () {
      setAuthMode(mode === "signup" ? "signin" : "signup");
    });
    var lo = q("#btn-logout");
    if (lo) lo.addEventListener("click", function () { sb.auth.signOut(); });
    setAuthMode("signin");
    // Reaccionar a cambios de sesión (login, logout, refresco de token).
    sb.auth.onAuthStateChange(function (_evt, session) {
      // Diferido: no conviene llamar a Supabase dentro del propio callback.
      setTimeout(function () { if (session) onSignedIn(session); else onSignedOut(); }, 0);
    });
  }

  // --- Arranque -----------------------------------------------------------
  function boot() {
    window.RastroApp.start();
    if (!cloudEnabled()) {
      // Modo local: sin registro (comportamiento anterior).
      window.Store = window.LocalStore;
      var lo = q("#btn-logout"); if (lo) lo.hidden = true;
      window.RastroApp.loadPoints();
      return;
    }
    bootCloud();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
