# Clipclicks Studio — Funcionalidades

Manual completo de lo que la app puede hacer hoy. Actualizado a **v0.2.3** (import de video, cronómetro, seguimiento/paneo cinematográfico con keyframes, GIFs animados, sombra nítida en el render, tiempo estimado de export). Sirve de checklist para verificar cada feature.

> Convenciones: **negrita** = botón / atajo / nombre de UI. `código` = ruta, archivo o valor literal. Las secciones marcadas **🚧 pendiente** son features ya planificadas pero todavía no implementadas; vienen en sub-fases siguientes.

---

## 1. Resumen

Clipclicks Studio es una app de escritorio para Windows (Electron + React) que graba la pantalla y arma videos de presentación con zoom automático sobre los clics del mouse — alternativa nativa Windows a Tella y a Screen Studio (Mac).

**Pipeline conceptual**:
1. Grabar (pantalla / ventana / app) + captura sincrónica de eventos del mouse.
2. Procesar (transcoding a MP4 all-keyframes + thumbnails + generación de zooms automáticos).
3. Editar (background, zooms, split + delete de clips, velocidad).
4. **🚧 Exportar** a MP4 final.

---

## 2. Arrancar la app

### Modo dev (lo que usás ahora)
```
npm run dev
```
Abre la app con HMR. Logs aparecen en la terminal del server (filtrados por [scripts/run.mjs](scripts/run.mjs) para que el ruido de Chromium/WGC no tape lo útil).

### Modo packaged 🚧
`npm run dist` genera el `.exe` instalador con NSIS. Disponible pero no testeado en una máquina limpia todavía.

---

## 3. Launcher

Pantalla inicial al abrir la app. Tres tarjetas + lista de proyectos recientes.

| Tarjeta | Estado | Acción |
|---|---|---|
| **New recording** | ✅ Funciona | Abre el source picker para grabar un proyecto nuevo |
| **Import video** | ✅ Funciona | Importa un video externo (.mp4/.mov/.webm/.mkv/.avi/.m4v) como **proyecto nuevo**. Lo transcodifica a MP4 all-keyframes + thumbnails. Sin auto-zoom (no hay clics grabados) pero podés agregar zoom y **paneo/seguimiento manual**. Ver §4.5. |
| **Open project** | ✅ Funciona | Abre un **browser de proyectos** (modal) que lista TODOS los `.vzproj` de la carpeta por su **nombre real** (de `project.json`, no el nombre de carpeta), con buscador. Botón "Buscar otra carpeta…" para el dialog nativo si el proyecto está en otro lado. |

**Recent projects**: muestra los últimos 5 con nombre, **duración del timeline completo** (`max(video, audio)` — un audio de 4 min sobre un video de 18s muestra 4:00, no 0:18) y "hace X tiempo". Click en cualquiera abre el proyecto en el editor.

> El browser de "Open project" (`listAllProjects`) escanea `%APPDATA%\video-zoom\Projects`, lee el `name` de cada `project.json` y ordena por `updatedAt`. Resuelve el problema de que las carpetas se llaman `Recording <fecha>.vzproj` aunque renombraste el proyecto.

### Cómo se persisten los recientes
`%APPDATA%\video-zoom\app-state.json` guarda hasta 10 paths recientes y timestamps de última apertura. Si un proyecto fue movido o borrado, se filtra automáticamente la próxima vez que listás recientes.

---

## 4. Grabación

### Selector de fuente

Al hacer click en **New recording** se abre un modal con dos tabs:

- **Screen**: lista todos los monitores conectados con un thumbnail de cada uno.
- **Window**: lista todas las ventanas abiertas con thumbnail + icono de la app.

Click en una fuente la selecciona (borde azul). El botón rojo **Record** queda habilitado.

### Countdown

Al hacer click en Record, ves un countdown 3-2-1 en grande. Ese tiempo se descuenta del video final (la grabación arranca cuando el "Go" aparece).

### Durante la grabación

- La ventana de la app se achica a una **barra flotante mini** (~240×56) que va a la esquina superior derecha, always-on-top, draggable arrastrando el cuerpo.
- Muestra: tiempo transcurrido (mm:ss), botón ⏸ pause, botón ⏹ stop (rojo), botón ✕ cancel.
- **La barra NO aparece en la grabación**: se le aplica `setContentProtection(true)` (en Windows = `WDA_EXCLUDEFROMCAPTURE`), así seguís viéndola y usando sus botones, pero queda excluida del video capturado. Salvedad: en el modo sin-cursor full-screen (ffmpeg gdigrab) un driver podría no respetarlo, por eso hay atajos globales de respaldo.
- **Atajos globales** (funcionan aunque la app no tenga foco): **F9** pausa/reanuda, **F10** detiene. Se muestran en el countdown.
- Si el hook global del mouse (`uiohook-napi`) falla a cargar, aparece un badge amarillo `!` — el video se graba igual pero sin eventos de clic, así que no habrá auto-zoom.

### Qué se captura

- **Video**: WebM VP9 a 30fps (60fps si la GPU lo banca) usando la API `desktopCapturer` + `MediaRecorder`.
- **Eventos del mouse**: posición y clics en tiempo real (`uiohook-napi`), incluye `move`, `down`, `up`, `scroll` y botón (`left`, `right`, `middle`).
- **Sin audio** (planificado en Fase 5D).
- **Sin webcam** (planificado V1.6 post-MVP).

### Coordenadas del mouse

Los eventos vienen en coordenadas globales del escritorio. La app **traduce automáticamente** al sistema local del monitor capturado restando el origen del monitor:
- Si tu monitor secundario está físicamente arriba del notebook (Y negativa global), los eventos sobre ese monitor se convierten a `(x, y)` dentro de su rango propio.
- Los eventos que caen FUERA del monitor capturado se **descartan** (no afectan los auto-zooms).
- Display scaling de Windows (150%, 200%) se respeta — la coordenada se normaliza al espacio de DIPs del monitor.

### Al hacer Stop

La app pasa a **Processing** y hace en orden:
1. Mueve el `.webm` a un staging temporal (`%APPDATA%\video-zoom\staging\<uuid>`).
2. Transcodifica WebM→MP4 H.264 con `-g 1` (todos los frames son keyframe → seek instantáneo durante edición), preset `veryfast`, CRF 22.
3. Genera thumbnails cada 2 segundos a 160px de ancho.
4. Corre el **algoritmo de auto-zoom** sobre los eventos del mouse.
5. Arma el `Project` con configs default + el clip recién procesado.
6. Crea la carpeta `.vzproj` en `%APPDATA%\video-zoom\Projects\Recording <fecha> <hora>.vzproj`.
7. Borra el staging.

El editor se abre automáticamente con tu primer frame visible.

> En modo native (grabaste sin cursor del SO), el paso 2 se saltea: ffmpeg ya escribió el MP4 all-keyframes durante la grabación, así que el "transcoding" es instantáneo.

### Cancelar durante el processing

La vista de "Preparing your project" tiene un botón **"Cancel & discard"**. Sirve para cuando te equivocaste en la grabación y no querés esperar a que termine el render (el transcoding del modo MediaRecorder puede demorar varios segundos). Al cancelar:
- main mata el ffmpeg de processing (`killActiveProcessingFfmpeg`, SIGKILL).
- Se borra la carpeta `.vzproj` a medio armar + el staging.
- El flujo vuelve al launcher sin crear nada.

Funciona tanto para grabación nueva (`createProjectFromStaging`) como para "Add recording" (`appendClipFromStaging`, que limpia solo el asset recién agregado, no el proyecto existente). Técnicamente: el ffmpeg killeado emite `SIGKILL` → la promesa de transcode rechaza con el sentinel `'CANCELLED'` → el renderer lo detecta y navega de vuelta sin mostrar error.

---

## 4.5 Importar video (✅)

Trabajar sobre un video que **no** grabaste con ClipClicks (grabado con otro sistema, un celular, etc.).

- **Desde el launcher** → tarjeta **Import video**: crea un **proyecto nuevo** con ese video como primer clip.
- **Desde el editor** → panel **Media → Video → botón Import**: agrega el video como **clip adicional** al proyecto abierto.

Formatos: `.mp4`, `.mov`, `.webm`, `.mkv`, `.avi`, `.m4v`. En ambos casos se transcodifica a MP4 all-keyframes (para scrubbing exacto) + thumbnails, reusando el mismo pipeline que la grabación pero con `mouseEvents: []`.

**Qué tenés y qué no en un video importado:**
- ✅ Zoom **manual**, **seguimiento/paneo manual** (§ tracking), backgrounds, padding, crop, velocidad, texto, cronómetro, audio, transiciones y export.
- ❌ **Auto-zoom en clics** y **seguimiento automático del cursor**: dependen del registro de eventos del mouse que se captura al grabar. Un video externo no lo tiene. (Detectar los clics desde los píxeles = visión por computadora, fuera de alcance.)

**Aspect ratio / verticales:** el import mide las dimensiones del MP4 **ya transcodificado** (post-rotación), y además al abrir cualquier proyecto se reconcilian las dimensiones de cada clip contra las reales del `<video>` decodificado. El preview usa `contain` (container-query units) para que un video **vertical** entre bien proporcionado y no se vea aplastado.

---

## 5. Formato `.vzproj`

Carpeta-paquete con esta estructura:

```
Recording 2026-05-24 14-30-15.vzproj/
├── project.json           ← Modelo completo del proyecto
├── assets/
│   └── recording.mp4      ← Video transcodeado (puede ser varios después de 5C.6)
├── thumbnails/
│   ├── thumb-001.jpg
│   ├── thumb-002.jpg
│   └── ...
└── autosave/
    ├── project-1748..json.bak  ← Últimos 3 backups rotativos
    └── ...
```

### `project.json` (schemaVersion 2)

Contiene:
- `id`, `name`, `createdAt`, `updatedAt`
- **`clips: Clip[]`** — array de clips ordenados. Cada `Clip` tiene su propio `mouseEvents`, `zoomEvents`, `speedSegments`, `inMs/outMs` (trim interno por split), `timelineStartMs` (auto-computado).
- `timeline: { durationMs, markers, textEvents }` — `durationMs` es la suma efectiva de todos los clips (auto-computada).
- `background`, `cursor`, `exportSettings`, `autoZoomConfig`.

### Migración automática

Proyectos creados pre-5A en `schemaVersion: 1` (con `sourceVideo` y `mouseEvents` global) se migran a la versión 2 silenciosamente al abrirlos. La consola muestra: `[projectFs] migrated project v1 -> v2`. La versión migrada se persiste a disco.

