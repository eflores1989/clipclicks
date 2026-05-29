import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';

/**
 * Auto-update UI. Updates download in the BACKGROUND automatically (checked on
 * launch + every 30 min — there's no "check" button; relaunch to force it). When
 * one is ready this banner offers "Restart" to install it. Packaged builds only.
 */
export function UpdateBanner() {
  const [downloading, setDownloading] = useState(false);
  const [percent, setPercent] = useState(0);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);

  useEffect(() => {
    const api = window.videoZoom?.update;
    if (!api) return;
    const offA = api.onAvailable(() => setDownloading(true));
    const offP = api.onProgress((p) => { setDownloading(true); setPercent(p.percent); });
    const offD = api.onDownloaded((info) => { setDownloading(false); setReadyVersion(info.version); });
    return () => { offA(); offP(); offD(); };
  }, []);

  if (!readyVersion && !downloading) return null;

  return (
    <div className="update-banner">
      {readyVersion ? (
        <>
          <Download size={15} />
          <span>Update {readyVersion} ready.</span>
          <button className="btn btn--small btn--accent" onClick={() => window.videoZoom.update.install()}>
            <RefreshCw size={13} /> Restart and update
          </button>
        </>
      ) : (
        <>
          <RefreshCw size={15} className="spin" />
          <span>Downloading update… {Math.round(percent)}%</span>
        </>
      )}
    </div>
  );
}
