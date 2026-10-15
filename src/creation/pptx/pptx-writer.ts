// Builds a standards-based PresentationML (.pptx) package from a plain deck outline: one title slide, then title + bullet slides, 16:9, with a
// master, two layouts and a theme. No third-party dependency. The package is structurally verified by tests (zip integrity, well-formed XML,
// content types, relationship targets, slide count and text); it has not been opened in Microsoft PowerPoint by this code path.
import { buildZip, type ZipEntry } from './zip-writer.js';

export interface DeckSlide {
  title: string;
  bullets: string[];
}

export interface DeckOutline {
  title: string;
  subtitle?: string;
  locale: 'en' | 'ko';
  slides: DeckSlide[];
}

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** XML 1.0 forbids most control characters; model output can contain them. Escape the five markup characters. */
export function xmlText(value: string): string {
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rels(items: Array<{ id: string; type: string; target: string }>): string {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map((item) => `<Relationship Id="${item.id}" Type="${item.type}" Target="${item.target}"/>`)
    .join('')}</Relationships>`;
}

const lang = (locale: 'en' | 'ko') => (locale === 'ko' ? 'ko-KR' : 'en-US');

// ── text fitting ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Width of one character in units of the font size: full-width (Hangul, CJK, emoji) ~1.0, other characters ~0.55, a space ~0.3.
function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const wide = (c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xd7ff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || c >= 0x1f300;
    units += wide ? 1 : c === 32 ? 0.3 : 0.55;
  }
  return units;
}
const wrappedLines = (text: string, sizePt: number, widthPt: number): number => Math.max(1, Math.ceil((textUnits(text) * sizePt) / widthPt));

// usable text widths / heights in points (placeholder size minus insets and bullet indent) of the master and layouts below
const TITLE_WIDTH_PT = 813;
const COVER_WIDTH_PT = 706;
const BODY_WIDTH_PT = 786;
const BODY_HEIGHT_PT = 332;
const SUBTITLE_HEIGHT_PT = 122;
const PARAGRAPH_GAP_PT = 12; // space before each first-level paragraph in the master body style

// Largest title size (pt) at which the title fits `maxLines` lines; null = the master default fits.
function fitTitleSize(text: string, widthPt: number, maxLines: number, defaultPt = 40): number | null {
  for (let size = defaultPt; size >= 20; size -= 2) if (wrappedLines(text, size, widthPt) <= maxLines) return size === defaultPt ? null : size;
  return 20;
}

// Largest body size (pt) at which every paragraph fits the content area; null = the master default fits.
function fitBodySize(paragraphs: string[], widthPt: number, heightPt: number, defaultPt = 24): number | null {
  for (let size = defaultPt; size >= 14; size -= 2) {
    const lines = paragraphs.reduce((sum, text) => sum + wrappedLines(text, size, widthPt), 0);
    if (lines * size * 1.2 + paragraphs.length * PARAGRAPH_GAP_PT <= heightPt) return size === defaultPt ? null : size;
  }
  return 14;
}

const sizeAttr = (sizePt: number | null) => (sizePt === null ? '' : ` sz="${sizePt * 100}"`);

function titleShape(id: number, name: string, text: string, locale: 'en' | 'ko', phType: 'title' | 'ctrTitle'): string {
  const size = phType === 'ctrTitle' ? fitTitleSize(text, COVER_WIDTH_PT, 4) : fitTitleSize(text, TITLE_WIDTH_PT, 2);
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${phType}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="${lang(locale)}"${sizeAttr(size)} dirty="0"/><a:t>${xmlText(text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function bodyShape(id: number, name: string, paragraphs: string[], locale: 'en' | 'ko', ph: string, isSubtitle = false): string {
  const size = isSubtitle ? fitBodySize(paragraphs, COVER_WIDTH_PT, SUBTITLE_HEIGHT_PT) : fitBodySize(paragraphs, BODY_WIDTH_PT, BODY_HEIGHT_PT);
  const body = paragraphs.length
    ? paragraphs.map((text) => `<a:p><a:r><a:rPr lang="${lang(locale)}"${sizeAttr(size)} dirty="0"/><a:t>${xmlText(text)}</a:t></a:r></a:p>`).join('')
    : `<a:p><a:endParaRPr lang="${lang(locale)}" dirty="0"/></a:p>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

const GROUP_HEAD = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function slideXml(shapes: string): string {
  return `${XML_HEAD}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${GROUP_HEAD}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function placeholder(id: number, name: string, ph: string, x: number, y: number, cx: number, cy: number, extraBody = '', prompt = '', lstStyle = '<a:lstStyle/>'): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr${extraBody}><a:normAutofit/></a:bodyPr>${lstStyle}<a:p><a:r><a:rPr lang="en-US"/><a:t>${prompt}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

// Shapes drawn once on a master or layout: the accent bar, the rule under the title and the footer brand. Colours come from the theme, so a restyled theme restyles them.
const SLIDE_HEIGHT_EMU = 6858000;
const solidScheme = (val: string) => `<a:solidFill><a:schemeClr val="${val}"/></a:solidFill>`;
const solidRgb = (hex: string) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
function decoRect(id: number, name: string, x: number, y: number, cx: number, cy: number, fill: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill}<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
}
function decoText(id: number, name: string, x: number, y: number, cx: number, cy: number, text: string, sizeHundredths: number, hex: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${sizeHundredths}" dirty="0">${solidRgb(hex)}</a:rPr><a:t>${xmlText(text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
}
// slide number: a real placeholder on the master / layout / every content slide, filled by a slidenum field (PowerPoint renumbers it when slides move)
const NUM_X = 10439400;
const NUM_Y = 6356350;
const NUM_CX = 914400;
const NUM_CY = 365125;
const NUM_STYLE = `<a:lstStyle><a:lvl1pPr algn="r"><a:defRPr sz="1100"><a:solidFill><a:srgbClr val="94A3B8"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>`;
function numberPlaceholderOnLayout(id: number): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Slide Number Placeholder ${id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="12"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${NUM_X}" y="${NUM_Y}"/><a:ext cx="${NUM_CX}" cy="${NUM_CY}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/>${NUM_STYLE}<a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
}
function numberOnSlide(id: number, n: number): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Slide Number Placeholder ${id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="12"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US" dirty="0"/><a:t>${n}</a:t></a:fld><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody></p:sp>`;
}

const LEVEL = (n: number, size: number, indent: number, bullet: boolean) =>
  `<a:lvl${n}pPr marL="${indent}" indent="${bullet ? -285750 : 0}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="${n === 1 ? PARAGRAPH_GAP_PT * 100 : 600}"/></a:spcBef>${bullet ? '<a:buClr><a:schemeClr val="accent1"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>' : '<a:buNone/>'}<a:defRPr sz="${size}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;

function masterXml(): string {
  const title = placeholder(2, 'Title Placeholder 1', '<p:ph type="title"/>', 838200, 365125, 10515600, 1325563, ' vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"', 'Click to edit Master title style');
  const body = placeholder(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', 838200, 1825625, 10515600, 4351338, ' vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"', 'Click to edit Master text styles');
  return `${XML_HEAD}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP_HEAD}${decoRect(5, 'Accent Bar', 0, 0, 228600, SLIDE_HEIGHT_EMU, solidScheme('accent1'))}${title}${body}${numberPlaceholderOnLayout(6)}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4000" b="1" kern="1200"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${LEVEL(1, 2400, 342900, true)}${LEVEL(2, 2000, 685800, true)}${LEVEL(3, 1800, 1028700, true)}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>`;
}

