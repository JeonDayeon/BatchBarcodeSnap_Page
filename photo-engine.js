import { prepareZXingModule, readBarcodes, formatToLabel } from './vendor/zxing-wasm/reader.js';
import { detectNativePixels, combineEngineHits } from './native-decoder.js?v=18';

let ready;
export function preparePhotoEngine() {
  return ready ||= prepareZXingModule({fireImmediately:true, overrides:{
    locateFile: () => new URL('./vendor/zxing-wasm/zxing_reader.wasm', import.meta.url).href
  }}).catch(error => { ready=null; throw error; });
}
const FORMATS=['Code128','DataMatrix','QRCode','Code39','Code93','EAN13','EAN8','UPCA','UPCE','ITF','Aztec','PDF417'];
const options={formats:FORMATS,tryHarder:true,tryRotate:true,tryInvert:true,tryDownscale:true,
  maxNumberOfSymbols:0,minLineCount:3,returnErrors:false,textMode:'Plain'};

async function readFrameRegion(image) {
  const [decoded,native]=await Promise.all([readBarcodes(image,options),detectNativePixels(image)]);
  const primary=decoded.filter(r=>r.isValid&&r.text&&r.position).map(r=>{
    const corners=['topLeft','topRight','bottomRight','bottomLeft'].map(key=>r.position[key]);
    return {value:r.text,format:formatToLabel(r.format),corners,left:Math.min(...corners.map(p=>p.x)),top:Math.min(...corners.map(p=>p.y)),right:Math.max(...corners.map(p=>p.x)),bottom:Math.max(...corners.map(p=>p.y))};
  });
  return mergePhotoHits(combineEngineHits(primary,native));
}
export async function scanFramePixels(image) {
  await preparePhotoEngine();
  const full=await readFrameRegion(image);
  if(image.width<800||image.height<600)return full;
  // A centered crop can recover repeated/small codes missed in the broad frame.
  const left=Math.floor(image.width*.2),top=Math.floor(image.height*.2),width=Math.floor(image.width*.6),height=Math.floor(image.height*.6),data=new Uint8ClampedArray(width*height*4);
  for(let row=0;row<height;row++)data.set(image.data.subarray(((top+row)*image.width+left)*4,((top+row)*image.width+left+width)*4),row*width*4);
  const detail=(await readFrameRegion({width,height,data})).map(h=>({...h,left:h.left+left,top:h.top+top,right:h.right+left,bottom:h.bottom+top,corners:h.corners.map(p=>({x:p.x+left,y:p.y+top}))}));
  return combineEngineHits([],mergePhotoHits([...full,...detail]));
}

function samePosition(a,b) {
  if(a.format!==b.format || a.value!==b.value) return false;
  const aw=Math.max(1,a.right-a.left), ah=Math.max(1,a.bottom-a.top);
  const bw=Math.max(1,b.right-b.left), bh=Math.max(1,b.bottom-b.top);
  const ix=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));
  const iy=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
  const intersection=ix*iy;
  if(intersection/Math.min(aw*ah,bw*bh)>.55) return true;
  const dx=Math.abs((a.left+a.right-b.left-b.right)/2),dy=Math.abs((a.top+a.bottom-b.top-b.bottom)/2);
  // The short axis controls row separation. A wide Code 128 must never merge nearby rows.
  if(Math.max(aw,bw)>Math.max(ah,bh)*2) return ix/Math.min(aw,bw)>.8 && (dy<=Math.max(3,Math.min(ah,bh)*.35) || (Math.min(ah,bh)<Math.max(ah,bh)*.4 && Math.max(a.top,b.top)-Math.min(a.bottom,b.bottom)<=3));
  if(Math.max(ah,bh)>Math.max(aw,bw)*2) return iy/Math.min(ah,bh)>.8 && (dx<=Math.max(3,Math.min(aw,bw)*.35) || (Math.min(aw,bw)<Math.max(aw,bw)*.4 && Math.max(a.left,b.left)-Math.min(a.right,b.right)<=3));
  return dx<Math.min(aw,bw)*.25 && dy<Math.min(ah,bh)*.25;
}
export function mergePhotoHits(items) {
  const merged=[];
  for(const hit of items) {
    const prior=merged.find(other=>samePosition(other,hit));
    if(prior) {
      const observations=(prior.observations||1)+1;
      if((hit.right-hit.left)*(hit.bottom-hit.top)>(prior.right-prior.left)*(prior.bottom-prior.top)) Object.assign(prior,hit);
      prior.observations=observations;
    }
    else merged.push({...hit,observations:1});
  }
  return merged;
}

