const rd=(f)=>JSON.parse(require('fs').readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const rows=[];
for(const t of process.argv.slice(2)){const j=rd(t+'.json');let ph=0,tb=0,over=0,beyond=0,minFont=99,consistent=0,textShapes=0,titlePh=0,fill=[],numbers=0,decor=0;const fonts=new Set();
for(const s of j.slides){for(const h of s.shapes){ if(/Slide Number/i.test(h.name)) numbers++; if(h.fontSizePt!==undefined){textShapes++;if(h.placeholder)ph++;else tb++;if(/^Title/.test(h.name)&&h.placeholder)titlePh++;minFont=Math.min(minFont,h.fontSizePt);fonts.add(h.fontName);if(h.fontName===h.fontNameFarEast)consistent++;if(h.overflowPt>0)over++;if(h.beyondSlidePt>0)beyond++;if(/Content|Text/.test(h.name)&&h.height)fill.push(h.boundHeight/h.height);} else if(!h.placeholder) decor++; }}
fill.sort((a,b)=>a-b);rows.push({impl:t,slides:j.slides.length,placeholders:ph,textboxes:tb,titlePlaceholders:titlePh,overflowing:over,beyondSlide:beyond,minFontPt:minFont,latinEqualsEA:consistent+'/'+textShapes,slideNumbers:numbers,decorShapesOnSlides:decor,medianBodyFill:Math.round(fill[Math.floor(fill.length/2)]*100)+'%'});}
console.table(rows);
