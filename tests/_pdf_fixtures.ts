// Real PDF fixtures for tests (Phase 1 STEP 4, item R). These are genuine,
// structurally valid PDF files produced by pdfkit — not hand-built
// %PDF-/BT/Tj strings — so extraction tests exercise the real pdfjs-dist
// parser the same way a real uploaded document would.
import PDFDocument from 'pdfkit';

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

export async function generateTextPdf(pagesText: string[]): Promise<Buffer> {
  const doc = new PDFDocument({ autoFirstPage: false });
  const done = collect(doc);
  for (const pageText of pagesText) {
    doc.addPage();
    doc.fontSize(12).text(pageText);
  }
  doc.end();
  return done;
}

// A structurally valid PDF with a page that carries graphical content but no
// text operator at all — genuinely zero extractable text, the same shape a
// scanned/image-only page produces, without simulating OCR input.
export async function generateBlankPdf(): Promise<Buffer> {
  const doc = new PDFDocument();
  const done = collect(doc);
  doc.rect(50, 50, 200, 120).stroke();
  doc.end();
  return done;
}

// A real PDF's bytes truncated mid-stream — keeps the %PDF- magic header
// (so it is not rejected as INVALID_PDF) but destroys the trailer/xref
// table, so a real parser genuinely fails to load it.
export async function generateCorruptPdf(): Promise<Buffer> {
  const valid = await generateTextPdf(['This content will never be reachable once truncated.']);
  return valid.subarray(0, Math.floor(valid.length * 0.5));
}
