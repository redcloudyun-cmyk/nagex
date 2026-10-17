// Pictures in a document the model wrote: the model is OFFERED the person's own pictures under references ("image_1") and may place one on a line of its own as ![what it shows](image_1 "caption").
// NAgex then binds each placed reference to that picture's canonical address and REMOVES everything else that looks like a picture - an address the model made up, an external URL (which a viewer might fetch:
// a tracking pixel, someone else's content), a picture in the middle of a sentence. What remains in the stored document is either the person's own picture or no picture.
//
// The stored Markdown carries the canonical address (/api/v1/creations/images/<id>); the .docx download resolves it through the owner-checked image store (docx-writer + document-creation.routes).

export interface OfferedDocumentImage {
  /** what the model is told: image_1, image_2 ... */
  ref: string;
  title: string;
  /** what the stored document carries instead */
  address: string;
}

export interface BoundImages { markdown: string; placed: number; removed: number }

// the description may contain one level of brackets ("a[b]c"): the syntax is read the way a viewer would read it, so nothing picture-like survives unchecked
const ALT = '((?:[^\\[\\]\\n]|\\[[^\\]\\n]*\\])*)';
const OWN_LINE_IMAGE = new RegExp(`^[ \\t]*!\\[${ALT}\\]\\(\\s*([^)\\s]+)(?:\\s+"([^"\\n]*)")?\\s*\\)[ \\t]*$`);
const ANY_IMAGE = new RegExp(`!\\[${ALT}\\]\\(\\s*[^)\\n]*\\)`, 'g');

export function bindDocumentImages(markdown: string, offered: OfferedDocumentImage[]): BoundImages {
  const byRef = new Map(offered.map((image) => [image.ref, image] as const));
  let placed = 0; let removed = 0;
  const out: string[] = [];
  for (const line of String(markdown).replace(/\r\n?/g, '\n').split('\n')) {
    const own = OWN_LINE_IMAGE.exec(line);
    if (own) {
      const image = byRef.get(own[2]);
      if (!image) { removed += 1; continue; } // not one of the person's offered pictures: the line is gone
      placed += 1;
      const alt = own[1].replace(/[\[\]]/g, '').trim() || image.title;
      const caption = (own[3] ?? '').trim();
      out.push(`![${alt}](${image.address}${caption ? ` "${caption}"` : ''})`);
      continue;
    }
    // a picture inside a sentence cannot be placed: only its description stays
    out.push(line.replace(ANY_IMAGE, (_match, alt: string) => { removed += 1; return alt.trim(); }));
  }
  return { markdown: out.join('\n'), placed, removed };
}