### Autosave

- Cualquier cambio en el editor (background, zoom, trim, etc.) **dispara un autosave debounceado a 1.5 segundos**.
- El `●` amarillo al lado del nombre indica cambios sin guardar; desaparece cuando se persiste.
- Cada autosave también rota un backup en `autosave/` (mantiene los últimos 3).

---

## 6. Editor: tour de la UI

```
┌──────────────────────────────────────────────────────────────────┐
│ ← │ ProjectName ●  │  ⟲  ↺  ↻  📁                                │
│   │ /path/to.vzproj                                              │
├──────────────────────────────────────────┬───────────────────────┤
│                                          │                       │
│            PixiJS preview canvas         │   Right panel         │
│        (background + video + zoom)       │   (properties)        │
│                                          │                       │
├──────────────────────────────────────────┤                       │
│  ⤴ ⏮ ▶ ⏭ ⤵ ✂  00:08.50 / 00:34.20  0.5× │                       │
├──────────────────────────────────────────┴───────────────────────┤
│  0s    5s    10s    15s    20s    25s    30s                     │
├──────────────────────────────────────────────────────────────────┤
│  Video  │  [ Clip 1            ][ Clip 2     ]                   │
│  Zoom   │  ░ ░  ░ ░░       ░░░                                   │
│         │                  ║ playhead                            │
└──────────────────────────────────────────────────────────────────┘
```

### Header

| Elemento | Función |
|---|---|
| ← | Vuelve al launcher (cierra el proyecto, descargando recursos) |
| Nombre del proyecto | Click → input editable inline. Enter confirma, Esc cancela |
| Indicador `●` amarillo | Hay cambios sin guardar (desaparece tras autosave) |
| Path debajo del nombre | Path absoluto del `.vzproj` |
| ⟲ Refresh | Regenerar auto-zooms desde los clics (preserva los locked + manual) |
| ↺ Undo | `Ctrl+Z` |
| ↻ Redo | `Ctrl+Y` o `Ctrl+Shift+Z` |
| 📁 Folder | Abre el `.vzproj` en el Explorador de Windows |

### Preview central (PixiJS)

- Canvas que renderiza en GPU: background + video frame + transformación de zoom.
- **Cap interno**: 1280px de ancho máximo (downsampling). Mantiene FPS aceptables aunque el source sea 4K.
- **30fps cap del ticker** y `antialias: false` para no chupar GPU.
- **Auto-pausa**: el video se pausa solo al cruzar el `outMs` del clip activo (límite del trim interno por split).

### Transport

| Botón | Acción | Atajo |
|---|---|---|
| ⤴ | Salta al inicio de la timeline | — |
| ⏮ | Atrás 1 segundo | ← |
| ▶ / ⏸ | Play / Pause | **Space** |
| ⏭ | Adelante 1 segundo | → |
| ⤵ | Salta al final de la timeline | — |
| ✂ Scissors | **Split** del clip en el playhead | **S** |
| Tiempo | `mm:ss.cs / mm:ss.cs` (actual / total efectivo) | — |
| 0.5× / 1× / 1.5× / 2× | **Preview rate** (solo afecta cómo lo ves vos, no el export) | — |

> **Preview rate vs. clip speed**: Son cosas distintas. El preview rate del Transport es un override transitorio. La clip speed (de la sección Speed en el panel derecho) sí afecta la duración del video exportado.

### Timeline

- **Ruler** en tiempo de **timeline efectivo** (suma de duraciones efectivas de todos los clips, ya considerando speed).
- **Pista Audio** (arriba de todo, verde): chips de los `AudioTrack` con su waveform. Click selecciona → panel derecho muestra volumen/mute/fades. Ver sección 7.5.
- **Pista Video**: cada clip es un segmento coloreado (azul, cian, púrpura, rotativo) con su número de orden (`Clip 1`, `Clip 2`, ...). Click en el cuerpo selecciona el clip → panel derecho muestra sus controles.
- **Pista Zoom**: chips representando los `ZoomEvent` de todos los clips, posicionados en tiempo global.
- **Playhead**: línea roja vertical con un triangulito. Drag para scrubear, click en cualquier punto vacío salta ahí.
- Click en empty timeline space deselecciona el clip, zoom o audio activo.

---

## 7. Backgrounds

**26+ presets** en el panel derecho (toggleable la sección con click en "Backgrounds ▾") + **librería de imports propios** persistente entre proyectos.

**Presets built-in (clásicos)**:
1. Sunset Gradient (default) — naranja → rosa
2. Ocean Mesh — azul → violeta
3. macOS Sonoma — pastel multi-stop
4. macOS Sequoia Dark — oscuro
5. Solid Charcoal — `#1C1C1E`
6. Solid Off-White — `#F5F5F0`
7. Purple Haze — radial violeta → negro
8. Forest Mint — verde
9. Dotted Grid Light — puntos sobre blanco
10. Linear Glow — azul → magenta

**Presets divergentes (v0.1.2+)**:
11. **Aurora** — bandas verde/violeta tipo aurora boreal sobre cielo estrellado.
12. **Synthwave Horizon** — sol retro con stripes + grid de horizonte.
13. **Neon Grid** — cuadrícula cyan sobre fondo violeta, glow rosa.
14. **Starfield** — campo de estrellas con cálidas dispersas.
15. **Liquid Blobs** — manchas orgánicas multi-color.
16. **Plasma** — campo sinusoidal multi-color (efecto demoscene).
17. **Carbon Fiber** — tile diagonal oscuro.
18. **Topographic** — curvas de nivel sobre crema (mapa topográfico).
19. **Hexagons** — panal sobre azul slate.
20. **Wave Mesh** — líneas sinusoidales sobre azul profundo.
21. **Vaporwave** — pink/violeta/cyan + grid floor + scanlines.
22. **Matrix Rain** — caracteres katakana cayendo en verde.
23. **Paper Grid** — papel de gráfica.
24. **Terrazzo** — pebbles de colores random sobre crema.
25. **Dot Storm** — dots multi-color con dispersión radial.
26. **Blueprint** — plano arquitectónico azul rey + grid.
27. **Circuit Board** — pistas de PCB en verde sobre fondo oscuro.
28. **Solid Cream** / 29. **Solid Slate** — sólidos extra.
30. **Cyber Sunset** — multi-stop dramático.
31. **Midnight Aurora** — radial verde sobre azul profundo.

### Librería personal (Import)

Botón **"Import image or video"** debajo del grid. Importás cualquier:
- **Imagen estática** (PNG, JPG, JPEG, WebP, GIF).
- **Video animado** (MP4, WebM, MOV, MKV) — corre en loop como fondo (estilo Wallpaper Engine).

Los archivos se copian a `%APPDATA%/VideoZoom/backgrounds/` y un índice JSON los recuerda — quedan **persistidos app-wide**, no dentro del `.vzproj`, así los compartís entre proyectos. Cada tile imported muestra un icono ![image] o ![video] en la esquina; hover muestra la X para borrarlo de la librería.

### Layout (ajustes del video sobre el background)

| Control | Rango | Efecto |
|---|---|---|
| **Padding** | 0–30% | Padding alrededor del video (% del canvas) |
| **Corner radius** | 0–48px | Esquinas redondeadas del video |

### Shadow (sombra del video)

| Control | Rango | Efecto |
|---|---|---|
| **Enabled** | toggle | Activa/desactiva la sombra |
| **Blur** | 0–120 | Cantidad de blur (más alto = más difusa) |
| **Y offset** | 0–80 px | Desplazamiento vertical de la sombra |
| **Opacity** | 0–100% | Intensidad de la sombra |

Todos los sliders se **coalescen en una sola entry de historia** por drag (Ctrl+Z revierte el drag completo de un golpe).

**Nitidez en el render (✅ v0.2.2)**: en el editor la sombra se ve en "capas de tono" a propósito (2 pasadas de blur = barato, el preview corre a 30fps). Al **exportar** se renderiza con 6 pasadas → degradado suave. Además el blur y el offset ahora **escalan con el alto de la escena** (base 720px): antes estaban en píxeles fijos, así que a 1080p/4K la sombra salía proporcionalmente más chica y dura que en el preview. Ahora preview y export coinciden.

### Renderizado interno

El background se **dibuja una sola vez en un Canvas 2D** offline (gradients, dots, etc.) y se sube como textura PixiJS. Se repinta solo cuando cambiás el preset. Cambios de padding/radius/sombra son **transformaciones cheap del sprite**.

### Recorte & aspecto (Crop — Fase 5G)

Permite recortar el frame para sacar lo que no querés mostrar (la barra de tareas de Windows, el chrome del navegador cuando grabaste una ventana, etc). Es **no-destructivo**: se guarda como `Clip.crop` en coordenadas normalizadas (0..1, relativas al source, así es agnóstico a la resolución). Undefined = frame completo.

**Cómo usarlo**:
1. En el panel "Project" → sección **"Recorte & aspecto"** → botón **"Editar recorte / aspecto"**.
2. El preview pasa a mostrar el **frame completo sin zoom** y aparece un overlay con un rectángulo de recorte + handles.
3. Arrastrás los handles:
   - **Libre**: cada lado/esquina se mueve independiente (8 handles).
   - **Con aspecto fijo** (16:9, 9:16, 4:3, 1:1): solo 4 handles de esquina, mantienen la relación anclando la esquina opuesta.
4. Botón **"Listo"** (o `Escape`) sale del modo.
5. Reset vuelve al frame completo.

**Cómo se renderiza**: la transform de crop compone *debajo* del click-zoom en `PixiScene.applyZoomToSprite`. El sub-rect `[cx,cy,cw,ch]` mapea al área con padding `[padX,padY,W,H]`; el sprite del frame completo se escala a `(W/cw)×(H/ch)` y se offsetea para que la esquina del crop caiga en el origen del padding. El zoom (escala Z sobre el focal) se aplica encima. El mask fijo del área con padding clipea lo que sobra. Como el cursor enhanced también usa `videoSprite.x/width`, sigue al punto correcto bajo crop+zoom sin código extra.

**Mientras editás el crop**: el playback se pausa (para que el clip activo no cambie), el click-zoom y el cursor enhanced se suspenden (se ve el frame crudo), y el overlay muestra una grilla de regla-de-tercios como guía.

**Por-clip**: cada clip tiene su propio crop. El editor opera sobre el clip que estás viendo en el preview.

> Export (Fase 6) todavía no existe; cuando se implemente, va a aplicar el crop usando la misma escena Pixi, así que el `.mp4` final va a salir recortado.