// Each region is sampled directly from the original upright image. Only the broad
// overview is resized; detail crops retain source pixels and original coordinates.
export async function scanPhotoSource(source, makeCanvas, onProgress=()=>{}) {
  await preparePhotoEngine();
  const width=source.width||source.naturalWidth,height=source.height||source.naturalHeight;
  if(!width||!height) throw new Error('사진을 열지 못했습니다. JPG 또는 PNG 사진으로 다시 선택해 주세요.');
  const canvas=makeCanvas(), context=canvas.getContext('2d',{willReadFrequently:true});
  const raw=[],passes=[],start=performance.now();
  async function pass(x,y,w,h,label,extra={},maxSide=3200) {
    const scale=Math.min(1,maxSide/Math.max(w,h));
    canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
    context.drawImage(source,x,y,w,h,0,0,canvas.width,canvas.height);
    const t=performance.now();
    const pixels=context.getImageData(0,0,canvas.width,canvas.height);
    const [found,native]=await Promise.all([readBarcodes(pixels,{...options,...extra}),detectNativePixels(pixels)]);
    const primary=[];
    for(const r of found) {
      if(!r.isValid||!r.text||!r.position) continue;
      const corners=['topLeft','topRight','bottomRight','bottomLeft'].map(key=>r.position[key]).filter(Boolean).map(p=>({x:x+p.x*w/canvas.width,y:y+p.y*h/canvas.height}));
      if(corners.length!==4) continue;
      primary.push({value:r.text,format:formatToLabel(r.format),left:Math.min(...corners.map(p=>p.x)),top:Math.min(...corners.map(p=>p.y)),right:Math.max(...corners.map(p=>p.x)),bottom:Math.max(...corners.map(p=>p.y)),corners,rotation:r.rotation,lineCount:r.lineCount,pass:label});
    }
    const mappedNative=native.map(r=>({...r,left:x+r.left*w/canvas.width,top:y+r.top*h/canvas.height,right:x+r.right*w/canvas.width,bottom:y+r.bottom*h/canvas.height,corners:r.corners.map(p=>({x:x+p.x*w/canvas.width,y:y+p.y*h/canvas.height})),pass:label}));
    raw.push(...combineEngineHits(primary,mappedNative));
    passes.push({label,count:found.length,elapsedMs:Math.round(performance.now()-t)});
    onProgress({stage:label,count:mergePhotoHits(raw).length});
    // Main-thread fallback also yields so progress, buttons and scrolling can paint.
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  try {
    await pass(0,0,width,height,'전체 사진');
    const cols=Math.min(5,Math.max(2,Math.ceil(width/1400))),rows=Math.min(5,Math.max(2,Math.ceil(height/1400)));
    if(Math.max(width,height)>1400) for(let row=0;row<rows;row++) for(let col=0;col<cols;col++) {
      const x=Math.max(0,Math.floor((col-.18)*width/cols)),y=Math.max(0,Math.floor((row-.18)*height/rows));
      const r=Math.min(width,Math.ceil((col+1.18)*width/cols)),b=Math.min(height,Math.ceil((row+1.18)*height/rows));
      await pass(x,y,r-x,b-y,`상세 영역 ${row*cols+col+1}/${rows*cols}`,{},2200);
    }
    // Full-width overlapping bands preserve the quiet zones of long Code 128s.
    const bands=Math.max(6,Math.min(12,Math.ceil(height/280))),bh=Math.ceil(height/bands*1.8);
    for(let i=0;i<bands;i++) {
      const y=Math.min(height-bh,Math.max(0,Math.round(i*height/bands-bh*.2)));
      await pass(0,y,width,Math.min(bh,height-y),`가로 바코드 보완 ${i+1}/${bands}`,{formats:['Code128'],tryDownscale:false},4200);
    }
    const hits=mergePhotoHits(raw);
    const vertical=hits.some(h=>h.format==='Code 128'&&h.bottom-h.top>(h.right-h.left)*2);
    if(vertical || !hits.some(h=>h.format==='Code 128')) {
      const n=Math.max(6,Math.min(10,Math.ceil(width/350))),cw=Math.ceil(width/n*1.8);
      for(let i=0;i<n;i++) { const x=Math.min(width-cw,Math.max(0,Math.round(i*width/n-cw*.2)));await pass(x,0,Math.min(cw,width-x),height,`세로 바코드 보완 ${i+1}/${n}`,{formats:['Code128'],tryDownscale:false},4200); }
    }
    return {hits:combineEngineHits([],mergePhotoHits(raw)),rawHits:raw,width,height,canvasWidth:width,canvasHeight:height,elapsedMs:Math.round(performance.now()-start),engine:'zxing-wasm 3.1.6 + supported native detector',rawCount:raw.length,passes};
  } finally {canvas.width=1;canvas.height=1;}
}
