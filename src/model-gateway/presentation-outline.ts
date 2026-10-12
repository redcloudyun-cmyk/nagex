// A deck outline as the model returns it, normalized and bounded before anything is built from it.
// The model decides content; NAgex decides what is acceptable: slide count, bullets per slide and text lengths are enforced here, control
// characters are removed, and an outline without at least two real content slides is rejected instead of being padded with invented text.
import { NagexError } from '../common/errors.js';

export interface PresentationOutlineSlide {
  title: string;
  bullets: string[];
}

export interface PresentationOutline {
  title: string;
  subtitle: string;
  slides: PresentationOutlineSlide[];
}

export const OUTLINE_LIMITS = {
  minContentSlides: 2,
  maxContentSlides: 14,
  maxBulletsPerSlide: 6,
  maxTitleChars: 120,
  maxSubtitleChars: 200,
  maxBulletChars: 220,
} as const;

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function normalizePresentationOutline(parsed: Record<string, unknown>, requestId: string): PresentationOutline {
  const title = clean(parsed.title, OUTLINE_LIMITS.maxTitleChars);
  if (!title) {
    throw new NagexError({ code: 'INVALID_MODEL_RESPONSE', category: 'PROVIDER', message: 'The model response is missing the deck title.', request_id: requestId });
  }
  const rawSlides = Array.isArray(parsed.slides) ? parsed.slides : [];
  const slides: PresentationOutlineSlide[] = [];
  for (const raw of rawSlides) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const slideTitle = clean(record.title, OUTLINE_LIMITS.maxTitleChars);
    const rawBullets = Array.isArray(record.bullets) ? record.bullets : [];
    const bullets = rawBullets
      .map((bullet) => clean(bullet, OUTLINE_LIMITS.maxBulletChars))
      .filter((bullet) => bullet.length > 0)
      .slice(0, OUTLINE_LIMITS.maxBulletsPerSlide);
    if (!slideTitle || bullets.length === 0) continue; // a slide without a title or without any content is dropped, never invented
    slides.push({ title: slideTitle, bullets });
    if (slides.length >= OUTLINE_LIMITS.maxContentSlides) break;
  }
  if (slides.length < OUTLINE_LIMITS.minContentSlides) {
    throw new NagexError({ code: 'EMPTY_GENERATION', category: 'PROVIDER', message: 'The model did not return enough usable slides for a presentation.', request_id: requestId });
  }
  return { title, subtitle: clean(parsed.subtitle, OUTLINE_LIMITS.maxSubtitleChars), slides };
}

/** Markdown preview of an outline (what the Main result panel and the artifact preview show). */
export function outlineToMarkdown(outline: PresentationOutline): string {
  const lines = [`# ${outline.title}`];
  if (outline.subtitle) lines.push('', `_${outline.subtitle}_`);
  outline.slides.forEach((slide, index) => {
    lines.push('', `## ${index + 1}. ${slide.title}`, ...slide.bullets.map((bullet) => `- ${bullet}`));
  });
  return lines.join('\n');
}
