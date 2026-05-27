import { useEffect, useState } from 'react';
import { Video, FolderOpen, FileVideo, Loader2, X, Search } from 'lucide-react';
import { useUiStore } from '@/stores/ui';
import { useProjectStore } from '@/stores/project';
import type { ProjectRef } from '@shared/types/project';

function formatRelativeTime(epoch: number): string {
  const diff = Date.now() - epoch;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(epoch).toLocaleDateString();
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function Launcher() {
  const setView = useUiStore((s) => s.setView);
  const recents = useProjectStore((s) => s.recents);
  const setRecents = useProjectStore((s) => s.setRecents);
  const setLoaded = useProjectStore((s) => s.setLoaded);
  const [loadingRecents, setLoadingRecents] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Open project" browser: lists ALL projects in the default folder by their
  // real name (project.json), not the original folder name.
  const [browserOpen, setBrowserOpen] = useState(false);
  const [allProjects, setAllProjects] = useState<ProjectRef[] | null>(null);
  const [filter, setFilter] = useState('');
  const [version, setVersion] = useState('');

  useEffect(() => {
    window.videoZoom.appVersion().then(setVersion).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.videoZoom.project.listRecent()
      .then((list) => {
        if (cancelled) return;
        setRecents(list);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        console.warn('Could not list recents:', err);
      })
      .finally(() => {
        if (!cancelled) setLoadingRecents(false);
      });
    return () => { cancelled = true; };
  }, [setRecents]);

  const openByPath = async (path: string): Promise<void> => {
    setOpening(true);
    setError(null);
    try {
      const result = await window.videoZoom.project.load(path);
      const assetUrl = await window.videoZoom.project.assetUrl(result.videoAssetPath);
      setLoaded({
        project: result.project,
        projectPath: result.projectPath,
        videoAssetUrl: assetUrl,
        thumbnailUrls: [],
      });
      setView('editor');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOpening(false);
    }
  };

  const handleOpenDialog = async (): Promise<void> => {
    setOpening(true);
    setError(null);
    try {
      const picked = await window.videoZoom.project.openDialog();
      if (!picked) {
        setOpening(false);
        return;
      }
      await openByPath(picked);
    } catch (err) {
      setError((err as Error).message);
      setOpening(false);
    }
  };

  const openBrowser = (): void => {
    setBrowserOpen(true);
    setFilter('');
    setAllProjects(null);
    window.videoZoom.project.listAll()
      .then((list) => setAllProjects(list))
      .catch((err: Error) => { setError(err.message); setAllProjects([]); });
  };

  const filteredProjects = (allProjects ?? []).filter((p) =>
    p.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="launcher">
      <header className="launcher__header">
        <Video size={22} />
        <h1>Clipclicks Studio</h1>
      </header>

      <main className="launcher__main">
        <h2 className="launcher__title">Start recording</h2>
        <p className="launcher__sub">Capture your screen with smooth automatic zoom on every click.</p>

        {error && <div className="launcher__error">{error}</div>}

        <div className="launcher__cards">
          <button className="card card--primary" onClick={() => setView('sourcePicker')} disabled={opening}>
            <Video size={32} />
            <span className="card__title">New recording</span>
            <span className="card__hint">Pick a screen or window</span>
          </button>

          <button className="card card--disabled" disabled>
            <FileVideo size={32} />
            <span className="card__title">Import video</span>
            <span className="card__hint">Coming after MVP</span>
          </button>

          <button className="card" onClick={openBrowser} disabled={opening}>
            <FolderOpen size={32} />
            <span className="card__title">Open project</span>
            <span className="card__hint">Elegí de tus proyectos</span>
          </button>
        </div>

        <section className="recents">
          <h3 className="recents__title">Recent projects</h3>
          {loadingRecents && (
            <div className="recents__empty"><Loader2 size={16} className="spin" /> Loading…</div>
          )}
          {!loadingRecents && recents.length === 0 && (
            <div className="recents__empty">No recent projects yet.</div>
          )}
          {!loadingRecents && recents.length > 0 && (
            <ul className="recents__list">
              {recents.slice(0, 5).map((r: ProjectRef) => (
                <li key={r.path}>
                  <button
                    className="recent-row"
                    onClick={() => openByPath(r.path)}
                    disabled={opening}
                    title={r.path}
                  >
                    <span className="recent-row__name">{r.name}</span>
                    <span className="recent-row__meta">
                      {formatDuration(r.durationMs)} · {formatRelativeTime(r.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      {version && <footer className="launcher__footer">Clipclicks Studio v{version}</footer>}

      {browserOpen && (
        <div className="proj-browser__backdrop" onClick={() => setBrowserOpen(false)}>
          <div className="proj-browser" onClick={(e) => e.stopPropagation()}>
            <header className="proj-browser__header">
              <h3>Abrir proyecto</h3>
              <button className="icon-btn" onClick={() => setBrowserOpen(false)} aria-label="Cerrar">
                <X size={18} />
              </button>
            </header>
            <div className="proj-browser__search">
              <Search size={14} />
              <input
                type="text"
                placeholder="Buscar por nombre…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                autoFocus
                spellCheck={false}
              />
            </div>
            <div className="proj-browser__body">
              {allProjects === null && (
                <div className="recents__empty"><Loader2 size={16} className="spin" /> Cargando…</div>
              )}
              {allProjects !== null && filteredProjects.length === 0 && (
                <div className="recents__empty">{filter ? 'Sin resultados.' : 'No hay proyectos todavía.'}</div>
              )}
              {filteredProjects.length > 0 && (
                <ul className="recents__list">
                  {filteredProjects.map((r) => (
                    <li key={r.path}>
                      <button
                        className="recent-row"
                        onClick={() => { setBrowserOpen(false); openByPath(r.path); }}
                        disabled={opening}
                        title={r.path}
                      >
                        <span className="recent-row__name">{r.name}</span>
                        <span className="recent-row__meta">
                          {formatDuration(r.durationMs)} · {formatRelativeTime(r.updatedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <footer className="proj-browser__footer">
              <button className="btn btn--ghost" onClick={() => { setBrowserOpen(false); handleOpenDialog(); }}>
                <FolderOpen size={14} /> Buscar otra carpeta…
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
