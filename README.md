# Rastro

> El nombre, el color y las categorías son configurables en `js/config.js`
> (ver «Personalización»). «Rastro» es la marca por defecto.

Aplicación web para **registrar, valorar y filtrar puntos de interés** sobre un
mapa: restaurantes, miradores, faros, puntos de acampada, playas, rutas… Cada
punto admite categoría, valoración de 1 a 5 estrellas, estado
(visitado / pendiente) y notas de impresiones. Después puedes filtrar por
texto, categoría, valoración mínima y estado para encontrar cómodamente tus
experiencias en cada sitio.

Es una aplicación **100 % estática** (HTML + CSS + JavaScript, sin framework ni
proceso de build): se sirve desde cualquier hosting estático y no necesita
servidor propio en esta primera fase.

---

## Características

- **Dos modos de vista** con un interruptor:
  - **Mis PDI** → tus puntos guardados (tu diario de experiencias).
  - **Todos (España)** → sitios reales de OpenStreetMap en la zona que estás
    viendo (restaurantes, miradores, faros, playas, pueblos…), que puedes
    **guardar en los tuyos** con un clic para valorarlos y anotarlos.
- **Mapa** con Leaflet + teselas de OpenStreetMap. Al abrir intenta centrarse
  en la ubicación del usuario; si no hay permiso, muestra la vista configurada.
- **Puntos de interés** por categorías, con marcador de color y emoji.
- **Valoración** de 1 a 5 estrellas, **estado** (visitado / pendiente) y **notas**.
- **Filtros combinables**: búsqueda por texto, categorías, valoración mínima y estado.
- **Buscador de lugares** (geocodificación) para localizar un sitio y guardarlo.
- **Exportar / importar** los datos en JSON (copia de seguridad y traspaso de dispositivo).
- **Responsive**: panel lateral en escritorio, pantalla completa en móvil.
- **White-label**: marca, color, mapa y categorías se configuran en un solo archivo.

---

## Estructura

```
rastro/
├── index.html          Estructura de la interfaz
├── styles.css          Estilos (el color de acento viene de la config)
├── config.js           ← CONFIGURACIÓN white-label (edita solo esto para personalizar)
├── store.js            Capa de datos intercambiable (local hoy, nube mañana)
├── app.js              Lógica de la aplicación
├── favicon.svg         Icono
├── README.md
└── .nojekyll           Para GitHub Pages
```

---

## Personalización (white-label)

Todo lo adaptable a cada cliente está en **`js/config.js`**. No hace falta tocar
el resto del código:

- `name`, `shortName`, `tagline`: identidad que se muestra en la interfaz.
- `accent`: color de acento (botones, estrellas, estados activos).
- `storageKey`: clave de almacenamiento (cámbiala para aislar datos por cliente).
- `map.center`, `map.zoom`, `map.tryGeolocateOnLoad`: vista inicial.
- `map.tiles`: proveedor de teselas (URL y atribución).
- `map.geocode`: buscador de lugares (`enabled`, `endpoint`, país e idioma).
- `statuses`: estados posibles de un punto.
- `categories`: lista de categorías con `id`, `label`, `emoji` y `color`.

Rebrandear la app suele ser cuestión de cambiar `name`, `accent` y `categories`.

---

## Puesta en marcha

**En local:** sirve la carpeta con cualquier servidor estático, por ejemplo:

```bash
python3 -m http.server 8080
# abre http://localhost:8080
```

(Abrir `index.html` con doble clic también funciona, aunque un servidor evita
restricciones del navegador con `file://`.)

**Publicación:** sube la carpeta tal cual a GitHub Pages, Netlify, Vercel, un
bucket S3 o cualquier hosting estático. No requiere build.

---

## Dónde se guardan los datos

En esta fase los puntos se guardan en el **navegador** del usuario
(`localStorage`), a través de la capa `js/store.js`. Implicaciones:

- Son **privados** y funcionan **sin cuenta ni conexión** al backend.
- Están **ligados a ese navegador/dispositivo**: si el usuario cambia de
  equipo o borra los datos de navegación, se pierden. Por eso la app incluye
  **exportar / importar** en JSON como copia de seguridad y traspaso.

### Migración a la nube (fase 2)

La persistencia está aislada tras una interfaz asíncrona en `js/store.js`:

```js
Store.getAll()            // → Promise<Point[]>
Store.create(point)       // → Promise<Point>
Store.update(id, data)    // → Promise<Point|null>
Store.remove(id)          // → Promise<void>
Store.replaceAll(points)  // → Promise<void>
```

Como la aplicación ya usa `await Store.*`, para añadir cuentas y sincronización
entre dispositivos basta con crear otra implementación de estos métodos que use
`fetch()` contra una API (y su base de datos) y asignarla a `window.Store`. **El
resto de la interfaz no cambia.**

---

## Nota sobre dependencias externas

- **Leaflet** se carga por CDN (con `integrity`/SRI). Para una entrega
  totalmente autónoma (sin depender de un CDN), descarga
  `leaflet.js`, `leaflet.css` y la carpeta `images/` de Leaflet 1.9.4 a
  `vendor/leaflet/` y apunta las etiquetas de `index.html` a esas rutas.
- **Teselas** de OpenStreetMap y **geocodificación** (Nominatim) son servicios
  gratuitos con límites de uso pensados para volúmenes moderados. Para
  producción con tráfico alto, contrata un proveedor de mapas/geocodificación y
  cámbialo en `js/config.js` (`map.tiles` y `map.geocode.endpoint`).
- **Descubrir sitios** (modo "Todos") usa la **Overpass API** de OpenStreetMap,
  también gratuita y con límites de uso. Solo consulta la **zona visible** (no
  todo el país) y a partir de un zoom mínimo, para no sobrecargar el servicio ni
  el navegador. Se configura en `discover` (`overpassEndpoint`, `minZoom`,
  `maxResults` y el mapeo `osm` de categoría → etiquetas de OSM). Para producción
  con tráfico alto conviene un endpoint Overpass propio o un proveedor de POIs.

---

## Modelo de un punto

```json
{
  "id": "p...",            // identificador único
  "lat": 42.9,             // latitud
  "lng": -9.26,            // longitud
  "name": "Faro de Fisterra",
  "cat": "faro",           // id de categoría (ver config.js)
  "stars": 5,              // 0–5
  "status": "visitado",    // id de estado (ver config.js)
  "notes": "Atardecer brutal. Volver en otoño.",
  "created": 1730000000000
}
```