---

## 7.5 Audio (Fase 5D)

Modelo: el audio del editor vive en dos lados:
- **`Project.audioPool: AudioMedia[]`** — los audios disponibles (importados, grabados con mic en el editor, o extraídos de un clip). Cada uno: `{ filePath, name, durationMs, kind, peaks }`. Los `peaks` son la waveform downsampleada (mono 8kHz → ~600 valores 0..1) calculada con ffmpeg al importar.
- **`Project.audioTracks: AudioTrack[]`** — instancias colocadas en el timeline. Cada una referencia un `AudioMedia` por `mediaId` + lleva `{ offsetMs, inMs, outMs, volume, muted, fadeInMs, fadeOutMs }`.

### Importar audio (✅ 5D.1)
Panel derecho → tab **Media** → subtab **Audio** → botón **"Importar audio"**. Abre un file dialog (mp3, wav, m4a, aac, ogg, flac, opus), copia el archivo a `assets/audio-{id}.{ext}`, prueba la duración + calcula la waveform, y lo agrega al pool como card. El botón **+** de la card lo coloca en el timeline en la posición del playhead. El 🗑 lo borra definitivamente (y dropea sus instancias del timeline).

### Pista de audio en el timeline (✅ 5D.2 / 5D.3)
- Barra verde arriba de la de video. Cada `AudioTrack` es un chip posicionado por `offsetMs` y ancho por su largo trimmeado, con la waveform dibujada (SVG, solo la ventana `[inMs,outMs]`).
- **Arrastrar el cuerpo** del chip lo reposiciona (`offsetMs`); **arrastrar los bordes** lo recorta (borde izq mueve `inMs` + `offsetMs` para dejar fijo el lado derecho; borde der mueve `outMs`). Cada drag = un solo undo.
- **Magnetismo**: al arrastrar/recortar, los bordes se imantan (±8px) a puntos clave: inicio (0), fin del video, playhead, límites de clips y bordes de otros audios. Permite superponer igual — solo nudge hacia alineación, no bloquea.
- Click selecciona → panel **Audio** con: mute, volumen (0–100%), fade in / fade out. `Delete`/`Backspace` lo quita.
- **Largo del timeline**: la regla y las pistas abarcan `max(duración del video, fin del audio más largo)` + 3% de padding, así un audio de 4 min sobre un video de 30s entra en pantalla y su final es agarrable.
### Reloj de reproducción (un único reloj master para todo el timeline)

El playhead recorre `[0, max(video, audio)]` como un único timeline; no importa cuántos clips/audios haya ni cuál sea más largo. Hay **un solo reloj virtual master** (`masterMs`):
- **Reproduciendo**: avanza por wall-clock × velocidad cada frame (`masterMs += dt × rate`). Al llegar a `max(video, audio)` para.
- **Pausa / scrub**: el master sigue la posición del store (la regla manda).
- El video activo y el audio del timeline son ambos **esclavos** del master: cada uno reproduce libre y solo se re-seekea si se desfasa más que la tolerancia (250ms para el video). Por eso un clip que está buffering (recién agregado con *add recording*) **ya no congela el playhead ni hace tartamudear el audio**: el master sigue corriendo a tiempo real, el audio suena de corrido y el video se pone al día con un seek cuando puede.
- **Qué clip se ve**: cada frame se ubica el clip bajo `masterMs` (`locateGlobal`) y se activa (swap de textura en PixiJS). Pasado el final del video (si un audio se extiende más allá), no hay clip → el preview queda **en negro** y el audio sigue sonando.

> Diseño anterior (reemplazado): el `<video>` activo ERA el reloj master. Un clip recién agregado que buffereaba estancaba todo el timeline y el audio (que corre libre) se re-seekeaba para perseguir ese reloj que saltaba → el "tartamudeo" al cruzar al segundo clip. El reloj virtual elimina esa dependencia.

**Controles uniformes**: play/pause, jump-to-start/end, ±1s y el scrub de la regla funcionan en TODO el timeline, incluida la zona sin video:
- `togglePlay` usa el flag `playing` del store (no `video.paused`). El master se encarga de reproducir/pausar el `<video>` esclavo. Al final del timeline, reinicia desde 0.
- Cualquier seek (botones de transport, loop a 0) escribe el store; el master lo **adopta** en el siguiente frame (compara contra el último valor que él mismo publicó).
- **Zoom horizontal (Ctrl+rueda)**: a zoom 1 todo el timeline entra en el viewport; con Ctrl+rueda hacés zoom in/out anclado en el cursor y aparece scroll horizontal, para trabajar cómodo el video de 30s aunque el audio dure 4 min. Badge arriba a la derecha con el % y un "reset".

### Playback (✅ 5D.2)
- `audioSession.ts` mantiene un `HTMLAudioElement` por track. Cada frame `updateAudioPlayback(masterMs, isPlaying, ...)` (manejado por el reloj master, ver arriba) decide si el playhead está dentro del rango del track y, si sí, reproduce con el gain calculado (incluye los fades) corrigiendo drift solo en desync catastrófico. Fuera de rango o en pausa/scrub, pausa el elemento.
- **Volumen clampeado a [0,1]**: `HTMLMediaElement.volume` solo acepta ese rango — pasarse tira excepción. El boost >100% real necesita Web Audio (post-MVP).
- **Audio corre libre (sin chase del video)**: una vez que el track arranca, reproduce en su propio reloj y NO se re-seekea para perseguir al reloj global. Ese reloj se deriva del video, que tiene jitter en los bordes de clip y en clips recién agregados (todavía buffering); perseguirlo cada frame hacía tartamudear el audio durante el segundo clip. Solo se corrige un desync catastrófico (>1.2s) y como mucho una vez cada 1.5s. Para música/voz sobre video un drift de unos cientos de ms es imperceptible; el stutter no.

### Grabar mic en el editor (✅ 5D.4)
Subtab **Audio** → botón **"Grabar mic"** → `getUserMedia({audio})` + MediaRecorder → al detener, los bytes van a main (`saveRecordedAudio`), se prueba duración + peaks y queda como AudioMedia (`kind: 'mic'`) en el pool.

### Capturar audio al grabar pantalla (✅ 5D.5)
En el SourcePicker, opciones agrupadas en dos tarjetas (**Cursor** / **Audio**). En Audio: **"Micrófono"** y **"Audio del sistema"** (opt-in, off por default). El audio se mezcla en un solo track vía Web Audio.

**Constraints de Chromium (importante)**:
- **Mic**: `getUserMedia({audio:true})` standalone — confiable.
- **Audio del sistema (loopback)**: NO se puede pedir solo (`{audio:{mandatory:{chromeMediaSource:'desktop'}}, video:false}` **crashea** el renderer con "bad IPC message reason 263"). Hay que pedirlo en la MISMA llamada que el video desktop. Por eso:
  - **Path MediaRecorder (con cursor)**: `getUserMedia` pide video desktop + (opcional) audio desktop juntos; el mic va aparte y se mezcla. → audio embebido en el clip.
  - **Path nativo (sin cursor, ffmpeg)**: no hay video por getUserMedia, así que el **audio del sistema no está disponible** (el checkbox se deshabilita en ese modo). El mic sí: se graba en un `MediaRecorder` paralelo y main lo **muxea** al MP4 (`muxAudioIntoVideo`).
- **Solo en captura de PANTALLA completa**: en modo Window el audio está deshabilitado — un segundo `getUserMedia` (mic) o pedir audio desktop junto con video de ventana **deja el video en negro** en Windows (independiente del orden de adquisición). Los checkboxes de audio se ocultan al elegir Window.
- El clip queda con `hasAudio: true`; su audio embebido suena en el preview (el `<video>` activo se des-mutea según `clip.audioMuted`/`audioVolume`).
- **Sync de eventos robusto**: el offset video↔mouseEvents se **clampea a 1200ms** (con fallback de 250ms si el `requestVideoFrameCallback` no dispara). Antes, cuando el audio demoraba la captura, el offset se inflaba a varios segundos y descartaba casi todos los `mouseEvents` → no se generaban auto-zooms. Ahora un error de medición nunca borra los eventos.

### Extraer audio de un clip (✅ 5D.6)
En el panel del Clip, si `hasAudio`, botón **"Extraer audio a la pista"**: ffmpeg saca el audio a un `.m4a` (`extractAudioToFile`), lo agrega al pool (`kind: 'extracted'`), crea un `AudioTrack` en la posición del clip (`offsetMs = clip.timelineStartMs`) y **mutea el audio embebido del clip**. Así podés mover/editar ese audio independiente del video.

> El audio todavía **no se exporta** (Fase 6 no existe). Cuando llegue, el pipeline de export va a mezclar los `audioTracks` + el audio embebido de los clips con sus ganancias/fades.

### Split selection-aware (✅)
El botón ✂ (o tecla `S`) ahora es consciente de la selección:
- **Sin nada seleccionado** → corta TODO en el playhead: el clip de video + todos los `AudioTrack` que crucen la línea.
- **Clip de video seleccionado** → corta solo ese clip (si el playhead está dentro).
- **Audio seleccionado** → corta solo ese audio.
Cada lado debe quedar de al menos 200ms (sino el corte se ignora). Al cortar un audio, el lado izquierdo conserva su fade-in y el derecho su fade-out.

### Playhead agarrable desde la regla (✅)
Además del área de tracks, ahora podés hacer **drag de la línea roja desde la regla de tiempo** (la franja con los segundos arriba). Cursor `ew-resize` al pasar por encima.

---

## 7.6 Texto / overlays (Fase 5E-A)

Texto encima del video, pensado para presentaciones de software. Los `TextEvent` viven en el **timeline global** (`Timeline.textEvents`), no en un clip — se componen arriba de todo y sobreviven a los cortes de clip (como un audio). Posición y tamaño son **normalizados al canvas** (0..1 y fracción del alto), así preview y export coinciden a cualquier resolución.

### Agregar texto
- Panel derecho → **Media → Texto**: tres bloques —**Título**, **Subtítulo**, **Párrafo**—. Tocá uno y se agrega en el playhead (3s por defecto) con su look + animación.
- Atajo **`T`**: agrega un Título en el playhead.

### Pista de texto en el timeline
- Fila **Texto** (amarilla) debajo de la de Zoom. Cada `TextEvent` es un chip posicionado por `startMs/endMs` (tiempo global directo).
- **Drag del cuerpo** = mover; **drag de los bordes** = recortar (mínimo 300ms). Un gesto = un undo.
- Click selecciona y **lleva el playhead al inicio del texto** (para que se vea en el canvas) → abre el panel **Texto**.

