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
  var mode = "signin";   // signin | signup | recuperar
  var enRecuperacion = false;   // se llegó por el enlace del correo
  function setAuthMode(m) {
    mode = m;
    var recuperar = m === "recuperar";
    q("#auth-title").textContent = recuperar ? "Nueva contraseña"
      : m === "signup" ? "Crear cuenta" : "Entrar";
    q("#auth-submit").textContent = recuperar ? "Guardar contraseña"
      : m === "signup" ? "Crear cuenta" : "Entrar";
    q("#auth-sub").textContent = recuperar
      ? "Escribe la contraseña nueva para tu cuenta."
      : "Guarda y sincroniza tus lugares en tu cuenta.";
    q("#auth-switch-text").textContent = m === "signup" ? "¿Ya tienes cuenta?" : "¿No tienes cuenta?";
    q("#auth-switch-btn").textContent = m === "signup" ? "Entrar" : "Crear cuenta";
    q("#auth-password").setAttribute("autocomplete", (m === "signup" || recuperar) ? "new-password" : "current-password");
    q("#auth-password").placeholder = recuperar ? "Contraseña nueva" : "Contraseña";
    // En modo recuperar sobra todo lo demás. El correo deja de ser
    // obligatorio: oculto y obligatorio, el navegador bloquea el envío.
    q("#auth-email").hidden = recuperar;
    q("#auth-email").required = !recuperar;
    q(".auth-switch").hidden = recuperar;
    q(".auth-alt").hidden = recuperar || m === "signup";
    authError("");
  }
  function showAuth(show) { q("#auth-screen").hidden = !show; }
  function authError(msg) { q("#auth-error").textContent = msg || ""; }
  function busy(on) {
    q("#auth-submit").disabled = on;
    q("#auth-submit").textContent = on ? "Un momento…"
      : mode === "recuperar" ? "Guardar contraseña"
      : mode === "signup" ? "Crear cuenta" : "Entrar";
  }

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

  function recuperarContrasena() {
    var email = q("#auth-email").value.trim();
    if (!email) { authError("Escribe tu correo y vuelve a pulsar."); q("#auth-email").focus(); return; }
    busy(true); authError("");
    var destino = window.location.href.split("#")[0];
    sb.auth.resetPasswordForEmail(email, { redirectTo: destino }).then(function (r) {
      busy(false);
      if (r.error) { authError(traducirError(r.error.message)); return; }
      authError("Te hemos enviado un correo para cambiar la contraseña. Revisa tu bandeja.");
    }).catch(function () { busy(false); authError("No se pudo enviar el correo."); });
  }

  function handleSubmit(e) {
    e.preventDefault();
    var email = q("#auth-email").value.trim();
    var pass = q("#auth-password").value;

    if (mode === "recuperar") {
      if (!pass) { authError("Escribe la contraseña nueva."); return; }
      busy(true); authError("");
      sb.auth.updateUser({ password: pass }).then(function (r) {
        busy(false);
        if (r.error) { authError(traducirError(r.error.message)); return; }
        enRecuperacion = false;
        q("#auth-password").value = "";
        showAuth(false);
        window.RastroApp.loadPoints();
      }).catch(function () { busy(false); authError("No se pudo cambiar la contraseña."); });
      return;
    }

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
    window.RastroCuenta = { email: session.user.email || "" };
    var ac = q("#btn-account"); if (ac) ac.hidden = false;
    if (!already) window.RastroApp.loadPoints();
  }
  function onSignedOut() {
    currentUserId = null;
    window.Store = window.LocalStore;
    window.RastroCuenta = null;
    var ac = q("#btn-account"); if (ac) ac.hidden = true;
    if (window.RastroApp.cerrarCuenta) window.RastroApp.cerrarCuenta();
    window.RastroApp.clearData();
    setAuthMode("signin");
    q("#auth-email").value = ""; q("#auth-password").value = "";
    showAuth(true);
  }

  // --- Borrar la cuenta y todos sus datos (RGPD) ---------------------------
  // La clave publica no puede borrar usuarios, asi que se llama a una funcion
  // de la base de datos (delete_own_account) que solo borra al que la invoca.
  // Al desaparecer el usuario, sus puntos y ajustes caen por cascada; las
  // fotos hay que quitarlas antes, porque viven en Storage.
  function borrarCuenta() {
    if (!confirm("Vas a borrar tu cuenta y TODOS tus datos: puntos, notas, fotos y categorias.\n\n" +
                 "Esto no se puede deshacer. Si quieres conservarlos, cancela y usa antes Exportar.\n\n" +
                 "¿Continuar?")) return;
    var seguro = prompt('Para confirmar, escribe: BORRAR');
    if (!seguro || seguro.trim().toUpperCase() !== "BORRAR") return;

    var boton = q("#btn-delete-account");
    if (boton) { boton.disabled = true; boton.textContent = "Borrando…"; }

    var puntos = (window.RastroApp.puntos && window.RastroApp.puntos()) || [];
    var rutas = [];
    puntos.forEach(function (p) {
      (p.photos || []).forEach(function (f) { if (f && f.path) rutas.push(f.path); });
    });

    var bucket = cloud.photoBucket || "fotos";
    var quitarFotos = rutas.length
      ? sb.storage.from(bucket).remove(rutas).then(function () {}).catch(function () {})
      : Promise.resolve();

    quitarFotos
      .then(function () { return sb.rpc("delete_own_account"); })
      .then(function (r) {
        if (r && r.error) throw r.error;
        return sb.auth.signOut();
      })
      .then(function () {
        if (boton) { boton.disabled = false; boton.textContent = "Borrar mi cuenta y mis datos"; }
        alert("Tu cuenta y tus datos se han borrado.");
      })
      .catch(function (err) {
        if (boton) { boton.disabled = false; boton.textContent = "Borrar mi cuenta y mis datos"; }
        var m = (err && err.message) || "";
        if (/function|does not exist|schema/i.test(m)) {
          alert("Falta preparar el borrado en la base de datos.\n\n" +
                "Ejecuta el SQL de \"delete_own_account\" que figura en el README.");
        } else {
          alert("No se pudo borrar la cuenta. Intentalo de nuevo mas tarde.");
        }
      });
  }

  function bootCloud() {
    sb = window.supabase.createClient(cloud.url, cloud.anonKey);
    q("#auth-form").addEventListener("submit", handleSubmit);
    q("#auth-switch-btn").addEventListener("click", function () {
      setAuthMode(mode === "signup" ? "signin" : "signup");
    });
    var lo = q("#btn-logout");
    if (lo) lo.addEventListener("click", function () { sb.auth.signOut(); });
    var fg = q("#auth-forgot");
    if (fg) fg.addEventListener("click", recuperarContrasena);
    var del = q("#btn-delete-account");
    if (del) del.addEventListener("click", borrarCuenta);
    setAuthMode("signin");
    // Reaccionar a cambios de sesión (login, logout, refresco de token).
    sb.auth.onAuthStateChange(function (evt, session) {
      // Diferido: no conviene llamar a Supabase dentro del propio callback.
      setTimeout(function () {
        if (evt === "PASSWORD_RECOVERY") {
          // Ha llegado desde el enlace del correo: pedir la nueva contraseña
          // en vez de entrar directamente.
          enRecuperacion = true;
          currentUserId = session && session.user ? session.user.id : null;
          setAuthMode("recuperar");
          showAuth(true);
          return;
        }
        if (enRecuperacion) return;      // no entrar mientras se cambia la clave
        if (session) onSignedIn(session); else onSignedOut();
      }, 0);
    });
  }

  // --- Arranque -----------------------------------------------------------
  function boot() {
    window.RastroApp.start();
    if (!cloudEnabled()) {
      // Modo local: sin registro (comportamiento anterior).
      window.Store = window.LocalStore;
      var ac0 = q("#btn-account"); if (ac0) ac0.hidden = true;
      window.RastroApp.loadPoints();
      return;
    }
    bootCloud();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