function layoutTitleXml(): string {
  const title = placeholder(2, 'Title 1', '<p:ph type="ctrTitle"/>', 1524000, 1122363, 9144000, 2387600, ' anchor="b"', 'Click to edit Master title style', '<a:lstStyle><a:lvl1pPr><a:defRPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>');
  const sub = placeholder(3, 'Subtitle 2', '<p:ph type="subTitle" idx="1"/>', 1524000, 3602038, 9144000, 1655762, '', 'Click to edit Master subtitle style', '<a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="l"><a:buNone/><a:defRPr sz="2400"><a:solidFill><a:srgbClr val="93C5FD"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>');
  return `${XML_HEAD}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="title" preserve="1"><p:cSld name="Title Slide"><p:bg><p:bgPr>${solidRgb('0F172A')}<a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP_HEAD}${title}${sub}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function layoutContentXml(): string {
  const title = placeholder(2, 'Title 1', '<p:ph type="title"/>', 838200, 365125, 10515600, 1325563, '', 'Click to edit Master title style');
  const body = placeholder(3, 'Content Placeholder 2', '<p:ph idx="1"/>', 838200, 1825625, 10515600, 4351338, '', 'Click to edit Master text styles');
  return `${XML_HEAD}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${GROUP_HEAD}${title}${body}${decoRect(4, 'Title Rule', 838200, 1740000, 10515600, 12700, solidRgb('E2E8F0'))}${decoText(5, 'Footer Brand', 838200, NUM_Y, 3000000, NUM_CY, 'NAgex', 1100, '94A3B8')}${numberPlaceholderOnLayout(6)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function themeXml(locale: 'en' | 'ko'): string {
  const latin = locale === 'ko' ? 'Malgun Gothic' : 'Calibri';
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = (w: number) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${solid}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  return `${XML_HEAD}<a:theme xmlns:a="${NS_A}" name="NAgex"><a:themeElements><a:clrScheme name="NAgex"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F6FC"/></a:lt2><a:accent1><a:srgbClr val="0A56F7"/></a:accent1><a:accent2><a:srgbClr val="5B4BD5"/></a:accent2><a:accent3><a:srgbClr val="0B7A43"/></a:accent3><a:accent4><a:srgbClr val="F5A623"/></a:accent4><a:accent5><a:srgbClr val="B3261E"/></a:accent5><a:accent6><a:srgbClr val="64748B"/></a:accent6><a:hlink><a:srgbClr val="0A56F7"/></a:hlink><a:folHlink><a:srgbClr val="5B4BD5"/></a:folHlink></a:clrScheme><a:fontScheme name="NAgex"><a:majorFont><a:latin typeface="${latin}"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${latin}"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="NAgex"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

export function buildPptx(deck: DeckOutline, now: Date = new Date()): Buffer {
  const slides: string[] = [];
  slides.push(slideXml(titleShape(2, 'Title 1', deck.title, deck.locale, 'ctrTitle') + bodyShape(3, 'Subtitle 2', deck.subtitle ? [deck.subtitle] : [], deck.locale, '<p:ph type="subTitle" idx="1"/>', true)));
  for (const slide of deck.slides) {
    slides.push(slideXml(titleShape(2, 'Title 1', slide.title, deck.locale, 'title') + bodyShape(3, 'Content Placeholder 2', slide.bullets, deck.locale, '<p:ph idx="1"/>') + numberOnSlide(4, slides.length + 1)));
  }
  const slideCount = slides.length;
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const parts: ZipEntry[] = [];
  const add = (name: string, xml: string) => parts.push({ name, data: Buffer.from(xml, 'utf8') });

  add('[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  add('_rels/.rels', rels([
    { id: 'rId1', type: `${REL}/officeDocument`, target: 'ppt/presentation.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
    { id: 'rId3', type: `${REL}/extended-properties`, target: 'docProps/app.xml' },
  ]));
  add('docProps/core.xml', `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(deck.title)}</dc:title><dc:creator>NAgex</dc:creator><cp:lastModifiedBy>NAgex</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`);
  add('docProps/app.xml', `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><TotalTime>0</TotalTime><Application>NAgex</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>${slideCount}</Slides></Properties>`);

  const slideRels = slides.map((_, i) => ({ id: `rId${i + 2}`, type: `${REL}/slide`, target: `slides/slide${i + 1}.xml` }));
  const tail = slideCount + 2;
  add('ppt/presentation.xml', `${XML_HEAD}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  add('ppt/_rels/presentation.xml.rels', rels([
    { id: 'rId1', type: `${REL}/slideMaster`, target: 'slideMasters/slideMaster1.xml' },
    ...slideRels,
    { id: `rId${tail}`, type: `${REL}/presProps`, target: 'presProps.xml' },
    { id: `rId${tail + 1}`, type: `${REL}/viewProps`, target: 'viewProps.xml' },
    { id: `rId${tail + 2}`, type: `${REL}/theme`, target: 'theme/theme1.xml' },
    { id: `rId${tail + 3}`, type: `${REL}/tableStyles`, target: 'tableStyles.xml' },
  ]));
  add('ppt/presProps.xml', `${XML_HEAD}<p:presentationPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"/>`);
  add('ppt/viewProps.xml', `${XML_HEAD}<p:viewPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  add('ppt/tableStyles.xml', `${XML_HEAD}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  add('ppt/theme/theme1.xml', themeXml(deck.locale));
  add('ppt/slideMasters/slideMaster1.xml', masterXml());
  add('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([
    { id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout2.xml' },
    { id: 'rId3', type: `${REL}/theme`, target: '../theme/theme1.xml' },
  ]));
  add('ppt/slideLayouts/slideLayout1.xml', layoutTitleXml());
  add('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([{ id: 'rId1', type: `${REL}/slideMaster`, target: '../slideMasters/slideMaster1.xml' }]));
  add('ppt/slideLayouts/slideLayout2.xml', layoutContentXml());
  add('ppt/slideLayouts/_rels/slideLayout2.xml.rels', rels([{ id: 'rId1', type: `${REL}/slideMaster`, target: '../slideMasters/slideMaster1.xml' }]));
  slides.forEach((xml, i) => {
    add(`ppt/slides/slide${i + 1}.xml`, xml);
    add(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([{ id: 'rId1', type: `${REL}/slideLayout`, target: `../slideLayouts/slideLayout${i === 0 ? 1 : 2}.xml` }]));
  });

  return buildZip(parts, now);
}
