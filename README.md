# Clipclicks Studio

**Grabación de pantalla con zoom automático en cada clic — para Windows.** Una alternativa a Tella/Screen Studio: grabás, y el editor le pone zoom suave a cada clic, backgrounds elegantes, y exportás un MP4 listo para compartir.

> Estado: **MVP en QA**. App de escritorio (Electron + React + PixiJS).

## ✨ Qué hace

- **Grabación** de pantalla, ventana o monitor — con o sin el cursor del sistema.
- **Auto-zoom**: detecta los clics del mouse y genera zooms suaves automáticamente (editables).
- **Backgrounds** con padding, esquinas redondeadas y sombra.
- **Editor multi-clip**: trim, velocidad, reordenar, split, "Add recording".
- **Audio**: mic + audio del sistema, importar pistas, waveform, volumen, fades, extraer audio de un clip.
- **Texto** overlay (fade / typewriter), **imágenes** como clips (con generador de fondos sólidos/degradados), **transiciones** (fade / oscurecer / flash / pixelado).
- **Cursor enhanced** (dot / flecha) con animación de click y suavizado.
- **Crop / aspect ratio**, **undo/redo**, **autosave**.
- **Export a MP4** con dos métodos: **Rápido** (tiempo real, ideal 1080p) y **Alta calidad** (cuadro por cuadro con WebCodecs, fluido a cualquier resolución incl. 4K).
- **Auto-update** vía GitHub Releases.

## 📥 Instalar (QA / usuarios)

Descargá el instalador del último release:
**https://github.com/eflores1989/clipclicks/releases/latest** → `Clipclicks-Studio-Setup-x.y.z.exe`

Instalá dejando la **carpeta por defecto** (no Program Files → no pide admin). En el primer arranque Windows muestra SmartScreen porque la app aún **no está firmada**: **Más info → Ejecutar de todos modos**. De ahí en más se **actualiza sola**.

## 🛠️ Desarrollo

```bash
npm install
npm run dev          # app en modo desarrollo (HMR)
npm run typecheck    # chequeo de tipos
```

## 📦 Build & Release

```bash
npm run dist         # construye el instalador NSIS local → dist/
npm run release      # construye y PUBLICA a GitHub Releases (requiere GH_TOKEN clásico con scope repo)
```

Para publicar una actualización: subí la `version` en `package.json`, `git push`, y `npm run release`. Las apps instaladas la detectan y se actualizan solas.

## 🧱 Stack

Electron 33 · electron-vite · React 18 + TypeScript · Zustand + Immer · PixiJS v8 (WebGL) · ffmpeg-static · uiohook-napi · WebCodecs · electron-builder + electron-updater.

## 📄 Estructura

```
electron/        # proceso main + preload (recorder, ffmpeg, projectFs, updater)
src/             # renderer (React): features/ (launcher, recorder, editor, export, update), stores/, shared/
build/           # icono del instalador (generado desde sources/icon.svg)
scripts/         # build/icon helpers
```
