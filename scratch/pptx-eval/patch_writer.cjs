// One-shot patch for src/creation/pptx/pptx-writer.ts: template/layout improvements inside the EXISTING writer (no new dependency).
// Run from the worktree root: node scratch/pptx-eval/patch_writer.cjs
const fs = require('fs');
const f = 'src/creation/pptx/pptx-writer.ts';
let s = fs.readFileSync(f, 'utf8');
const crlf = s.includes('\r\n');
if (crlf) s = s.replace(/\r\n/g, '\n');
const rep = (a, b) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`expected exactly 1 match, found ${n}: ${a.slice(0, 80)}`); s = s.replace(a, () => b); };

// 1. paragraph rhythm: the fit estimate and the master use the same per-paragraph gap
rep('if (lines * size * 1.2 + paragraphs.length * 8 <= heightPt)', 'if (lines * size * 1.2 + paragraphs.length * PARAGRAPH_GAP_PT <= heightPt)');
rep('const SUBTITLE_HEIGHT_PT = 122;', 'const SUBTITLE_HEIGHT_PT = 122;\nconst PARAGRAPH_GAP_PT = 12; // space before each first-level paragraph in the master body style');

// 2. static decoration shapes (drawn on the master / layouts, not placeholders)
rep("const LEVEL = (n: number, size: number, indent: number, bullet: boolean) =>",
`// Shapes drawn once on a master or layout: the accent bar, the rule under the title and the footer brand. Colours come from the theme, so a restyled theme restyles them.
const SLIDE_HEIGHT_EMU = 6858000;
const solidScheme = (val: string) => \`<a:solidFill><a:schemeClr val="\${val}"/></a:solidFill>\`;
const solidRgb = (hex: string) => \`<a:solidFill><a:srgbClr val="\${hex}"/></a:solidFill>\`;
function decoRect(id: number, name: string, x: number, y: number, cx: number, cy: number, fill: string): string {
  return \`<p:sp><p:nvSpPr><p:cNvPr id="\${id}" name="\${name}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="\${x}" y="\${y}"/><a:ext cx="\${cx}" cy="\${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>\${fill}<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>\`;
}
function decoText(id: number, name: string, x: number, y: number, cx: number, cy: number, text: string, sizeHundredths: number, hex: string): string {
  return \`<p:sp><p:nvSpPr><p:cNvPr id="\${id}" name="\${name}"/><p:cNvSpPr txBox="1"/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="\${x}" y="\${y}"/><a:ext cx="\${cx}" cy="\${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="\${sizeHundredths}" dirty="0">\${solidRgb(hex)}</a:rPr><a:t>\${xmlText(text)}</a:t></a:r></a:p></p:txBody></p:sp>\`;
}
// slide number: a real placeholder on the master / layout / every content slide, filled by a slidenum field (PowerPoint renumbers it when slides move)
const NUM_X = 10439400;
const NUM_Y = 6356350;
const NUM_CX = 914400;
const NUM_CY = 365125;
const NUM_STYLE = \`<a:lstStyle><a:lvl1pPr algn="r"><a:defRPr sz="1100"><a:solidFill><a:srgbClr val="94A3B8"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>\`;
function numberPlaceholderOnLayout(id: number): string {
  return \`<p:sp><p:nvSpPr><p:cNvPr id="\${id}" name="Slide Number Placeholder \${id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="12"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="\${NUM_X}" y="\${NUM_Y}"/><a:ext cx="\${NUM_CX}" cy="\${NUM_CY}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"/>\${NUM_STYLE}<a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>\`;
}
function numberOnSlide(id: number, n: number): string {
  return \`<p:sp><p:nvSpPr><p:cNvPr id="\${id}" name="Slide Number Placeholder \${id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="12"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US" dirty="0"/><a:t>\${n}</a:t></a:fld><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody></p:sp>\`;
}

const LEVEL = (n: number, size: number, indent: number, bullet: boolean) =>`);

