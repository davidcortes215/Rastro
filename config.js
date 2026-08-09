/* ==========================================================================
   CONFIGURACIÓN — white-label
   Todo lo personalizable por cliente vive aquí. Para adaptar la app a una
   marca basta con cambiar los valores de este archivo: nombre, color de
   acento, vista inicial del mapa, proveedor de teselas, buscador y las
   categorías de puntos. No hace falta tocar el resto del código.
   ========================================================================== */
window.APP_CONFIG = {
  /* Identidad -------------------------------------------------------------- */
  name: "Rastro",                   // se muestra en la barra superior y el título
  shortName: "Rastro",              // versión corta (móvil / pestaña)
  tagline: "Tus sitios, tus notas", // subtítulo opcional (vacío para ocultarlo)

  /* Color de acento (botones, estrellas, estados activos) ------------------ */
  accent: "#EA7317",

  /* Clave de almacenamiento local (cámbiala para aislar datos por cliente) - */
  storageKey: "rastro:puntos:v1",

  /* Nube (registro de usuarios + datos por usuario) ------------------------
     Si url y anonKey están vacíos, la app funciona en modo local (sin
     registro), como antes. Al rellenarlos con los datos de tu proyecto
     Supabase, la app exige iniciar sesión y guarda los puntos de cada
     usuario en la nube. Estas claves son públicas por diseño: la seguridad
     la garantizan las políticas RLS de la base de datos. */
  cloud: {
    provider: "supabase",
    url: "https://mbeulgxttoqzrumfqzej.supabase.co",
    anonKey: "sb_publishable_yTVfhyC6HXVZmw2xSAW5Uw_H6G75s6M",
    photoBucket: "fotos"   // depósito de Supabase Storage donde van las fotos
  },

  /* Navegación hasta un punto ---------------------------------------------- */
  /* "auto" usa Apple Maps en iPhone y Google Maps en el resto. */
  navigation: "auto",            // "auto" | "google" | "apple"

  /* Datos del responsable, para el aviso de privacidad --------------------- */
  legal: {
    responsable: "",             // nombre o razón social; vacío = texto genérico
    contacto: "",                // correo de contacto para ejercer derechos
    ubicacionDatos: "Unión Europea"
  },

  /* Fotos de cada punto ---------------------------------------------------- */
  photos: {
    enabled: true,
    maxPerPoint: 6,
    maxSize: 1600,      // lado mayor en píxeles tras comprimir
    quality: 0.72       // calidad JPEG (0-1)
  },

  /* Mapa ------------------------------------------------------------------- */
  map: {
    center: [40.0, -3.7],           // vista inicial [lat, lng]
    zoom: 6,
    tryGeolocateOnLoad: true,       // intentar centrar en la ubicación del usuario
    /* Estilos de mapa disponibles. El usuario elige con el botón de capas y
       su elección se recuerda. Todos son gratuitos y sin clave de API; hay
       que conservar su atribución. Para quitar alguno, bórralo de la lista. */
    defaultStyle: "voyager",
    styles: [
      {
        id: "voyager", label: "Callejero",
        url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
        subdomains: "abcd", maxZoom: 20, retina: true,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      },
      {
        id: "minimal", label: "Minimalista",
        url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        subdomains: "abcd", maxZoom: 20, retina: true,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      },
      {
        id: "relieve", label: "Relieve",
        url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
        subdomains: "abc", maxZoom: 17,
        attribution: 'Datos &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Cartografía &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
      },
      {
        id: "satelite", label: "Satélite",
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        maxZoom: 19,
        attribution: 'Imágenes &copy; Esri, Maxar, Earthstar Geographics'
      },
      {
        id: "osm", label: "OSM clásico",
        url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        subdomains: "abc", maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }
    ],
    /* Buscador de lugares (geocodificación). enabled:false lo oculta.
       Nominatim es gratuito pero con límite de uso; para producción con
       volumen, apunta endpoint a tu propio servicio de geocodificación. */
    geocode: {
      enabled: true,
      endpoint: "https://nominatim.openstreetmap.org/search",
      // Buscador de respaldo: se usa si el principal falla (su límite es de
      // ~1 consulta/segundo) o si no encuentra nada.
      fallbackEndpoint: "https://photon.komoot.io/api/",
      countrycodes: "es",           // limita resultados a un país; "" = global
      language: "es"
    }
  },

  /* Descubrir sitios de OpenStreetMap (modo "Todos") ----------------------- */
  discover: {
    enabled: true,
    // Servidores Overpass, en orden de preferencia. Los públicos se saturan
    // a menudo: si uno falla, la app prueba el siguiente automáticamente.
    overpassEndpoints: [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://overpass.private.coffee/api/interpreter",
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
    ],
    queryTimeout: 25,   // segundos que se le conceden al servidor
    padding: 0.35,      // margen extra que se descarga alrededor de lo visible
    cacheMinutes: 10,   // tiempo que se reutiliza lo ya descargado
    minZoom: 12,        // por debajo de este zoom no se consulta (demasiada área)
    maxResults: 250,    // tope de resultados por consulta
    // Etiquetas de OSM que se consultan para cada categoría. Las categorías
    // que no aparezcan aquí no se buscan en modo "Todos".
    osm: {
      restaurante: ['["amenity"="restaurant"]'],
      bar:         ['["amenity"~"^(bar|cafe|pub)$"]'],
      mirador:     ['["tourism"="viewpoint"]'],
      faro:        ['["man_made"="lighthouse"]'],
      playa:       ['["natural"="beach"]'],
      acampada:    ['["tourism"="camp_site"]'],
      pueblo:      ['["place"~"^(town|village|hamlet)$"]'],
      alojamiento: ['["tourism"~"^(hotel|hostel|guest_house|motel|chalet)$"]'],
      monumento:   ['["historic"~"^(monument|memorial|castle|ruins|archaeological_site)$"]'],
      naturaleza:  ['["natural"~"^(peak|waterfall|spring|cave_entrance)$"]']
    }
  },

  /* Estados de un punto ---------------------------------------------------- */
  statuses: [
    { id: "visitado",  label: "Visitado"  },
    { id: "pendiente", label: "Pendiente" }
  ],

  /* Categorías (id, etiqueta, emoji, color del marcador) ------------------- */
  categories: [
    { id: "restaurante", label: "Restaurante", emoji: "🍽️", color: "#C1440E" },
    { id: "bar",         label: "Bar / Café",  emoji: "☕",  color: "#8D6E63" },
    { id: "mirador",     label: "Mirador",     emoji: "🌄", color: "#2E7D32" },
    { id: "faro",        label: "Faro",        emoji: "🗼", color: "#1565C0" },
    { id: "playa",       label: "Playa",       emoji: "🏖️", color: "#00ACC1" },
    { id: "acampada",    label: "Acampada",    emoji: "⛺", color: "#33691E" },
    { id: "ruta",        label: "Ruta",        emoji: "🥾", color: "#F9A825" },
    { id: "pueblo",      label: "Pueblo",      emoji: "🏘️", color: "#8E24AA" },
    { id: "alojamiento", label: "Alojamiento", emoji: "🛏️", color: "#D81B60" },
    { id: "monumento",   label: "Monumento",   emoji: "🏛️", color: "#546E7A" },
    { id: "naturaleza",  label: "Naturaleza",  emoji: "🌲", color: "#1B5E20" },
    { id: "otro",        label: "Otro",        emoji: "📍", color: "#616161" }
  ]
};
