import { useProjectStore } from '@/stores/project';
import { usePlaybackStore } from '@/stores/playback';
import { getVideoForClip } from './videoSession';

/**
 * `video.playbackRate` combines two independent factors:
 *   1. The clip's intrinsic speed (`clip.speedSegments[0].speed`, default 1) —
 *      a property of the timeline that the final export will honor.
 *   2. The user's preview-only override from the Transport rate buttons.
 *
 * Effective = clip.speed × preview.playbackRate. We apply this to EVERY clip's
 * video element (not just the active one) so that whenever a clip becomes
 * active during playback, its rate is already correct. Setting playbackRate on
 * a paused video has no perceptible cost and saves us from having to reapply
 * the rate every time the active clip changes.
 */
export function applyEffectivePlaybackRate(): void {
  const project = useProjectStore.getState().project;
  if (!project) return;
  const previewRate = usePlaybackStore.getState().playbackRate;
  for (const clip of project.clips) {
    const v = getVideoForClip(clip.id);
    if (!v) continue;
    const clipSpeed = clip.speedSegments[0]?.speed ?? 1;
    v.playbackRate = Math.max(0.0625, Math.min(16, clipSpeed * previewRate));
  }
}
