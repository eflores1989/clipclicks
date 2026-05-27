import { Loader2 } from 'lucide-react';

export function SavingOverlay() {
  return (
    <div className="saving">
      <Loader2 className="spin" size={32} />
      <p>Saving recording…</p>
    </div>
  );
}