### Editar (panel Texto)
Contenido (textarea multilínea), fuente (Inter / Segoe UI / Arial / Georgia / Mono), **negrita**, *cursiva*, alineación (izq/centro/der), tamaño (slider, % del alto), color, sombra (legibilidad), y animación de **entrada** (sin / aparición fade / se escribe = typewriter) y **salida** (sin / fade). Editar contenido es un solo undo (snapshot al enfocar, commit al salir).

### Acomodar sobre el video (overlay en el canvas)
Cuando un texto está seleccionado y el playhead está dentro de su rango, aparece un **recuadro punteado** sobre el preview:
- **Arrastrar el recuadro** = mover (actualiza el centro normalizado `nx/ny`).
- **Arrastrar una esquina** = cambiar el tamaño (escala `fontScale` alrededor del centro).
El recuadro se mide con Canvas 2D para aproximar el tamaño real del texto (que dibuja PixiJS).

### Render (PixiScene)
- Capa de texto en el **stage**, por encima de todo y **fuera del transform del zoom** (los overlays no hacen zoom con el video) y visible aun en la zona negra de solo-audio.
- Un `Text` de Pixi por evento, cacheado; estilo/contenido solo se reconstruyen al cambiar (barato).
- **Animaciones** (`textRenderState`): *fade* rampa el alpha en entrada/salida; *typewriter* revela caracteres proporcional al `enterDurationMs`.
- `Delete`/`Backspace` borra el texto seleccionado; todo respeta undo/redo y autosave.

> El texto todavía **no se exporta** (Fase 6 pendiente). El render de export va a reusar `textRenderState` sobre el canvas offscreen.

### Fonts disponibles
Inter, Segoe UI, Arial, Georgia (serif), **Consolas**, **Cascadia Code**, **Bahnschrift** (técnica/DIN) e **Impact** (display). Las técnicas vienen con Windows 11, así que renderizan sin bundlear archivos. (Para un look cyberpunk garantizado cross-system + export, habría que bundlear un webfont como Orbitron — pendiente.)

---

## 7.7 Imágenes como clips (Fase 5E-B)

Imágenes en el **mismo canal de video**, comportándose como clips. Una imagen es un `Clip` con `kind: 'image'`: tiene `filePath` a un PNG/JPG, sin audio, sin mouse events, con una **duración por defecto de 3s** que se puede alargar/acortar. Reusa TODA la maquinaria de clips (trim, reordenar, split, delete, undo).

> **Fix v0.2.3 — "el clip se ve negro al agregarlo, y bien al reabrir el proyecto"**: cuando un clip de VIDEO se agrega con el editor abierto (GIF convertido, import de video), su `<video>` se crea recién ahí. El swap de textura solo espera `loadedmetadata` (a diferencia de las imágenes, donde sí se espera el decode), y si el playhead cae justo al inicio del clip la deriva es ~0, así que **ningún seek dispara un decode** → la textura quedaba negra hasta reconstruir la escena (salir y volver a entrar). Ahora, mientras `readyState < 2`, el tick empuja un micro-seek (throttled) y **mantiene abierta la ventana de warm-up** hasta que el frame existe de verdad.

### Por qué no desestabiliza al reproductor
El reloj master reconcilia clip activo + textura cada frame desde `locateGlobal(masterMs)`. Los helpers específicos de video (`getActiveVideo`, `getVideoForClip`, `applyEffectivePlaybackRate`) devuelven **null** para clips de imagen, y todos los llamadores tienen guarda `if (v)` → para una imagen son no-op. El `videoSession` crea un `<img>` (no un `<video>`) para esos clips; el tick los muestra como textura estática (sin play/seek/drift) y avanza el master igual. Resultado: 1, 2, N imágenes intercaladas no tocan el camino de video.

### Pestaña "Imágenes" (Media)
- **Importar**: file dialog (png/jpg/webp/gif/bmp), copia a `assets/image-{id}.ext`; las dimensiones reales las resuelve el renderer cargando el asset.
- **GIFs animados (✅ v0.2.2)**: un `.gif` se **transcodifica a MP4** al importarlo (fix v0.2.3: ver la nota de "clip negro al agregarlo" más abajo) (`assets/image-{id}.mp4`, all-keyframes, 25fps CFR, dimensiones forzadas a par) y al soltarlo en el timeline crea un clip `kind:'video'` con su duración real. Por eso **anima en el canvas y en los dos métodos de export**. Antes quedaba fijo en el primer frame: un `<img>` sube su textura WebGL una sola vez, y su animación DOM corre en wall-clock (lo que además haría no-determinista el export cuadro por cuadro). La card del pool muestra el GIF con un `<video>` en loop y la etiqueta `GIF <duración>`. Si la conversión falla, cae al comportamiento anterior (imagen fija).
- **Sólido**: color picker + "Agregar sólido" → pinta un PNG del tamaño del proyecto (Canvas 2D → `saveImageAsset`).
- **Degradados**: 6 presets (Sunset/Ocean/Purple/Mint/Charcoal/Night) que generan un PNG con `linear-gradient`.
- Cada item es una card con thumbnail; **+** lo agrega al final del canal de video (clip de 3s); 🗑 lo borra del pool (el archivo solo se borra si ningún clip lo usa).

### En el timeline
- El clip de imagen se ve en la pista de video (amarillo) con label **"Imagen"**.
- **Bordes arrastrables** para alargar/acortar la duración (mín 300ms, tope 10min). El cuerpo se arrastra para reordenar, igual que un clip de video. (Los clips de video se recortan con split+delete, no con bordes — las imágenes sí tienen bordes porque es su forma natural de durar más/menos.)
- `Delete` lo quita (no va al media-pool de video; su fuente sigue en el pool de imágenes). `Ctrl+Z` lo respeta todo.

> Migración: proyectos viejos backfillean `imagePool: []`. El reconcile de duración al cargar **saltea** los clips de imagen (ffprobe sobre un PNG no tiene sentido). El export de imágenes llega en Fase 6.

---

## 7.8 Transiciones (Fase 5E-C)

Una transición es un **efecto overlay sobre el borde de un clip** (entrada o salida) — NO un cruce entre dos texturas de video (eso pediría una segunda textura simultánea y tocaría el reproductor). Cada `Clip` puede tener `transitionIn` y/o `transitionOut` = `{ kind, durationMs }`.

### Tipos
- **Fade**: rampa el alpha del propio clip (deja ver el fondo detrás).
- **Oscurecer**: overlay negro a pantalla completa que sube/baja.
- **Flash**: igual pero blanco.
- **Pixelado**: `PixelateFilter` sobre el sprite, el tamaño de pixel crece hacia el corte.

`strength` va de 0 (en reposo) a 1 (en el corte/borde). Para un cruce **A→B**, ponés *salida* en A y *entrada* en B del mismo tipo (ej. ambos "Oscurecer" → dip a negro entre clips).

### UI (sin bloques que choquen con el trim)
- Cerca de cada borde del clip, **centrado verticalmente**, hay un **ícono redondo** (✨). Aparece al pasar el mouse; si la transición existe queda fijo y violeta.
- Inset 14px para no pisar los bordes de trim de las imágenes.
- Click en el ícono: si no hay transición la **crea** (Fade 400ms por defecto) y la selecciona; si ya hay, la selecciona → panel **Transición**.
- Panel: **tipo** (Fade/Oscurecer/Flash/Pixelado) + **duración** (slider, tope = 90% de la duración del clip). 🗑 o `Delete` la quita.

### Render (PixiScene)
- `applyTransition({ kind, strength } | null)` cada frame: fade → `videoSprite.alpha`; oscurecer/flash → un `Graphics` negro/blanco a pantalla completa (encima del video+fondo, debajo del texto); pixelado → `PixelateFilter` en el sprite (el dropShadow vive en el container, no chocan).
- Se computa en el tick desde `located.withinClipMs` vs `transitionIn/Out.durationMs`; cerca del corte la *salida* gana si ambas estuvieran activas.
- Aplica a clips de video **y de imagen**. Split reparte las transiciones (el borde nuevo del corte queda limpio); reorder las mantiene; todo es undoable + autosave.

> Las transiciones se exportan junto con todo lo demás (ver §8 Export).

---

## 7.9 Cronómetro / Timer (✅)

Un reloj en pantalla que corre durante el video — pensado para videos de soluciones/demos con tiempo.

- **Agregar**: **Media → Timer → Timer** (se suelta en el playhead). Es un overlay del timeline global (como el texto), sale solo en el export.
- **Panel de propiedades**:
  - **Up / Down**: cuenta hacia arriba o hacia atrás (countdown).
  - **Format**: `mm:ss`, `mm:ss.cs` (centésimas), `hh:mm:ss`, `ss`, `ss.cs`.
  - **Start value (seconds)**: valor inicial (ej. 90 para arrancar en 1:30 en un countdown).
  - **Stop at zero** (solo countdown): no pasa de 0.
  - **Fuente, negrita/itálica, tamaño, color, sombra**.
  - **Extend to end of video**: estira la duración del timer hasta el final. También podés arrastrar el borde derecho del chip en la fila **Timer** del timeline.
- **Keyframes de velocidad**: "Add keyframe at playhead" + editar el multiplicador (×1, ×2, ×0.5…). Entre keyframes la velocidad interpola lineal → el reloj **acelera o frena** suave. Sin keyframes = tiempo real. (Integrador en `src/shared/lib/timerValue.ts`.)
- **Ubicación**: arrastrás el timer sobre el video; las esquinas lo redimensionan.

---

## 7.10 Seguimiento / paneo de zoom (tracking — ✅)

El "look cinematográfico": ya zoomeado, la cámara **panea siguiendo a un sujeto** (la flecha del mouse, un elemento) sin agregar más zoom. Funciona en **cualquier clip**, incluidos videos importados (no necesita el cursor grabado — vos definís el recorrido).

- Se activa por zoom: seleccioná un zoom → panel **Zoom → Tracking (pan) → "Track on video…"**. El preview pasa a **cuadro completo** y podés marcar puntos.
- **Flujo por tiempo** (para anclar cada punto a un momento):
  1. Mové la barra **Time** (dentro del panel, propia del zoom → no deselecciona) al momento que querés; el frame te sigue.
  2. Arrastrá el **dot "+"** sobre el sujeto → queda un **punto de foco anclado a ese tiempo**.
  3. Repetí en otros momentos. Los puntos ya marcados son **dots numerados** (arrastrables para reubicar; su tiempo no cambia) y aparecen como ticks bajo la barra Time.
  4. **Finish tracking** y reproducí: la cámara recorre los puntos con easeInOut por tramo (acelera/frena con un pequeño *settle* en cada punto).
