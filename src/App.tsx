import '@shared/types/bridge';
import { useUiStore } from '@/stores/ui';
import { useRecordingStore } from '@/stores/recording';
import { Launcher } from './features/launcher/Launcher';
import { SourcePicker } from './features/sourcePicker/SourcePicker';
import { RecordingBar } from './features/recorder/RecordingBar';
import { SavingOverlay } from './features/recorder/SavingOverlay';
import { ProcessingView } from './features/processing/ProcessingView';
import { Editor } from './features/editor/Editor';
import { UpdateBanner } from './features/update/UpdateBanner';

export function App() {
  const view = useUiStore((s) => s.view);
  const error = useRecordingStore((s) => s.errorMessage);

  return (
    <div className="app">
      <UpdateBanner />
      {error && <div className="global-error">{error}</div>}
      {view === 'launcher' && <Launcher />}
      {view === 'sourcePicker' && <SourcePicker />}
      {view === 'recording' && <RecordingBar />}
      {view === 'saving' && <SavingOverlay />}
      {view === 'processing' && <ProcessingView />}
      {view === 'editor' && <Editor />}
    </div>
  );
}