// 3. body style: accent-coloured bullets and a calmer paragraph gap
rep("<a:spcBef><a:spcPts val=\"${n === 1 ? 800 : 400}\"/></a:spcBef>${bullet ? '<a:buFont typeface=\"Arial\"/><a:buChar char=\"&#8226;\"/>' : '<a:buNone/>'}",
    "<a:spcBef><a:spcPts val=\"${n === 1 ? PARAGRAPH_GAP_PT * 100 : 600}\"/></a:spcBef>${bullet ? '<a:buClr><a:schemeClr val=\"accent1\"/></a:buClr><a:buFont typeface=\"Arial\"/><a:buChar char=\"&#8226;\"/>' : '<a:buNone/>'}");

// 4. master: accent bar behind the placeholders and the slide-number style
rep("<p:spTree>${GROUP_HEAD}${title}${body}</p:spTree></p:cSld><p:clrMap bg1=\"lt1\"",
    "<p:spTree>${GROUP_HEAD}${decoRect(5, 'Accent Bar', 0, 0, 228600, SLIDE_HEIGHT_EMU, solidScheme('accent1'))}${title}${body}${numberPlaceholderOnLayout(6)}</p:spTree></p:cSld><p:clrMap bg1=\"lt1\"");

// 5. title layout: dark cover with light type
rep("const title = placeholder(2, 'Title 1', '<p:ph type=\"ctrTitle\"/>', 1524000, 1122363, 9144000, 2387600, ' anchor=\"b\"', 'Click to edit Master title style');",
    "const title = placeholder(2, 'Title 1', '<p:ph type=\"ctrTitle\"/>', 1524000, 1122363, 9144000, 2387600, ' anchor=\"b\"', 'Click to edit Master title style', '<a:lstStyle><a:lvl1pPr><a:defRPr><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>');");
rep("<a:buNone/><a:defRPr sz=\"2400\"/></a:lvl1pPr></a:lstStyle>');",
    "<a:buNone/><a:defRPr sz=\"2400\"><a:solidFill><a:srgbClr val=\"93C5FD\"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>');");
rep("type=\"title\" preserve=\"1\"><p:cSld name=\"Title Slide\"><p:spTree>",
    "type=\"title\" preserve=\"1\"><p:cSld name=\"Title Slide\"><p:bg><p:bgPr>${solidRgb('0F172A')}<a:effectLst/></p:bgPr></p:bg><p:spTree>");

// 6. content layout: rule under the title, footer brand, slide number
rep("type=\"obj\" preserve=\"1\"><p:cSld name=\"Title and Content\"><p:spTree>${GROUP_HEAD}${title}${body}</p:spTree>",
    "type=\"obj\" preserve=\"1\"><p:cSld name=\"Title and Content\"><p:spTree>${GROUP_HEAD}${title}${body}${decoRect(4, 'Title Rule', 838200, 1740000, 10515600, 12700, solidRgb('E2E8F0'))}${decoText(5, 'Footer Brand', 838200, NUM_Y, 3000000, NUM_CY, 'NAgex', 1100, '94A3B8')}${numberPlaceholderOnLayout(6)}</p:spTree>");

// 7. theme fonts follow the language of the deck: Latin text uses the same family as the Korean text
rep("function themeXml(): string {", "function themeXml(locale: 'en' | 'ko'): string {\n  const latin = locale === 'ko' ? 'Malgun Gothic' : 'Calibri';");
rep("<a:majorFont><a:latin typeface=\"Calibri\"/>", "<a:majorFont><a:latin typeface=\"${latin}\"/>");
rep("<a:minorFont><a:latin typeface=\"Calibri\"/>", "<a:minorFont><a:latin typeface=\"${latin}\"/>");
rep("add('ppt/theme/theme1.xml', themeXml());", "add('ppt/theme/theme1.xml', themeXml(deck.locale));");

// 8. content slides carry the slide number
rep("bodyShape(3, 'Content Placeholder 2', slide.bullets, deck.locale, '<p:ph idx=\"1\"/>')));",
    "bodyShape(3, 'Content Placeholder 2', slide.bullets, deck.locale, '<p:ph idx=\"1\"/>') + numberOnSlide(4, slides.length + 1)));");

if (crlf) s = s.replace(/\n/g, '\r\n');
fs.writeFileSync(f, s);
console.log('patched');