- **Controles**:
  - **Approach**: cuánto se **centra** la cámara en cada punto (0 = lo deja en su lugar del cuadro; 100% = lo centra de lleno, "llega" al punto). Default 100%.
  - **Pan speed**: qué tan rápido viaja entre puntos (el paneo arranca en el tiempo del punto 1).
  - **Extra smoothing** (opcional, default 0): agrega un drift continuo tipo cámara en mano si lo subís.
- Técnicamente: `ZoomEvent.focusKeyframes[]` interpolados en `computeZoomState.ts`; el transform mezcla anclar↔centrar según `panTightness`. Sale igual en el export.

---

## 8. Export a MP4 (Fase 6)

Botón verde **Export** arriba, al lado de "Add recording". Abre un diálogo con la configuración y exporta **todo el timeline** a un `.mp4` (H.264 + AAC).

### Método de exportación (selector en el diálogo)
- **Rápido (tiempo real)** — *default, sin cambios*: captura el canvas en vivo con `MediaRecorder` → WebM → ffmpeg a MP4. Tarda ≈ el largo del video. Ideal 1080p. No puede upscalear arriba de la fuente (rompe el encoder en vivo) → esas resoluciones se deshabilitan.
- **Alta calidad (cuadro por cuadro / determinista)** — `exportDeterministic.ts`: render + encode frame por frame con `VideoEncoder` (`latencyMode:'quality'`, sin descarte de frames) muxeado con **`mp4-muxer`** (usa los timestamps → orden/timing siempre correcto). Para cada frame seekea el video al instante exacto (rápido por all-keyframes) esperando **solo `seeked`** (el `requestVideoFrameCallback` en video pausado no dispara → era la causa de la lentitud anterior). **Fluido y a calidad full a cualquier resolución, incl. 4K**, sin depender del tiempo real; más lento que realtime. Permite upscalear. El audio se mezcla **offline** (`OfflineAudioContext` → WAV, `exportAudio.ts`) y ffmpeg muxea (video copiado + AAC, `muxExportToMp4`).
- Ambos métodos comparten **una sola** escena de export persistente (`getExportScene`) — nunca se crea una tercera Application.

### Configuración
- **Resolución**: 720p / 1080p / 1440p (2K) / 2160p (4K) / Original. El alto se fija por el preset y el ancho sale del aspect del primer clip (siempre par).
- **FPS**: 30 o 60.
- **Calidad de video**: Alta (máxima) / Media / Baja → CRF de x264 (16/20/24, el transcode es offline, no afecta la fluidez) + bitrate del WebM intermedio (factor 0.30 / 0.18 / 0.10 × w·h·fps, que SÍ es la carga del encode en vivo).
- **Calidad de audio**: 256k / 192k / 128k.
- **Incluir audio**: on/off (mezcla el audio embebido de los clips + las pistas de audio del timeline).
- Se recuerda resolución/fps/audio en `project.exportSettings`.

### Cómo funciona (captura en tiempo real, reusa el compositing del preview)
> Se probó un render cuadro-por-cuadro con WebCodecs pero resultó lentísimo (seek por frame a alta resolución) y con timing roto, así que se volvió al **realtime** (que grababa perfecto) y se subió la calidad.

El render reproduce el timeline completo en tiempo real (tarda ≈ el largo del video):
1. **Escena de export PERSISTENTE**: una `PixiScene` a resolución de salida (sin el cap de preview) que se crea una vez y se **reusa/resizea** en cada export. **Nunca se destruye** — destruir una segunda Application de PixiJS corrompe el pool/GC global compartido y dejaba el preview en negro / crasheaba. Mientras exporta, el rAF del preview se pausa (`exportBridge.isExporting`).
2. Elementos `<video>`/`<img>`/`<audio>` propios del export (no tocan los del preview).
3. Un grafo de **Web Audio** mezcla el audio embebido de cada clip (gain = volumen, 0 si muteado/inactivo) + cada pista (con fades vía `gainAt`) → `MediaStreamDestination`.
4. `canvas.captureStream(fps)` + el audio → `MediaRecorder` (WebM vp9/opus a alto bitrate). Un loop (reloj = wall-clock) compone cada frame con los MISMOS métodos del preview → no se olvida ningún canal.
5. Al terminar, el WebM va a main y **ffmpeg** lo transcodea a MP4 (`libx264 -crf … -r fps -c:a aac +faststart`).

### Progreso + final
- Dos etapas con barra: "Componiendo el timeline…" (captura realtime) y "Codificando MP4…" (ffmpeg, % por `time=`).
- **Tiempo estimado (✅ v0.2.2)**: al lado del % se muestra `~Xm YYs restantes`. Se calcula con la velocidad de avance real observada (suavizada con EMA) y descuenta cada segundo; la referencia se reinicia en cada etapa porque corren a ritmos distintos. Aparece a los ~1.5s (antes no hay muestra confiable). Funciona en los dos métodos.
- **Cancelar** en cualquier etapa (corta el loop o mata el ffmpeg).
- Al terminar (estilo Screen Studio): **Abrir carpeta** (`showItemInFolder`), **Reproducir** (`shell.openPath`) y "Exportar otro".

### Qué se exporta (overlays)
Todo lo que ves en el preview sale en el MP4, en **los dos métodos**: zooms (incluido el **paneo/seguimiento** por keyframes), cursor, fondos, crop, transiciones, **texto** y **cronómetro**.

> Bug corregido en v0.2.2: el **cronómetro no aparecía** en el export cuadro por cuadro. El loop determinista llamaba `updateTexts` pero no `updateTimers` (sí estaba en el path realtime), así que los nodos del timer nunca se actualizaban por frame. Ahora ambos paths llaman a los dos.

### Velocidad del export cuadro por cuadro
Es **inherentemente más lento que realtime** porque por cada frame de salida hace: seek exacto del video fuente → render de la escena → `VideoFrame` → encode. El costo dominante medido es el **seek**: los assets del proyecto son *all-keyframes* (`-g 1`, ideal para scrubbing) y por eso pesados (~15 Mbps, 539 MB para 4:46), así que cada seek re-lee del disco.

**El cuello real (medido y corregido en v0.2.3)**: el handler de `vzasset://` respondía los `Range: bytes=X-` **abiertos** con "desde X hasta el final del archivo". Chromium pide exactamente eso en **cada seek**, así que cada seek abría un stream sobre cientos de MB que abandonaba a los pocos KB. Con miles de seeks por export, los streams abandonados se acumulaban y saturaban el disco: el perfilado mostró `seek=466ms` al 25% **subiendo a 618ms** al 50% (el resto de las fases sumaba ~2ms), además de errores y pantallazos negros del driver de video. Ahora cada range se **capea a 4MB** (devolver menos bytes de los pedidos es HTTP válido; el cliente pide el siguiente tramo) y el stream se **destruye** si el cliente abandona la request.

Otras mejoras (**ninguna toca la calidad de salida**):
- Los rangos de `vzasset://` se sirven **cacheables** (`immutable` + `ETag`/`Last-Modified`, que son los validadores que Chromium necesita para poder guardarlos).
- **Se saltea el seek** cuando el frame de salida cae dentro del *mismo frame fuente* (tolerancia = medio frame): re-seekear ahí decodifica la misma imagen. Ayuda cuando el fps de salida es mayor al de la fuente o el clip está ralentizado.
- **Cola del encoder más profunda** (8 → 24): el encoder trabaja sobre frames ya compuestos mientras el loop hace el seek/render del siguiente, en vez de frenar en cada frame.
- **Perfilado por fase** en la consola (cada 25% + resumen final): `seek / compose / render / encode / queueWait` en ms por frame. Sirve para ver dónde se va el tiempo en un caso real.

### Calidad y límites
- **Sin upscaling**: las resoluciones mayores a la fuente se **deshabilitan** (un 1080p exportado a 4K no agrega detalle y, peor, el encode VP9 en vivo a esa resolución produce un webm vacío → error). `targetDims` también clampea al alto de la fuente por las dudas. Si grabás un monitor 4K, la fuente es 4K y las opciones altas se habilitan.
- **1080p**: el preset "Alta" usa CRF 16 + WebM ~0.30 → nítido y fluido (resolución recomendada).
- **Muy alta resolución (4K real)**: el encode VP9 en vivo (MediaRecorder, en Chromium suele ser por **software/CPU**) no llega a los fps → se traba o falla. Una GPU con encode por hardware *podría* ayudar, pero no está garantizado. La solución real (frame-by-frame determinista, fluido en cualquier máquina) quedó pendiente de hacerse bien.
- Si la captura no produce datos, el diálogo ahora avisa con un mensaje claro (en vez del error críptico de ffmpeg).
- Solo MP4/H.264 por ahora (WebM/HEVC/GIF y presets por plataforma en el roadmap).

---

## 8.5 Distribución: ícono, instalador y auto-update (Fase 7)

### Ícono
`sources/icon.svg` (la marca clipclicks: C blanca + > cyan) se procesa con `scripts/make-icons.mjs` (sharp + png-to-ico): se compone sobre un cuadrado redondeado oscuro y genera `build/icon.png` (1024) + `build/icon.ico` (multi-size). electron-builder lo usa para el `.exe` y el instalador; en dev la ventana lo toma de `build/icon.png` (`BrowserWindow.icon`).

### Instalador (NSIS)
`npm run dist` → `build/Clipclicks Studio-Setup-<version>.exe`. Config en `electron-builder.yml`: NSIS no-oneClick (elige carpeta), accesos directos en escritorio + menú inicio, `asarUnpack` de uiohook-napi + ffmpeg-static, `npmRebuild: false` (uiohook es N-API, no necesita recompilar → no requiere Visual Studio).
- **Gotcha de Windows**: electron-builder baja `winCodeSign` y al extraer sus symlinks de macOS falla sin Developer Mode/admin. `scripts/prep-build.mjs` (corre antes del build) pre-extrae winCodeSign **sin la carpeta `darwin`** en el cache → el build no necesita privilegios de symlink. Es idempotente.
- **Sin firmar** (no hay certificado): al instalar, Windows SmartScreen avisa "editor desconocido" → "Más info → Ejecutar de todos modos". Normal para QA.

