// Readable text and page facts from an HTML document, for the research fetcher. Pure and dependency-free. The text is what a person would read (no scripts, styles, navigation, forms); the page facts are
// the title and the publication date the page itself declares (meta tags, JSON-LD, <time>). Nothing here executes or fetches anything.

export interface ReadablePage {
  title: string;
  text: string;
  publishedAt?: string;
  /** the date the page says it was last modified; for a page that is edited over time (an encyclopedia article) this, not publishedAt, says how current it is */
  modifiedAt?: string;
  textTruncated: boolean;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', middot: '·', copy: '(c)', reg: '(r)', trade: '(tm)', laquo: '"', raquo: '"', times: 'x',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ' ';
      try { return String.fromCodePoint(code); } catch { return ' '; }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

function metaContent(html: string, key: 'property' | 'name' | 'itemprop', value: string): string | undefined {
  const tag = new RegExp(`<meta\\b[^>]*\\b${key}\\s*=\\s*["']${value.replace(/[.]/g, '\\.')}["'][^>]*>`, 'i').exec(html);
  if (!tag) return undefined;
  const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag[0]);
  const found = content ? (content[1] ?? content[2]) : undefined;
  return found ? decodeEntities(found).trim() || undefined : undefined;
}

function asIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const time = Date.parse(trimmed);
  if (!Number.isFinite(time)) return undefined;
  // a date written without a time stays a date: the page did not say a moment, so none is invented
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : new Date(time).toISOString();
}

function declaredPublishedAt(html: string): string | undefined {
  const candidates: Array<string | undefined> = [
    metaContent(html, 'property', 'article:published_time'),
    metaContent(html, 'property', 'og:article:published_time'),
    metaContent(html, 'name', 'citation_publication_date'),
    metaContent(html, 'name', 'citation_date'),
    metaContent(html, 'name', 'dc.date.issued'),
    metaContent(html, 'name', 'dc.date'),
    metaContent(html, 'name', 'publishdate'),
    metaContent(html, 'name', 'pubdate'),
    metaContent(html, 'name', 'date'),
    metaContent(html, 'itemprop', 'datePublished'),
  ];
  for (const candidate of candidates) {
    const iso = asIsoDate(candidate);
    if (iso) return iso;
  }
  for (const block of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const found = /"datePublished"\s*:\s*"([^"]+)"/.exec(block[1]);
    const iso = asIsoDate(found?.[1]);
    if (iso) return iso;
  }
  const time = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(html);
  return asIsoDate(time?.[1]);
}

function declaredModifiedAt(html: string): string | undefined {
  const candidates: Array<string | undefined> = [
    metaContent(html, 'property', 'article:modified_time'),
    metaContent(html, 'property', 'og:updated_time'),
    metaContent(html, 'name', 'last-modified'),
    metaContent(html, 'name', 'dcterms.modified'),
    metaContent(html, 'itemprop', 'dateModified'),
  ];
  for (const candidate of candidates) {
    const iso = asIsoDate(candidate);
    if (iso) return iso;
  }
  for (const block of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const found = /"dateModified"\s*:\s*"([^"]+)"/.exec(block[1]);
    const iso = asIsoDate(found?.[1]);
    if (iso) return iso;
  }
  return undefined;
}

const DROPPED_BLOCKS = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'nav', 'footer', 'aside', 'form', 'select', 'button', 'dialog'];

export function extractReadablePage(html: string, maxTextChars: number): ReadablePage {
  const source = String(html);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  const ogTitle = metaContent(source, 'property', 'og:title');
  const title = decodeEntities((ogTitle || (titleMatch ? titleMatch[1] : '')).replace(/\s+/g, ' ')).trim();
  const publishedAt = declaredPublishedAt(source);
  const modifiedAt = declaredModifiedAt(source);

  let body = source.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<head\b[\s\S]*?<\/head>/i, ' ');
  // prefer the main content when the page marks it; otherwise the whole body
  const main = /<(article|main)\b[^>]*>([\s\S]*)<\/\1>/i.exec(body);
  if (main && main[2].replace(/<[^>]+>/g, '').trim().length > 400) body = main[2];
  // footnote markers ("[12]" links) are not part of what the page says
  body = body.replace(/<sup\b[^>]*\breference\b[^>]*>[\s\S]*?<\/sup\s*>/gi, ' ');
  for (const tag of DROPPED_BLOCKS) body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
  body = body
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dd|dt|figcaption)\s*>/gi, '\n')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const lines = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0\u200b]+/g, ' ').trim())
    .filter((line) => line.length > 0);
  const text = lines.join('\n');
  if (text.length <= maxTextChars) return { title, text, publishedAt, modifiedAt, textTruncated: false };
  // cut at a line boundary so no sentence is split in the middle
  const cut = text.lastIndexOf('\n', maxTextChars);
  return { title, text: text.slice(0, cut > maxTextChars * 0.5 ? cut : maxTextChars), publishedAt, modifiedAt, textTruncated: true };
}
