import { BarcodeFormat, BinaryBitmap, DecodeHintType, GenericMultipleBarcodeReader, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "https://esm.sh/@zxing/library@0.21.3";

const $ = (id) => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), ctx = overlay.getContext("2d");
const scanCanvas = document.createElement("canvas"), scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });
const formats = [BarcodeFormat.CODE_128, BarcodeFormat.DATA_MATRIX, BarcodeFormat.QR_CODE, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.ITF, BarcodeFormat.AZTEC, BarcodeFormat.PDF_417];
const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, formats], [DecodeHintType.TRY_HARDER, true]]);
const reader = new MultiFormatReader(); reader.setHints(hints);
const multipleReader = new GenericMultipleBarcodeReader(reader);
let stream = null, facing = "environment", running = false, busy = false, raf = 0, lastScan = 0, lastCountAt = performance.now(), frames = 0;
let tracks = [], nextId = 1, results = [], previousGray = null, previousScanMs = 0;
let currentPhotos = [], persistenceTimer = 0, databasePromise = null;
const CONFIRM_FRAMES = 2, KEEP_MS = 950, SCAN_MS = 180, MAX_FRAME_SIDE = 1600;

function openLocalDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open("batchbarcode-local", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("snapshots", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("휴대폰 저장소를 열지 못했습니다."));
  });
  return databasePromise;
}
async function saveLocalSnapshot() {
  const db = await openLocalDatabase();
  const snapshot = { id: "current", savedAt: Date.now(), results: JSON.parse(JSON.stringify(results)), photos: currentPhotos };
  await new Promise((resolve, reject) => {
    const tx = db.transaction("snapshots", "readwrite");
    tx.objectStore("snapshots").put(snapshot);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("기기에 저장하지 못했습니다."));
    tx.onabort = () => reject(tx.error || new Error("기기 저장이 취소됐습니다."));
  });
  const status = $("storageStatus");
  if (status) status.textContent = "이 휴대폰에 저장됨";
}
function scheduleLocalSave() {
  clearTimeout(persistenceTimer);
  const status = $("storageStatus");
  if (status) status.textContent = "기기에 저장 중…";
  persistenceTimer = setTimeout(() => saveLocalSnapshot().catch(error => {
    console.error("Local scan save failed", error);
    const status = $("storageStatus");
    if (status) status.textContent = "기기 저장 실패 · CSV로 내보내 주세요";
  }), 450);
}
async function restoreLocalSnapshot() {
  try {
    const db = await openLocalDatabase();
    const snapshot = await new Promise((resolve, reject) => {
      const request = db.transaction("snapshots", "readonly").objectStore("snapshots").get("current");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    if (!snapshot) {
      $("storageStatus").textContent = "기기 저장 사용 가능";
      return;
    }
    results = Array.isArray(snapshot.results) ? snapshot.results : [];
    currentPhotos = Array.isArray(snapshot.photos) ? snapshot.photos : [];
    nextId = Math.max(0, ...results.map(item => Number(item.id) || 0)) + 1;
    renderResults(false);
    if (currentPhotos.length) {
      const index = currentPhotos.length - 1, savedPhoto = currentPhotos[index];
      const url = URL.createObjectURL(savedPhoto.blob);
      const image = $("photo");
      image.src = url;
      await image.decode();
      const photoHits = results.filter(item => item.photoIndex === index);
      if (photoHits.length) drawOverlay($("photoOverlay"), photoHits.map((hit, i) => ({ ...hit, id: i + 1, box: hit, stable: true, lastSeen: Date.now() })), savedPhoto.width || image.naturalWidth, savedPhoto.height || image.naturalHeight);
      $("photoStatus").textContent = `저장된 사진 ${currentPhotos.length}장 · 마지막 사진 ${savedPhoto.name}`;
    }
    $("storageStatus").textContent = "저장된 결과 복원됨 · 이 휴대폰";
  } catch (error) {
    console.error("Local scan restore failed", error);
    $("storageStatus").textContent = "휴대폰 저장소를 사용할 수 없습니다";
  }
}
function requestPersistentStorage() {
  if (!navigator.storage?.persist) return;
  navigator.storage.persist().then(granted => {
    if (!granted && $("storageStatus")) $("storageStatus").textContent = "기기에 저장 중 · 브라우저 데이터 삭제 시 기록이 지워질 수 있음";
  }).catch(() => {});
}

function setStatus(text) {
  $("liveStatus").textContent = text;
  const feedback = $("actionFeedback");
  if (feedback) feedback.textContent = text;
}
function labelFormat(format) { return format === "DATA_MATRIX" ? "Data Matrix" : format.replaceAll("_", " "); }
function makeLuminance(imageData, width, height) {
  const pixels = new Int32Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = imageData.data[i * 4] << 16 | imageData.data[i * 4 + 1] << 8 | imageData.data[i * 4 + 2];
  return new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, width, height)));
}
function decodeRegion(x, y, w, h) {
  try {
    const data = scanCtx.getImageData(x, y, w, h);
    return multipleReader.decodeMultiple(makeLuminance(data, w, h)).map(result => {
      const points = result.getResultPoints() || [];
      if (!points.length) return null;
      const xs = points.map(p => p.getX() + x), ys = points.map(p => p.getY() + y);
      let left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
      if (result.getBarcodeFormat() === BarcodeFormat.CODE_128 && bottom - top < 4) { const hh = Math.max(8, h * 0.025); top -= hh; bottom += hh; }
      return { value: result.getText(), format: labelFormat(BarcodeFormat[result.getBarcodeFormat()]), left, top, right, bottom };
    }).filter(Boolean);
  } catch { return []; }
}
function decodeCanvas() {
  const w = scanCanvas.width, h = scanCanvas.height, found = [];
  // Broad image pass followed by overlapping detail crops. Coordinates remain
  // in the same frame coordinate system for stable overlay placement.
  found.push(...decodeRegion(0, 0, w, h));
  const cols = 3, rows = 3, ox = Math.floor(w / 12), oy = Math.floor(h / 12);
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const cw = Math.ceil(w / cols), ch = Math.ceil(h / rows);
    const x = Math.max(0, col * cw - (col ? ox : 0)), y = Math.max(0, row * ch - (row ? oy : 0));
    const right = Math.min(w, (col + 1) * cw + (col < cols - 1 ? ox : 0)), bottom = Math.min(h, (row + 1) * ch + (row < rows - 1 ? oy : 0));
    found.push(...decodeRegion(x, y, right - x, bottom - y));
  }
  return mergeSamePosition(found);
}
function overlap(a, b) {
  const w = Math.max(0, Math.min(a.right,b.right)-Math.max(a.left,b.left));
  const h = Math.max(0, Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
  const inter = w*h, areaA = Math.max(1,(a.right-a.left)*(a.bottom-a.top)), areaB = Math.max(1,(b.right-b.left)*(b.bottom-b.top));
  return inter / (areaA + areaB - inter);
}
function mergeSamePosition(items) {
  const merged = [];
  for (const item of items) {
    const duplicate = merged.find(other => item.value === other.value && item.format === other.format && (overlap(item, other) > .22 || centerDistance(item, other) < Math.max(10, Math.min(item.right-item.left, other.right-other.left)*.35)));
    if (!duplicate) merged.push(item);
    else { duplicate.left = Math.min(duplicate.left,item.left); duplicate.top = Math.min(duplicate.top,item.top); duplicate.right = Math.max(duplicate.right,item.right); duplicate.bottom = Math.max(duplicate.bottom,item.bottom); }
  }
  return merged;
}
function centerDistance(a,b) { return Math.hypot((a.left+a.right-b.left-b.right)/2,(a.top+a.bottom-b.top-b.bottom)/2); }
function matchTrack(item, used) {
  let best = null, bestScore = Infinity;
  for (const track of tracks) {
    if (used.has(track.id) || track.format !== item.format || track.value !== item.value) continue;
    const distance = centerDistance(track.box,item), size = Math.max(18, Math.min(track.box.right-track.box.left,item.right-item.left)*1.5);
    if (distance < size && distance < bestScore) { best = track; bestScore = distance; }
  }
  return best;
}
function grayscaleFrame() {
  const {data}=scanCtx.getImageData(0,0,scanCanvas.width,scanCanvas.height), gray=new Uint8Array(scanCanvas.width*scanCanvas.height);
  for(let i=0;i<gray.length;i++){const p=i*4;gray[i]=(data[p]*77+data[p+1]*150+data[p+2]*29)>>8;}
  return gray;
}
function seedFlowFeatures(box,gray,w,h) {
  const l=Math.max(4,Math.floor(box.left)),t=Math.max(4,Math.floor(box.top)),r=Math.min(w-4,Math.ceil(box.right)),b=Math.min(h-4,Math.ceil(box.bottom)), candidates=[];
  if(r-l<8||b-t<8)return [];
  for(let y=t+3;y<b-3;y+=Math.max(4,Math.floor((b-t)/9)))for(let x=l+3;x<r-3;x+=Math.max(4,Math.floor((r-l)/12))){const i=y*w+x;const score=Math.abs(gray[i+1]-gray[i-1])+Math.abs(gray[i+w]-gray[i-w]);candidates.push({x,y,score});}
  candidates.sort((a,b)=>b.score-a.score);const selected=[];
  for(const p of candidates){if(p.score<22)break;if(selected.every(q=>Math.hypot(q.x-p.x,q.y-p.y)>5))selected.push({x:p.x,y:p.y});if(selected.length>=12)break;}
  return selected;
}
function patchDifference(a,b,w,h,ax,ay,bx,by) {
  let total=0;for(let oy=-2;oy<=2;oy+=2)for(let ox=-2;ox<=2;ox+=2)total+=Math.abs(a[(ay+oy)*w+ax+ox]-b[(by+oy)*w+bx+ox]);return total;
}
function advanceOpticalTracks(gray,w,h,now,scale) {
  if(!previousGray||!previousScanMs){previousGray=gray;previousScanMs=now;return;}
  const radius=Math.max(5,Math.min(22,Math.ceil((now-previousScanMs)/35))), maxMeanDifference=24;
  for(const track of tracks){
    if(!track.features?.length)continue;
    const moved=[];
    for(const p of track.features){let bx=Math.round(p.x),by=Math.round(p.y),best=Infinity;
      for(let dy=-radius;dy<=radius;dy+=2)for(let dx=-radius;dx<=radius;dx+=2){const nx=Math.round(p.x)+dx,ny=Math.round(p.y)+dy;if(nx<3||ny<3||nx>=w-3||ny>=h-3)continue;const score=patchDifference(previousGray,gray,w,h,Math.round(p.x),Math.round(p.y),nx,ny);if(score<best){best=score;bx=nx;by=ny;}}
      if(best/9<=maxMeanDifference)moved.push({x:bx,y:by,dx:bx-p.x,dy:by-p.y});
    }
    if(moved.length>=3){const median=key=>moved.map(p=>p[key]).sort((a,b)=>a-b)[Math.floor(moved.length/2)],dx=median("dx"),dy=median("dy");track.box.left+=dx/scale;track.box.right+=dx/scale;track.box.top+=dy/scale;track.box.bottom+=dy/scale;track.features=moved.map(p=>({x:p.x,y:p.y}));track.flowConfidence=moved.length;}
    else {track.features=[];track.flowConfidence=0;}
  }
  previousGray=gray;previousScanMs=now;
}
function updateTracks(detections, now, gray, grayWidth, grayHeight, scale) {
  const resultCountBefore = results.length;
  const used = new Set();
  for (const detection of detections) {
    let track = matchTrack(detection, used);
    if (!track) {
      track = { id: nextId++, value:detection.value, format:detection.format, box:{...detection}, hits:0, firstSeen:now, lastSeen:now, stable:false, features:[] };
      tracks.push(track);
    } else {
      const alpha = .58;
      for (const key of ["left","top","right","bottom"]) track.box[key] = track.box[key]*(1-alpha)+detection[key]*alpha;
      track.hits++; track.lastSeen = now;
    }
    used.add(track.id);
    if(track.features.length<3)track.features=seedFlowFeatures({left:track.box.left*scale,top:track.box.top*scale,right:track.box.right*scale,bottom:track.box.bottom*scale},gray,grayWidth,grayHeight);
    if (track.hits + 1 >= CONFIRM_FRAMES) track.stable = true;
    if (track.stable && !track.registered) {
      track.registered = true; results.push({ id:track.id,value:track.value,format:track.format,left:detection.left,top:detection.top,right:detection.right,bottom:detection.bottom,firstSeen:now });
    }
  }
  tracks = tracks.filter(track => now - track.lastSeen < KEEP_MS);
  renderResults(false);
  if (results.length !== resultCountBefore) scheduleLocalSave();
}
function canvasSize(canvas, rect) { const dpr = Math.min(devicePixelRatio || 1, 2); const w = Math.max(1,Math.round(rect.width*dpr)), h = Math.max(1,Math.round(rect.height*dpr)); if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;} return {w,h,dpr}; }
function mapCover(box, sourceW, sourceH, destW, destH) {
  const scale = Math.min(destW/sourceW, destH/sourceH); // video element uses object-fit: contain
  const ox = (destW-sourceW*scale)/2, oy = (destH-sourceH*scale)/2;
  return {left:ox+box.left*scale,top:oy+box.top*scale,right:ox+box.right*scale,bottom:oy+box.bottom*scale};
}
function drawOverlay(canvas, boxes, sourceW, sourceH) {
  const rect = canvas.getBoundingClientRect(), {w,h,dpr} = canvasSize(canvas,rect), c=canvas.getContext("2d");
  c.clearRect(0,0,w,h); c.lineWidth=2*dpr; c.font=`bold ${12*dpr}px system-ui`;
  for (const track of boxes) {
    if (!track.stable) continue;
    const b=mapCover(track.box,sourceW,sourceH,w,h), age=Date.now()-track.lastSeen;
    c.globalAlpha=Math.max(.25,1-age/KEEP_MS); c.strokeStyle="#12b76a"; c.fillStyle="#12b76a";
    c.strokeRect(b.left,b.top,b.right-b.left,b.bottom-b.top);
    const tag=`${track.id} ✓`; const tw=c.measureText(tag).width+10*dpr;
    c.fillRect(b.left,Math.max(0,b.top-20*dpr),tw,20*dpr); c.fillStyle="#fff"; c.fillText(tag,b.left+5*dpr,Math.max(14*dpr,b.top-6*dpr));
  }
  c.globalAlpha=1;
}
async function scanFrame(now) {
  if (!running) return;
  raf=requestAnimationFrame(scanFrame);
  if (!video.videoWidth || busy || now-lastScan<SCAN_MS) { drawOverlay(overlay,tracks,video.videoWidth||1,video.videoHeight||1); return; }
  lastScan=now; busy=true;
  const scale=Math.min(1,MAX_FRAME_SIDE/Math.max(video.videoWidth,video.videoHeight));
  scanCanvas.width=Math.round(video.videoWidth*scale); scanCanvas.height=Math.round(video.videoHeight*scale);
  scanCtx.drawImage(video,0,0,scanCanvas.width,scanCanvas.height);
  try {
    const gray=grayscaleFrame();
    advanceOpticalTracks(gray,scanCanvas.width,scanCanvas.height,now,scale);
    const detections=decodeCanvas().map(b=>({...b,left:b.left/scale,top:b.top/scale,right:b.right/scale,bottom:b.bottom/scale}));
    updateTracks(detections,Date.now(),gray,scanCanvas.width,scanCanvas.height,scale);
    setStatus(detections.length?`프레임 검출 ${detections.length} · 누적 ${results.length}`:"바코드 탐색 중");
  } finally { busy=false; }
  drawOverlay(overlay,tracks,video.videoWidth,video.videoHeight);
  frames++; if(now-lastCountAt>=1000){$("fps").textContent=`${frames} fps`;frames=0;lastCountAt=now;}
}
async function startCamera() {
  requestPersistentStorage();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("HTTPS 또는 localhost에서 열어야 카메라를 쓸 수 있습니다.");
    stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facing},width:{ideal:1920},height:{ideal:1080}}});
    video.srcObject=stream; await video.play(); running=true; $("cameraPlaceholder").classList.add("hidden");
    $("startCamera").disabled=true; $("stopCamera").disabled=false; $("flipCamera").disabled=false; setStatus("카메라 실행 중");
    raf=requestAnimationFrame(scanFrame);
  } catch(error) { setStatus(error.message||"카메라를 시작하지 못했습니다."); }
}
function stopCamera() { running=false; cancelAnimationFrame(raf); if(stream) stream.getTracks().forEach(t=>t.stop()); stream=null; video.srcObject=null; tracks=[]; previousGray=null; previousScanMs=0; ctx.clearRect(0,0,overlay.width,overlay.height); $("startCamera").disabled=false; $("stopCamera").disabled=true; $("flipCamera").disabled=true; $("cameraPlaceholder").classList.remove("hidden"); setStatus("종료됨"); }
function renderResults(persist = true) {
  $("count").textContent=results.length;
  const dm=results.filter(r=>r.format==="Data Matrix").length, c128=results.filter(r=>r.format==="Code 128").length;
  $("formatCounts").textContent=`DM ${dm} · Code 128 ${c128}`;
  const ordered=orderRightToLeftColumns(results);
  $("resultList").innerHTML=ordered.map((r,i)=>`<li><span class="num">${i+1}.</span><span class="fmt">${escapeHtml(r.format)}</span><span>${escapeHtml(r.value)}</span></li>`).join("");
  if (persist) scheduleLocalSave();
}
function orderRightToLeftColumns(items) {
  const groups=new Map();for(const item of items){const key=item.photoIndex??-1;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
  return [...groups.entries()].sort((a,b)=>a[0]-b[0]).flatMap(([,group])=>orderOnePhotoRightToLeft(group));
}
function orderOnePhotoRightToLeft(items) {
  const placed=items.map((item,index)=>({...item,index,cx:(item.left+item.right)/2,cy:(item.top+item.bottom)/2})).sort((a,b)=>a.cy-b.cy||b.cx-a.cx);
  const columns=[];
  for(const item of placed){const tolerance=Math.max(28,Math.min((item.right-item.left)*.8,140));let best=null,delta=Infinity;for(const col of columns){const d=Math.abs(item.cx-col.items.reduce((sum,x)=>sum+x.cx,0)/col.items.length);if(d<=tolerance&&d<delta){best=col;delta=d;}}if(best)best.items.push(item);else columns.push({items:[item]});}
  return columns.sort((a,b)=>b.items.reduce((s,x)=>s+x.cx,0)/b.items.length-a.items.reduce((s,x)=>s+x.cx,0)/a.items.length).flatMap(col=>col.items.sort((a,b)=>a.cy-b.cy||b.cx-a.cx));
}
function escapeHtml(value) { return value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
async function scanPhoto(file) {
  const img=$("photo"), url=URL.createObjectURL(file); img.src=url; await img.decode();
  const scale=Math.min(1,2400/Math.max(img.naturalWidth,img.naturalHeight)); scanCanvas.width=Math.round(img.naturalWidth*scale); scanCanvas.height=Math.round(img.naturalHeight*scale); scanCtx.drawImage(img,0,0,scanCanvas.width,scanCanvas.height);
  const start=performance.now(), hits=decodeCanvas();
  URL.revokeObjectURL(url);
  return {file,hits,width:img.naturalWidth,height:img.naturalHeight,elapsedMs:Math.round(performance.now()-start),canvasWidth:scanCanvas.width,canvasHeight:scanCanvas.height};
}
$("startCamera").addEventListener("click",startCamera); $("stopCamera").addEventListener("click",stopCamera);
$("flipCamera").addEventListener("click",async()=>{facing=facing==="environment"?"user":"environment";stopCamera();await startCamera();});
$("clearResults").addEventListener("click",()=>{if((results.length||currentPhotos.length)&&!window.confirm(`스캔 결과 ${results.length}개와 사진 ${currentPhotos.length}장을 이 기기에서 지울까요?`))return;results=[];tracks=[];currentPhotos=[];nextId=1;$("photo").removeAttribute("src");ctx.clearRect(0,0,overlay.width,overlay.height);$("photoOverlay").getContext("2d").clearRect(0,0,$("photoOverlay").width,$("photoOverlay").height);$("photoStatus").textContent="사진은 이 브라우저 안에서만 처리됩니다.";renderResults();setStatus("스캔 결과를 초기화했습니다.");});
$("copyResults").addEventListener("click",async()=>{if(!results.length){setStatus("복사할 결과가 없습니다. 먼저 바코드를 스캔해 주세요.");return;}const text=orderRightToLeftColumns(results).map((r,i)=>`${i+1}\t${r.format}\t${r.value}`).join("\n");try{await navigator.clipboard.writeText(text);setStatus(`${results.length}개 결과를 복사했습니다.`);}catch{const input=document.createElement("textarea");input.value=text;input.style.position="fixed";input.style.opacity="0";document.body.append(input);input.select();const copied=document.execCommand("copy");input.remove();setStatus(copied?`${results.length}개 결과를 복사했습니다.`:"복사 권한이 없어 복사하지 못했습니다. CSV를 이용해 주세요.");}});
$("shareResults").addEventListener("click",async()=>{if(!results.length){setStatus("공유할 결과가 없습니다. 먼저 바코드를 스캔해 주세요.");return;}const text=orderRightToLeftColumns(results).map((r,i)=>`${i+1}\t${r.format}\t${r.value}`).join("\n");try{if(navigator.share){await navigator.share({title:"바코드 스캔 결과",text});setStatus(`${results.length}개 결과를 공유했습니다.`);}else{await navigator.clipboard.writeText(text);setStatus("이 브라우저는 공유 메뉴를 지원하지 않아 결과를 복사했습니다.");}}catch(error){if(error.name!=="AbortError")setStatus("공유하지 못했습니다. 복사 또는 CSV를 이용해 주세요.");}});
$("finishResults").addEventListener("click",()=>{if(!results.length){setStatus("전달할 결과가 없습니다. 먼저 바코드를 스캔해 주세요.");return;}const payload={type:"batchbarcode:results",version:1,items:orderRightToLeftColumns(results).map((r,index)=>({sequence:index+1,value:r.value,format:r.format,trackId:r.id,photoIndex:r.photoIndex==null?null:r.photoIndex+1,sourceName:r.sourceName||null}))};if(window.parent!==window){window.parent.postMessage(payload,location.origin);setStatus(`전산 화면에 ${payload.items.length}개 결과를 전달했습니다.`);}else setStatus("단독 스캐너라 전산 화면으로 바로 전달할 수 없어요. 복사, 공유 또는 CSV를 이용해 주세요.");});
$("exportCsv").addEventListener("click",()=>{if(!results.length){setStatus("내보낼 결과가 없습니다. 먼저 바코드를 스캔해 주세요.");return;}const quote=x=>`"${String(x).replaceAll('"','""')}"`;const ordered=orderRightToLeftColumns(results);const csv="순번,사진,규격,바코드 값\r\n"+ordered.map((r,i)=>[i+1,r.photoIndex==null?"":r.photoIndex+1,r.format,r.value].map(quote).join(",")).join("\r\n");const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\ufeff",csv],{type:"text/csv;charset=utf-8"}));a.download="barcode-results.csv";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);setStatus(`${results.length}개 결과를 CSV로 내보냈습니다.`);});
$("photoInput").addEventListener("change",async e=>{const files=[...(e.target.files||[])];if(!files.length)return;requestPersistentStorage();results=[];currentPhotos=files.map(file=>({name:file.name,type:file.type,blob:file,width:0,height:0}));let allHits=0,totalMs=0,last=null;try{for(let i=0;i<files.length;i++){const photo=await scanPhoto(files[i]);last=photo;totalMs+=photo.elapsedMs;currentPhotos[i].width=photo.width;currentPhotos[i].height=photo.height;for(const hit of photo.hits){results.push({id:nextId++,value:hit.value,format:hit.format,left:hit.left,top:hit.top,right:hit.right,bottom:hit.bottom,photoIndex:i,sourceName:photo.file.name,firstSeen:Date.now()});}allHits+=photo.hits.length;}renderResults();await saveLocalSnapshot();$("photoStatus").textContent=`사진 ${files.length}장 · ${allHits}개 위치 · ${totalMs} ms · 마지막 사진 ${last.width}×${last.height}px`;if(last)drawOverlay($("photoOverlay"),last.hits.map((h,i)=>({...h,id:i+1,box:h,stable:true,lastSeen:Date.now()})),last.canvasWidth,last.canvasHeight);}catch(err){$("photoStatus").textContent=`${err.message} · 저장 공간이 부족하면 사진 수를 줄여 주세요.`;}finally{e.target.value="";}});
document.querySelectorAll(".tab").forEach(button=>button.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b===button));$("livePanel").classList.toggle("hidden",button.dataset.mode!=="live");$("photoPanel").classList.toggle("hidden",button.dataset.mode!=="photo");}));
window.addEventListener("resize",()=>{if(video.videoWidth)drawOverlay(overlay,tracks,video.videoWidth,video.videoHeight);});
window.addEventListener("pagehide",stopCamera);
restoreLocalSnapshot();
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("./sw.js").catch(error => console.warn("Service worker registration failed", error));