### Auto-update (electron-updater + GitHub Releases)
- `publish` en `electron-builder.yml` apunta a `github.com/eflores1989/clipclicks` con `releaseType: release` (se publica directo, sin paso manual de "Publish"). `npm run release` (con `GH_TOKEN` = token clásico con scope `repo`) sube instalador + `latest.yml` + `.blockmap` a un Release publicado.
- `electron/main/updater.ts`: SOLO en builds empaquetados, chequea al arrancar (a los 4s) y cada 30 min, descarga en background y avisa al renderer. `UpdateBanner.tsx` muestra "Actualización lista — Reiniciar" → `quitAndInstall`. **No hay botón de "buscar actualizaciones"**: es automático (relanzá la app para forzar un chequeo).
- La **versión instalada** se muestra en el footer del launcher ("Clipclicks Studio vX.Y.Z", desde `app.getVersion()`) — sirve de trazabilidad para QA.
- **El repo debe ser PÚBLICO** para que el auto-update lea `latest.yml` sin token (si es privado, el chequeo falla en silencio). Clipclicks/eflores1989 es público.
- Flujo QA: publicás v0.1.0 → instalan → publicás v0.1.1 → la app instalada detecta y se actualiza.

---

## 8. Zoom events

### Generación automática al grabar

Cuando termina la grabación, el algoritmo de `generateZooms` procesa los `mouseEvents` y produce `ZoomEvent` automáticos. Los pasos:

1. **Filtra** solo `down` events (clics) + descarta clics a <2% de los bordes si `ignoreEdgeClicks=true`.
2. **Detecta drags**: `down` → `up` con desplazamiento > 40px y duración > 200ms → un zoom `mode: 'region'` cubriendo el bbox del drag, con `cursorBehavior: 'smoothed'` (sigue el cursor durante el drag).
3. **Clustering temporal + espacial**: clics dentro de **600ms** y a menos de 200px se agrupan en un solo "cluster" (= un solo zoom sostenido). Esto evita zooms duplicados por doble-click o ráfaga.
4. **Por cluster**: focal = centroide ponderado (último click pesa ×1.5). Scale base = 2.0×. Boosts: +0.2 si el cluster tiene >3 clics, +0.3 más si es ráfaga (>5 clics en <600ms).
5. **Resolución de overlaps**: si dos zooms se superponen + el gap mínimo (400ms), el primero se recorta. **No fusiona** (antes lo hacía y era buggy — todos los zooms terminaban siendo uno solo cuando los focals estaban cerca).
6. Salida: `ZoomEvent[]` ordenados por `startMs`, todos con `source: 'auto'`.

### Crear zoom manual

- Posicioná el playhead donde quieras el zoom.
- Presioná **Z**.
- Aparece un chip naranja de 2s, centrado en el frame, scale 2.0, modo `static`. Queda auto-seleccionado.
- Live update en el preview a medida que ajustás sus parámetros.

### Editar un zoom

Click en cualquier chip → el panel derecho muestra **ZoomProperties** (reemplaza el panel general):

#### Header
- Badge `auto` o `manual`.
- 🔒 **Lock toggle**: zooms locked no se modifican al "Regenerate auto-zooms" desde el botón ⟲ del header.
- 🗑 **Delete**: borra el zoom (también con tecla **Delete/Backspace**).

#### Métricas
- start, end, duration (mostradas en formato `Xms` o `X.XXs`).

#### Scale
- Slider 1.0× → 4.0×, paso 0.05.

#### Timing
- **Enter** (50ms → min entre `(total - exit - 100)` ó `max`): cuánto dura la transición de entrada.
- **Enter easing**: `linear` / `easeIn` / `easeOut` / `easeInOut` / `spring`.
- **Exit** (mismo rango) + **Exit easing**.
- (El hold time = total − enter − exit se recalcula automáticamente.)

#### Cursor behavior

Tres modos en pills:

| Modo | Comportamiento |
|---|---|
| **Static** | El focal se queda fijo en `target.nx/ny`. Útil para "zoom en este botón". |
| **Follow** | El focal salta al cursor cada frame. Útil para drags rápidos (puede dar jitter en clics normales). |
| **Smoothed** | El focal sigue al cursor con LERP exponencial (drift suave). Recomendado para mostrar listas largas, menús desplegables, etc. |

Si el modo es **Smoothed**, aparece un slider **Smoothing** (0–100%). Más alto = drift más suave (y más lag). Default 85%.

#### Focal point
- Solo se muestra en modo **Static**. En Follow/Smoothed el focal lo determina el cursor en runtime.
- Sliders **X** e **Y** (0–100% del frame).

### Edit en la timeline

- **Drag del centro del chip**: mueve start/end conservando duración. Clampea a los bordes del clip que contiene el zoom.
- **Drag de los bordes** del chip (8px a izquierda/derecha): resize de ese lado. Re-balancea enter/exit si la nueva duración los obliga.
- Cada drag se **coalesce en una entry de history** (Ctrl+Z revierte el drag completo).
- **Click**: selecciona, abre panel.
- Los **chips locked** quedan grisados y no responden al drag.

### Regenerar auto-zooms

Botón ⟲ en el header del editor → confirma con un dialog nativo → re-corre `generateZooms` sobre TODOS los clips. Los zooms `manual` o `locked` se **preservan** (no se tocan). Útil después de editar `autoZoomConfig` (no expuesto aún en UI; está en `project.json`).

### Cómo se renderiza

- Cada frame del rAF tick, `computeZoomState` resuelve qué zoom está activo en el `currentTime` del clip activo, devuelve `{ scale, focalNx, focalNy }`.
- PixiScene aplica la transformación al video sprite: `sprite.x = padX + focalNx × W × (1 - scale)`, `sprite.y = padY + focalNy × H × (1 - scale)`, `sprite.width = W × scale`, `sprite.height = H × scale`. El mask con corner-radius queda fijo en el "frame" — el sprite hace overflow y se clipea.

---

## 9. Operaciones sobre clips

### Split (✂ tijera o tecla `S`)

- Posicionás el playhead en cualquier momento de la timeline.
- Click en ✂ o presionás `S`.
- El clip activo se parte en dos en ese `localMs` exacto:
  - **Izquierda**: clip original con `outMs = localMs`.
  - **Derecha**: nuevo clip, mismo `filePath`, con `inMs = localMs` y mismo `outMs` que el original.
- **Mouse events**: se redistribuyen según `e.t` vs `localMs`.
- **Zoom events**: cada zoom va al lado donde está su mayoría. Si el zoom **cruza** el corte, se clipea al rango del lado al que se asigna (su otra mitad se descarta). Si después del clipeo el zoom queda con menos de 200ms, se descarta entero.
- **Speed segment**: ambas mitades heredan la misma speed.
- **Salvaguarda**: si el playhead está a menos de 200ms de un borde del clip, el split se cancela (evita clips inútiles).

### Delete clip (= mover al Media pool)

- Click en un clip → selección (resaltado azul + badge "selected" en el panel derecho).
- Presionás **Delete** o **Backspace**, O click en el 🗑 del panel.
- El clip se remueve de la timeline. Los demás clips reflowean a la izquierda (ripple).
- **El clip NO se pierde**: se mueve al **Media pool** (tab "Media" del panel derecho).
- **Mínimo un clip en la timeline**: no podés borrar el último.
- **Para recuperar**: abrí el tab Media → encontrás el clip ahí → botón **+** lo agrega al final, o **drag** lo inserta donde quieras.

### Seleccionar un clip

- Click en el cuerpo del segmento en la pista Video.
- El panel derecho muestra **Clip N selected** + sliders de Speed específicos de ese clip.
- Click en empty timeline space deselecciona.
- Si hay varios clips y ninguno está seleccionado, el panel muestra el mensaje "Click on a clip segment in the timeline to edit its trim and speed" — esto previene aplicar speed al clip equivocado por accidente.

### Add recording (re-grabar dentro del proyecto)

- Botón **+ Add recording** en el header del editor.
- Click → te lleva al source picker → grabás → processing → vuelve al editor con el **nuevo clip insertado al final** de la timeline + auto-seleccionado.
- Cada clip nuevo recibe su propio `recording-<uuid>.mp4` dentro de `assets/`, sus propios mouseEvents y zoom auto-generado.
- Una vez insertado al final, **arrastralo a otra posición** con drag-to-reorder (ver abajo).

### Media pool (tab "Media" del panel derecho)

El panel derecho tiene dos tabs:
- **Project**: contenido actual (Background, Clip seleccionado, Speed).
- **Media**: el pool con sub-tabs **Video** | **Audio** | **Images** (las dos últimas pendientes de 5D y futuras).

El badge azul al lado de "Media" muestra cuántos items hay en el pool.

**Sub-tab Video** muestra una lista de cards, cada una con:
- Ícono de film.
- Nombre = fecha de grabación (ej: `2026-05-25 14:30`).
- Duración efectiva + número de clicks capturados.
- Botón **+** (Add to timeline): inserta el clip al final de la timeline.
- Botón **🗑** (Delete forever): te pide confirmación, **borra el archivo MP4 de `assets/`** y la entrada del pool. Esto es **irreversible**.

**Drag desde el pool a la timeline**:
- Click+drag una card → después de 5px de movimiento se activa el drag.
- Movés el puntero sobre la timeline → aparece la **línea azul vertical** indicando dónde se va a insertar.
- Soltás dentro de la timeline → el clip se inserta en esa posición y se quita del pool.
- Soltás fuera de la timeline → cancela.

**Cuándo van clips al pool**:
- Cuando borrás un clip de la timeline (Delete key o botón 🗑 del panel "Project" cuando hay un clip seleccionado).
- TODO el estado del clip se preserva (mouseEvents, zoomEvents, speedSegments, trim).

### Drag-to-reorder de clips

- Click+drag el **cuerpo** del segmento de un clip en la pista Video.
- Después de 5px de movimiento se activa el modo drag (el clip arrastrado se ve semi-transparente).
- Una **línea vertical azul** aparece en la timeline en la posición donde se va a soltar el clip — entre cualquier par de clips, al inicio, o al final.
- Soltás → el clip se mueve a esa posición. La timeline reflowea. Los demás clips se acomodan.
- El playhead permanece en su posición global (re-seekea al nuevo clip que ahora ocupa esa posición).
- Si soltás sin haberte movido lo suficiente, cuenta como un **click normal** (selecciona el clip, no lo mueve).

### ❌ Trim removido

Originalmente había handles amarillos a los costados de los segmentos para arrastrar y recortar (`inMs`/`outMs`). Confundía: los zooms se "movían" visualmente porque la timeline se rescala, y la UX era oscura. **Reemplazado por el flujo "split + delete"**:
- Para acortar el inicio → split en el segundo X, delete del clip izquierdo.
- Para acortar el final → split en el segundo Y, delete del clip derecho.
- Para sacar un pedazo del medio → split inicio, split fin, delete del medio.

