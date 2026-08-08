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
- **Mapa** con Leaflet y **5 estilos** a elegir (Callejero, Minimalista,
  Relieve, Satélite y OSM clásico); la elección se recuerda. Al abrir intenta
  centrarse en la ubicación del usuario; si no, muestra la vista configurada.
- **Puntos de interés** por categorías, con marcador de color y emoji.
- **Valoración** de 1 a 5 estrellas, **estado** (visitado / pendiente) y **notas**.
- **Fotos** por punto (hasta 6). Se reescalan y comprimen en el navegador
  antes de subirlas; en modo nube van a Supabase Storage y en modo local
  quedan incrustadas en el navegador.
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
├── store.js            Capa de datos local (localStorage)
├── cloud.js            Registro/sesión + datos por usuario en la nube (Supabase)
├── app.js              Lógica de la aplicación
├── icono-64.png        Icono de la pestaña del navegador
├── icono-180.png       Icono al añadir a la pantalla de inicio (iOS)
├── icono-192.png       Icono para la app instalable
├── icono-512.png       Icono para la app instalable (alta resolución)
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

La app tiene **dos modos**, según `cloud` en `config.js`:

- **Local** (por defecto, `cloud.url`/`anonKey` vacíos): los puntos se guardan
  en el **navegador** (`localStorage`). Sin registro ni conexión. Los datos van
  ligados a ese dispositivo; por eso existe **exportar / importar** en JSON.
- **Nube** (`cloud.url`/`anonKey` configurados): la app **exige registro/inicio
  de sesión** y guarda los puntos de **cada usuario** en la nube (Supabase),
  sincronizados entre dispositivos.

La persistencia está aislada tras una interfaz asíncrona común
(`js/store.js` para local, `js/cloud.js` para Supabase):

```js
Store.getAll()            // → Promise<Point[]>
Store.create(point)       // → Promise<Point>
Store.update(id, point)   // → Promise<Point|null>
Store.remove(id)          // → Promise<void>
Store.replaceAll(points)  // → Promise<void>
```

### Activar el modo nube (Supabase)

1. Crea un proyecto gratuito en [supabase.com](https://supabase.com).
2. En **SQL Editor**, ejecuta:

   ```sql
   create table if not exists public.points (
     id text primary key,
     user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
     data jsonb not null,
     updated_at timestamptz not null default now()
   );
   alter table public.points enable row level security;
   create policy "own_select" on public.points for select using (auth.uid() = user_id);
   create policy "own_insert" on public.points for insert with check (auth.uid() = user_id);
   create policy "own_update" on public.points for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
   create policy "own_delete" on public.points for delete using (auth.uid() = user_id);
   ```

3. **Authentication → Providers → Email**: activa el proveedor. Para registro
   instantáneo (sin confirmación por correo) desactiva *Confirm email*; déjalo
   activo si prefieres verificar el correo en producción.
4. En **Project Settings → API**, copia **Project URL** y la clave **anon
   public**, y pégalas en `config.js` → `cloud.url` y `cloud.anonKey`.

5. Para las **fotos**, crea el depósito de Storage y sus permisos ejecutando
   también este SQL:

   ```sql
   insert into storage.buckets (id, name, public)
   values ('fotos', 'fotos', true)
   on conflict (id) do nothing;

   drop policy if exists "fotos_lectura" on storage.objects;
   create policy "fotos_lectura" on storage.objects for select
     using (bucket_id = 'fotos');

   drop policy if exists "fotos_subir_propias" on storage.objects;
   create policy "fotos_subir_propias" on storage.objects for insert
     with check (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);

   drop policy if exists "fotos_borrar_propias" on storage.objects;
   create policy "fotos_borrar_propias" on storage.objects for delete
     using (bucket_id = 'fotos' and (storage.foldername(name))[1] = auth.uid()::text);
   ```

   Cada usuario solo puede subir y borrar dentro de su propia carpeta
   (`{user_id}/{punto}/...`). El depósito es de lectura pública, que es lo
   que permite mostrar las fotos con una URL directa.

Las claves `anon` son **públicas por diseño**: la seguridad la garantizan las
políticas RLS (cada usuario solo accede a sus filas). Para volver al modo local,
vacía `cloud.url` y `cloud.anonKey`.

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
