import type { VideoCreationSpec } from '../specs/creation-spec.types.js';

// The text a video model receives, built from the provider-neutral spec: the person's own description first, scenes after, style last.
// Nothing about the person's account, memory or other conversations is added here.
export function videoPromptOf(spec: VideoCreationSpec): string {
  const parts: string[] = [];
  const summary = (spec.narrativeSummary || '').trim();
  if (summary) parts.push(summary);
  const scenes = (spec.storyboard || []).map((scene) => scene.visualDescription.trim()).filter(Boolean);
  // a single scene that repeats the summary is not stated twice
  for (const scene of scenes) if (scene !== summary) parts.push(scene);
  if (spec.style) parts.push(`Style: ${spec.style.toLowerCase()}`);
  if (spec.instructions) parts.push(spec.instructions.trim());
  return parts.join('. ').trim();
}

export function videoDurationOf(spec: VideoCreationSpec, fallback: number): number {
  const total = spec.totalDurationSeconds ?? (spec.storyboard || []).reduce((sum, scene) => sum + (scene.durationSeconds || 0), 0);
  return Number.isFinite(total) && total > 0 ? Math.round(total) : fallback;
}