---

## 10. Velocidad por clip

Sección **Speed** del panel derecho, aplica al clip seleccionado (o al primero si no hay selección).

- **Presets**: 0.5×, 1×, 1.5×, 2×, 3×, 4×.
- **Custom slider**: 0.25× → 4×, paso 0.05.
- Internamente se guarda como `clip.speedSegments[0]` (uno por clip; múltiples segments es V1.3 post-MVP).
- Speed=1 vacía el array.

### Efectos
- **En el preview**: `video.playbackRate = clipSpeed × Transport.previewRate`.
- **En la timeline**: el segmento de ese clip aparece **más corto** (su duración efectiva es `(outMs − inMs) / speed`). Un clip de 30s a 2× ocupa 15s de timeline.
- 🚧 **En el export**: lo respetará en Fase 6 vía FFmpeg `setpts`.

---

## 11. Cursor enhancement

✅ **Fase 5F + 5F.2** completas. El sistema tiene **dos partes**:

1. **Al grabar**: opcionalmente se puede capturar el video **sin** el cursor del sistema operativo (`cursor: 'never'` vía `getDisplayMedia`). El clip se marca con `systemCursorCaptured: false` y la app dibuja su propia flecha enhanced.
2. **En el editor**: cuatro estilos de cursor renderizados encima del video, eligibles por proyecto.

### Capturar cursor del sistema ✅

Implementado en 5F.4. Checkbox **"Capturar cursor del sistema"** en el selector de fuente:
- **Tildado (default)**: pipeline normal con `getUserMedia` + `MediaRecorder` + WebM → MP4 transcode. La flecha de Windows queda en el video. `Clip.systemCursorCaptured = true`. Estilos recomendados: `Pulse` u `Oculto` (no doblar el cursor).
- **Destildado**: main process lanza `ffmpeg + gdigrab -draw_mouse 0` que escribe directo un MP4 all-keyframes en el staging — **el cursor de Windows nunca queda en el video**. `Clip.systemCursorCaptured = false`. Estilos recomendados: `Flecha` o `Dot` (la flecha enhanced es la única cursor visible — look Screen Studio puro).

**Limitación**: ffmpeg `gdigrab` captura por offset+size de pantalla, no por ID de ventana. Por eso el toggle queda **deshabilitado** cuando elegís un source de tipo "Window" en el SourcePicker — sólo screen captures soportan el modo native. Para grabar ventanas sin cursor habría que extender a `gdigrab -i title=...` (frágil, los títulos cambian) o cambiar a `ddagrab` (no incluido en ffmpeg-static). Va a post-MVP.

**Cómo se decide el pipeline**:
- `useNativeCapture = !captureSystemCursor && source.kind === 'screen'`
- Si true: el renderer NO usa `getUserMedia` / `MediaRecorder` / rVFC. main spawn ffmpeg y se encarga de todo.
- Si false: el renderer usa el path clásico (MediaRecorder + rVFC anchor).

**Sync en modo native**: similar a rVFC pero del lado de main — parseamos el stderr de ffmpeg buscando la primera línea `frame=    1 fps=...`. Cuando aparece, registramos `Date.now()` como el momento del primer frame encoded. `firstFrameOffsetMs = primer_frame_epoch - startedAtEpoch` se devuelve en la respuesta de `RECORDER_STOP` y el renderer lo usa para shiftear los mouseEvents igual que en el flow MediaRecorder.

**Beneficio colateral**: ffmpeg ya escribe MP4 all-keyframes con `-g 1`, así que `createProjectFromStaging` salta el paso de transcode webm→mp4. La fase "transcoding" del processing pasa de 1-3s a casi instantáneo en modo native.

**Pausa/resume**: no soportada en modo native (ffmpeg gdigrab no tiene un mecanismo limpio de pausa). El botón de pausa se ignora con un warning de consola. Van a hidearlo del UI cuando esté el indicador de modo en el RecordingBar.

### Sync video ↔ eventos del mouse

Bug crítico fixeado en 5F.3. Hay un delay entre cuando `uiohook` empieza a capturar mouseEvents y cuando `MediaRecorder` produce el primer frame del video. Ese delay puede ser de cientos de ms a 2 segundos (Chromium inicializa el codec + espera al primer sample del display). Sin compensarlo, los eventos quedan **adelantados** al video: todas las animaciones (pulse, scale, follower) aparecen tarde — el usuario ve la flecha enhanced ir al lugar del clic 1-2 segundos después.

**El fix (precisión al frame)**:
1. Apenas tenemos el `MediaStream`, montamos un `<video>` oculto con `srcObject = stream` y registramos `requestVideoFrameCallback`.
2. Cuando rVFC dispara con el PRIMER frame entregado por Chromium, leemos `metadata.captureTime` (timestamp del momento en que el OS capturó ese frame, en `performance.timeOrigin`-relative ms) y lo convertimos a epoch.
3. `videoStartOffsetMs = primer_frame_epoch - startedAtEpoch` — esa es la latencia real del codec.
4. Antes de pasar mouseEvents a `createProjectFromStaging` / `appendClipFromStaging`, shifteamos cada `t -= offset` y descartamos los que quedan negativos (ocurrieron antes del primer frame).

**Por qué `Date.now()` después de `mediaRecorder.start()` no alcanzaba** (intento previo): `.start()` es no-bloqueante; retorna apenas Chromium acepta el pedido, no cuando el encoder produjo el primer frame. La diferencia entre esos dos momentos es la latencia que el usuario percibía como "lag de 1-2 segundos".

Hay un safety net de 4 segundos: si rVFC no dispara (algo raro en Electron 33+), caemos al `Date.now()` coarse para que `stop()` nunca quede colgado.

### Los cuatro estilos

| Estilo | Qué dibuja | Cuándo elegir |
|---|---|---|
| **Oculto** | Nada | El video se ve tal cual lo grabaste (con el cursor de Windows si lo capturaste). |
| **Pulse** | Sin follower; anillo que crece + se desvanece en cada clic. | Grabaciones **con** cursor de Windows — agrega feedback visual al clic sin doblar la flecha. |
| **Dot** | Punto con halo siguiendo al mouse + escala animada al clic. | Grabaciones **sin** cursor de Windows, si te gusta el look minimalista. |
| **Flecha** | Flecha estilo Windows pointer siguiendo al mouse + escala animada al clic. | Grabaciones **sin** cursor de Windows — el look Screen Studio. |

### Mecánica común

- **Posición**: los `mouseEvents` se LERPean entre samples consecutivos (`cursorAt`), después se normalizan a `[0,1]` y se proyectan a coords de canvas a través del `videoSprite.x/y/width/height` actual. Así el cursor sigue al mouse aún bajo zoom.
- **Smoothing** (solo Dot/Flecha): LERP frame-a-frame entre la posición LERPed y la suavizada anterior. `0%` = snap, `25%` = suave sutil (default), `50%+` = cinematográfico tipo Screen Studio. Se resetea al cambiar clip, al hacer scrub, o al cambiar de sprite.
- **Bounds check**: si el cursor cae fuera del rectángulo visible del video (zoom alto con focal lejano), se oculta. Nada de flecha flotando sobre el padding del background.
- **Animación de clic**: scale para Dot/Flecha (1× → peak → 1× con curva sin) o pulse ring para Pulse. Es **stateless** — en cada frame se escanean los `mouseEvents` del clip activo y se computan los efectos cuyo `t` está dentro de la ventana de animación. Eso significa que **scrubear** la timeline replica los efectos correctamente sin estado adicional.

### Panel "Cursor"

Sección entre Shadow y el indicador de fase. Selector de estilo (4 botones), luego controles según corresponda:
- Pulse: color del anillo, radio máximo, duración.
- Dot / Flecha: color, opacity, size (multiplicador), smoothing + toggle de animación al clic con duración y pico de escala.
- Oculto: nada para configurar.

### Migración

Proyectos guardados antes de 5F.2 se migran automáticamente:
- `cursor.style` ← `'pulse'` (no asumimos que querían el "dot follower" que ahora se reconoce como feo).
- `Clip.systemCursorCaptured` ← `true` (todas las grabaciones viejas tienen el cursor nativo).
- Los colores y duración previos se preservan en `cursor.click.pulseColor` / `durationMs`.

### Limitaciones conocidas (van a post-MVP)

- **No hay catálogo de cursores custom** (formas alternativas tipo flecha estilizada, cuadrado, mac-style, etc.).
- **Sin trail / hover preview / scroll indicator** — solo Dot/Flecha follower + scale al clic.

---

## 12. Autosave + History (Undo/Redo)

### Autosave
- Cualquier mutación al store del proyecto marca `dirty: true` y dispara un debounce de **1.5 segundos**.
- Cuando se cumple, se escribe el `project.json` y se rota un backup en `autosave/` (mantiene 3 más recientes).
- El indicador `●` amarillo al lado del nombre desaparece al guardarse.
- Si cerrás la app mid-edit antes del debounce, perdés los últimos cambios. Si abrís el `.vzproj` próxima vez, está el último estado guardado.

### History (undo/redo)
- Cada mutación con `record: true` (default) se persiste como un patch de Immer (forward + inverse).
- **Ctrl+Z**: undo. **Ctrl+Y** o **Ctrl+Shift+Z**: redo.
- Stack máximo 100 entries.
- Los drag de sliders, drag de chips, drag de trim edges se **coalescen en una sola entry** (un drag = un undo) gracias a snapshots de Refs.
- Al abrir un proyecto, el history se **vacía** (los cambios pre-apertura no son revertibles).

---

## 13. Atajos de teclado

| Atajo | Acción | Contexto |
|---|---|---|
| **Space** | Play / Pause | Editor (excepto si hay un `<input>` enfocado) |
| **Z** | Crear zoom manual en el playhead | Editor |
| **S** | Split clip en el playhead | Editor |
| **Delete** / **Backspace** | Borrar zoom o clip seleccionado | Editor |
| **Ctrl+Z** | Undo | Editor |
| **Ctrl+Y** o **Ctrl+Shift+Z** | Redo | Editor |
| **←** | Atrás 1 segundo | Editor |
| **→** | Adelante 1 segundo | Editor |

---

## 14. Motor de playback multi-clip

Detalle técnico relevante si algo se ve raro:

