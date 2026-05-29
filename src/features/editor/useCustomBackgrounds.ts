import { useEffect, useState } from 'react';
import {
  CUSTOM_BG_PREFIX,
  listCustomBackgroundEntries,
  onCustomBackgroundsChange,
  registerCustomBackground,
  replaceCustomBackgrounds,
  unregisterCustomBackground,
  type CustomBackgroundEntry,
} from './backgrounds';

let hydrated = false;
let hydratePromise: Promise<void> | null = null;

/**
 * Load the persisted custom-background list from the main process and
 * populate the renderer-side registry. Idempotent — only the first caller
 * actually fetches; subsequent calls await the cached promise.
 */
export function ensureCustomBackgroundsLoaded(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const list = await window.videoZoom.customBackgrounds.list();
      const entries: CustomBackgroundEntry[] = await Promise.all(
        list.map(async (b) => ({
          id: b.id,
          name: b.name,
          kind: b.kind,
          filePath: b.filePath,
          assetUrl: await window.videoZoom.project.assetUrl(b.filePath),
        })),
      );
      replaceCustomBackgrounds(entries);
      hydrated = true;
    } catch (err) {
      console.warn('Failed to load custom backgrounds:', err);
      hydrated = true;
    }
  })();
  return hydratePromise;
}

export function useCustomBackgrounds(): {
  entries: CustomBackgroundEntry[];
  importBackground: () => Promise<CustomBackgroundEntry | null>;
  deleteBackground: (id: string) => Promise<void>;
} {
  const [entries, setEntries] = useState<CustomBackgroundEntry[]>(() => listCustomBackgroundEntries());

  useEffect(() => {
    let cancelled = false;
    ensureCustomBackgroundsLoaded().then(() => {
      if (!cancelled) setEntries(listCustomBackgroundEntries());
    });
    const off = onCustomBackgroundsChange(() => {
      if (!cancelled) setEntries(listCustomBackgroundEntries());
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const importBackground = async (): Promise<CustomBackgroundEntry | null> => {
    const created = await window.videoZoom.customBackgrounds.import();
    if (!created) return null;
    const entry: CustomBackgroundEntry = {
      id: created.id,
      name: created.name,
      kind: created.kind,
      filePath: created.filePath,
      assetUrl: await window.videoZoom.project.assetUrl(created.filePath),
    };
    registerCustomBackground(entry);
    return entry;
  };

  const deleteBackground = async (id: string): Promise<void> => {
    await window.videoZoom.customBackgrounds.delete(id);
    unregisterCustomBackground(id);
  };

  return { entries, importBackground, deleteBackground };
}

export function customPresetId(id: string): string {
  return `${CUSTOM_BG_PREFIX}${id}`;
}
