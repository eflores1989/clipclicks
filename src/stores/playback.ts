import { create } from 'zustand';

interface PlaybackState {
  currentTimeMs: number;
  durationMs: number;
  playing: boolean;
  playbackRate: number;
  isScrubbing: boolean;
  scrubResumeOnEnd: boolean;
  /**
   * True while playback has run past the end of the video into an audio tail
   * (audio track longer than the video). The rAF owns the virtual clock; this
   * flag lets the transport controls cancel the tail and lets video listeners
   * know not to flip `playing` off when the (already-ended) video pauses.
   */
  audioTail: boolean;

  setCurrentTime: (ms: number) => void;
  setDuration: (ms: number) => void;
  setPlaying: (b: boolean) => void;
  setPlaybackRate: (r: number) => void;
  setScrubbing: (b: boolean, resumeAfter?: boolean) => void;
  setAudioTail: (b: boolean) => void;
  reset: () => void;
}

export const usePlaybackStore = create<PlaybackState>((set) => ({
  currentTimeMs: 0,
  durationMs: 0,
  playing: false,
  playbackRate: 1,
  isScrubbing: false,
  scrubResumeOnEnd: false,
  audioTail: false,

  setCurrentTime: (currentTimeMs) => set({ currentTimeMs }),
  setDuration: (durationMs) => set({ durationMs }),
  setPlaying: (playing) => set({ playing }),
  setPlaybackRate: (playbackRate) => set({ playbackRate }),
  setScrubbing: (isScrubbing, resumeAfter = false) =>
    set((s) => ({
      isScrubbing,
      scrubResumeOnEnd: isScrubbing ? resumeAfter : s.scrubResumeOnEnd,
    })),
  setAudioTail: (audioTail) => set({ audioTail }),
  reset: () =>
    set({
      currentTimeMs: 0,
      durationMs: 0,
      playing: false,
      playbackRate: 1,
      isScrubbing: false,
      scrubResumeOnEnd: false,
      audioTail: false,
    }),
}));