- Cada clip tiene su propio `HTMLVideoElement` off-DOM (no se renderiza directo en el DOM; PixiJS samplea sus frames vía `Texture.from(videoEl)`).
- `videoSession.ts` mantiene un `Map<clipId, HTMLVideoElement>` con todos pre-loaded.
- **Reloj master**: el playhead lo driveea el reloj virtual `masterMs` (ver §7.5 "Reloj de reproducción"), NO el `currentTime` de ningún video. El clip que se ve cada frame se resuelve con `locateGlobal(masterMs)`.
- **Dos estados independientes que el tick reconcilia cada frame**:
  1. *Clip activo de `videoSession`* — el `<video>` que suena/avanza. Se sincroniza con `setActiveClip()` si no coincide con el located.
  2. *Textura de la escena* (`sceneVideoClipId`) — qué video está en el sprite de PixiJS. Si no coincide con el clip located, se swapea con `setActiveVideo()`. **Clave**: esto corre aunque el clip activo haya cambiado por fuera (ej. *jump-to-start* / scrub setean el clip activo pero no la textura) — si no, el canvas se queda **pegado en el frame del clip anterior**.
  3. Tras cada swap se re-arma una ventana de ~1.2s en la que, estando pausado, se fuerza el upload del frame cada tick (`forceVideoFrame`), porque un `VideoSource` pausado no sube su frame decodeado solo. Lo mismo al abrir el editor (ventana inicial de 2s) → mata el "canvas negro" en cold open.
- **Switching durante playback**: cuando `masterMs` cruza al slot del siguiente clip, el located cambia → se activa el nuevo `<video>` (seek a `inMs` si hace falta) y se swapea la textura. El video viejo, ya `ended`, se deja con su último frame hasta el cruce (no se re-reproduce).
- **Scrub a otro clip**: igual, vía `locateGlobal()` sobre `masterMs`.
- Costo: cada clip = un decoder de video adicional. Para proyectos con muchos clips del mismo archivo (típico después de varios splits), todos comparten el mismo archivo via HTTP cache pero usan decoders distintos. Aceptable para uso típico (< 10 clips).

### Custom protocol `vzasset://`

Los videos se sirven desde disco vía un protocolo custom (`vzasset://video/<encoded-path>`):
- Registrado en `electron/main/index.ts` con `protocol.registerSchemesAsPrivileged` y `protocol.handle`.
- Implementa **Range requests** (`206 Partial Content`) — sin esto, los `<video>` HTML5 no podían seekear y todo se rompía después del primer play (descubrimos esto en Fase 2).
- Restringe el acceso a paths dentro de `userData/Projects` y `userData/staging` por seguridad.

---

## 15. Estado del MVP

### ✅ Cerrado
- Fase 0: Setup (Electron + Vite + React + TS + Pixi)
- Fase 1: Grabación con captura de mouse global
- Fase 2: Formato `.vzproj` + transcoding all-keyframes + thumbnails + custom protocol
- Fase 3: Editor real con PixiJS (background + video + transform) + stores Zustand
- Fase 4: Auto-zoom desde clics + edición en timeline + cursor-follow modes
- Fase 5A: Refactor multi-clip (data model)
- Fase 5B (parcial): velocidad por clip ✅, trim ❌ (removido por confuso)
- Fase 5C.1–5C.5: Multi-clip playback engine + segmentos + split + delete

### 🚧 Pendiente del MVP expandido
- **Fase 5C.6.A** ✅ Add recording: botón en el header del editor → graba → inserta al final + drag-to-reorder.
- **Fase 5C.6.C** ✅ Media pool: borrar un clip lo mueve al pool en vez de perderlo; click + o drag para re-insertar; "Delete forever" elimina el archivo definitivamente.
- **Fase 5F** ✅ Cursor enhancement: halo configurable + click pulse animado + smoothing + panel propio (ver sección 11).
- **Fase 5D** — Audio: captura de audio del sistema (loopback WASAPI) + mic + pista con waveform + controles (volume, mute, fade).
- **Fase 5E** — Text overlays: tipo `TextEvent` + pista de texto + render Pixi.Text + presets (titular, lower-third, callout, caption).
- **Fase 6** — Export final: render frame-by-frame del compositing → FFmpeg encoding → MP4. Honra trim, speed, multi-clip, zooms, texto, audio.

### 🚧 Post-MVP (V1.x)
Ver el plan completo en `C:\Users\Usuario\.claude\plans\abri-este-proyecto-porque-ticklish-kernighan.md`. Incluye: catálogo extendido de backgrounds, cámara webcam PiP, subtítulos automáticos via Whisper, cloud sync (estilo Tella), Mac/Linux builds, etc.

---

## 16. Checklist de verificación end-to-end

Para probar todo lo que existe hoy:

1. **Launcher**:
   - [ ] Abre la app, verás las 3 tarjetas + lista de recientes.
   - [ ] "Open project" abre el dialog nativo y carga un `.vzproj` existente.
   - [ ] Click en un proyecto reciente lo abre directo.

2. **Grabar**:
   - [ ] "New recording" → source picker → tabs Screen y Window listan correctamente.
   - [ ] Selección + Record → countdown 3-2-1.
   - [ ] Ventana se achica a barra flotante, draggable, always-on-top.
   - [ ] Pause + Resume funcionan. Cancel descarta sin guardar.
   - [ ] Stop → processing con tres stages (transcoding %, thumbnails %, finalizing) → editor abre.

3. **Editor — preview**:
   - [ ] Primer frame visible. Background "Sunset Gradient" default.
   - [ ] Play / Pause / Space funcionan. Video reproduce fluido a 30fps preview.
   - [ ] Scrub con el mouse en la timeline mueve el playhead Y el preview.
   - [ ] Jump start (⤴), step back (⏮), step forward (⏭), jump end (⤵) van a su destino.

4. **Backgrounds**:
   - [ ] Click en cualquier tile del panel cambia el background en vivo.
   - [ ] Sliders de padding, corner radius, shadow (blur/Y/opacity) → cambios en vivo.
   - [ ] Toggle "Drop shadow enabled" off → la sombra desaparece.

5. **Zooms**:
   - [ ] Después de grabar con varios clics, ves chips azules en la pista Zoom.
   - [ ] Click en un chip → panel derecho muestra ZoomProperties.
   - [ ] Drag el centro del chip → se mueve. Drag los bordes → resize.
   - [ ] Cambiar Scale, Enter/Exit easing, Cursor behavior → cambio en vivo en el preview.
   - [ ] **Z** crea zoom manual en el playhead (naranja). Quedan auto-seleccionados.
   - [ ] **Delete** borra el zoom seleccionado.
   - [ ] **Cursor mode Smoothed** durante una grabación con movimiento de mouse → el zoom sigue el cursor con drift suave.
   - [ ] Botón ⟲ regenera auto-zooms preservando los manual/locked.

6. **Clips (5C)**:
   - [ ] **S** o ✂ → el clip se parte en dos donde está el playhead. Aparecen Clip 1 y Clip 2 coloreados distinto.
   - [ ] Play cruzando el borde entre clips → cambio fluido, sin glitch.
   - [ ] Click en un clip lo selecciona (resaltado azul). Panel derecho muestra "Clip N selected".
   - [ ] **Delete** borra el clip seleccionado. Los demás reflowean a la izquierda.
   - [ ] No podés borrar el último clip.
   - [ ] Speed presets (1×, 2×, etc.) y custom slider cambian la duración efectiva del clip en la timeline.
   - [ ] Setear speed distinta en cada clip → cada uno reproduce a SU velocidad cuando el playhead pasa.

7. **Add recording + reorder (5C.6.A/B)**:
   - [ ] Botón **+ Add recording** en el header del editor → source picker → grabás → vuelve al editor con el nuevo clip al final, auto-seleccionado.
   - [ ] Click+drag sobre el cuerpo de un clip → línea azul vertical indica drop position → soltás → reordena.
   - [ ] Drag a una posición igual a la actual → no hace nada.
   - [ ] Después de reordenar, el playhead se queda en su tiempo global pero ahora corresponde al clip que ocupa esa posición.

8. **Media pool (5C.6.C)**:
   - [ ] Panel derecho tiene dos tabs: Project y Media. Badge azul muestra count del pool.
   - [ ] Borrar un clip de la timeline → desaparece de la timeline pero aparece como card en el tab Media.
   - [ ] Botón **+** en una card del pool → agrega el clip al final de la timeline.
   - [ ] Drag de una card sobre la timeline → línea azul muestra posición → soltás → inserta en ese punto.
   - [ ] Botón **🗑** en una card → confirma → archivo borrado del disco + card desaparece del pool. Esto NO es reversible.
   - [ ] Un clip restaurado del pool mantiene TODOS sus zooms, mouseEvents, speedSegments y trim original.

7. **Persistencia**:
   - [ ] Cambiar algo → `●` amarillo aparece. 1.5s después desaparece.
   - [ ] Cerrar Electron, volver a abrir, abrir el mismo proyecto → todos los cambios persistieron.
   - [ ] `Ctrl+Z` revierte cada acción discreta. `Ctrl+Y` rehace.

Si todo el checklist pasa, **el MVP cerrado a 5C.5 está funcionando**. Lo que falta son las cuatro sub-fases siguientes (5C.6, 5D, 5E, 5F) y el export final (Fase 6).

---

## 17. Quirks conocidos / cosas a saber

- **Modo dev de Electron en este entorno**: el shell del harness setea `ELECTRON_RUN_AS_NODE=1` que rompe el main process. Hay un launcher en `scripts/run.mjs` que lo limpia. Si alguna vez ves "Cannot read properties of undefined (reading 'isPackaged')", reviste eso.
- **CSP estricta**: `script-src 'self'` sin `unsafe-eval`. PixiJS por default usa `new Function()` para shaders. Importamos `pixi.js/unsafe-eval` en `src/main.tsx` para usar el compilador AOT.
- **WGC capture warnings**: Chromium tira `wgc_capture_session.cc(228) ProcessFrame failed: -2147467259` durante grabaciones. Es ruido (deduplicación de frames). Está filtrado en `scripts/run.mjs`.
- **fluent-ffmpeg no se usa**: probamos en Fase 2, se cuelga silenciosamente en `.save()`. Reemplazado por `child_process.spawn` directo con `ffmpeg-static`.
- **Multi-monitor**: si grabás una ventana que está en un monitor secundario con coordenadas globales negativas, la app traduce automáticamente. Los eventos del mouse en monitores que NO se están grabando se descartan.

---

*Última actualización: cierre de Fase 5C.5 (multi-clip + split + delete, trim removido).*
