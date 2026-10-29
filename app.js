import { installWebParity } from "./web-parity.js?v=16";
function redrawPhotoOverlay(){
  const d=resultIsDraft?workspace.draft:workspace.documents.find(x=>x.id===resultDocumentId),p=d?.photos[resultPhotoIndex];
  if(!p||!document.getElementById('photoResultScreen').classList.contains('active'))return;
  const boxes=orderOnePhotoRightToLeft(p.hits||[]).map((h,i)=>({...h,id:i+1,box:h,stable:true,lastSeen:Date.now()}));
  drawOverlay(document.getElementById('photoResultOverlay'),boxes,p.scanWidth||p.width||document.getElementById('photoResultImage').naturalWidth,p.scanHeight||p.height||document.getElementById('photoResultImage').naturalHeight);
}
let BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource;
let reader = null, zxingReady = false;
const zxingReadyPromise = import("https://esm.sh/@zxing/library@0.21.3").then(module => {
  ({BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource} = module);
  const formats = [BarcodeFormat.CODE_128, BarcodeFormat.DATA_MATRIX, BarcodeFormat.QR_CODE, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.ITF, BarcodeFormat.AZTEC, BarcodeFormat.PDF_417];
  const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, formats], [DecodeHintType.TRY_HARDER, true]]);
  reader = new MultiFormatReader(); reader.setHints(hints); zxingReady = true;
  const status = document.getElementById("liveStatus"); if (status && status.textContent === "카메라를 시작해 바코드를 찾으세요.") status.textContent = "ZXing 인식 엔진 준비됨 · 카메라를 시작하세요.";
}).catch(error => {
  console.error("ZXing-JS load failed", error);
  const status = document.getElementById("liveStatus"); if (status) status.textContent = "인식 엔진 연결 실패 · 인터넷 연결을 확인하고 새로고침하세요.";
});

const $ = (id) => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), ctx = overlay.getContext("2d");
const scanCanvas = document.createElement("canvas"), scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });
let stream = null, facing = "environment", running = false, busy = false, raf = 0, lastScan = 0, lastCountAt = performance.now(), frames = 0;
let tracks = [], nextId = 1, results = [], previousGray = null, previousScanMs = 0;
let currentPhotos = [], persistenceTimer = 0, databasePromise = null;
let autoCaptureStreak = 0, lastAutoCaptureAt = 0;
let autoCaptureSignature='',lastAutoCaptureSignature='',emptyCaptureFrames=0;
let cameraRequestId = 0, cameraStartPromise = null, photoProcessing = false, captureInProgress = false;
let cameraDocumentId = null, saveTargetId = null, photoPreviewUrl = null, detailPreviewUrls = [];
const CONFIRM_FRAMES = 2, KEEP_MS = 950, SCAN_MS = 180, MAX_FRAME_SIDE = 1600;

function openLocalDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open("batchbarcode-local", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("snapshots", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("휴대폰 저장소를 열지 못했습니다."));
    request.onblocked = () => reject(new Error("다른 탭에서 저장소를 사용 중입니다. 이 웹앱의 다른 탭을 닫고 새로고침하세요."));
  });
  databasePromise.catch(()=>{databasePromise=null;});
  return databasePromise;
}
async function saveLocalSnapshot() {
  await saveWorkspace();
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

function setStatus(text) { $("liveStatus").textContent = text; }
function labelFormat(format) { return format === "DATA_MATRIX" ? "Data Matrix" : format.replaceAll("_", " "); }
function makeLuminance(imageData, width, height) {
  const pixels = new Int32Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = imageData.data[i * 4] << 16 | imageData.data[i * 4 + 1] << 8 | imageData.data[i * 4 + 2];
  return new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(pixels, width, height)));
}
function decodeRegion(x, y, w, h) {
  if (!zxingReady || !reader) return [];
  try {
    const data = scanCtx.getImageData(x, y, w, h);
    const result = reader.decode(makeLuminance(data, w, h));
    const points = result.getResultPoints() || [];
      if (!points.length) return [];
      const xs = points.map(p => p.getX() + x), ys = points.map(p => p.getY() + y);
      let left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
      if (result.getBarcodeFormat() === BarcodeFormat.CODE_128 && bottom - top < 4) { const hh = Math.max(8, h * 0.025); top -= hh; bottom += hh; }
    return [{ value: result.getText(), format: labelFormat(BarcodeFormat[result.getBarcodeFormat()]), left, top, right, bottom }];
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
function mapCover(box, sourceW, sourceH, destW, destH, fit="contain") {
  const scale = fit === "cover" ? Math.max(destW/sourceW, destH/sourceH) : Math.min(destW/sourceW, destH/sourceH);
  const ox = (destW-sourceW*scale)/2, oy = (destH-sourceH*scale)/2;
  return {left:ox+box.left*scale,top:oy+box.top*scale,right:ox+box.right*scale,bottom:oy+box.bottom*scale};
}
function drawOverlay(canvas, boxes, sourceW, sourceH, fit="contain") {
  const rect = canvas.getBoundingClientRect(), {w,h,dpr} = canvasSize(canvas,rect), c=canvas.getContext("2d");
  c.clearRect(0,0,w,h); c.lineWidth=2*dpr; c.font=`bold ${12*dpr}px system-ui`;
  for (const track of boxes) {
    if (!track.stable) continue;
    const b=mapCover(track.box,sourceW,sourceH,w,h,fit), age=Date.now()-track.lastSeen;
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
  if (!zxingReady || photoProcessing) return;
  if (typeof workspace !== "undefined" && !workspace.settings.auto) { drawOverlay(overlay,tracks,video.videoWidth||1,video.videoHeight||1,"cover"); return; }
  if (!video.videoWidth || busy || now-lastScan<SCAN_MS) { drawOverlay(overlay,tracks,video.videoWidth||1,video.videoHeight||1,"cover"); return; }
  lastScan=now; busy=true;
  const scale=Math.min(1,MAX_FRAME_SIDE/Math.max(video.videoWidth,video.videoHeight));
  scanCanvas.width=Math.round(video.videoWidth*scale); scanCanvas.height=Math.round(video.videoHeight*scale);
  scanCtx.drawImage(video,0,0,scanCanvas.width,scanCanvas.height);
  try {
    const gray=grayscaleFrame();
    advanceOpticalTracks(gray,scanCanvas.width,scanCanvas.height,now,scale);
    const detections=decodeCanvas().map(b=>({...b,left:b.left/scale,top:b.top/scale,right:b.right/scale,bottom:b.bottom/scale}));
    updateTracks(detections,Date.now(),gray,scanCanvas.width,scanCanvas.height,scale);
    const signature=[...new Set(detections.map(h=>h.format+'\u0000'+h.value))].sort().join('\u0001');
    autoCaptureStreak=workspace.settings.autoCapture&&signature?signature===autoCaptureSignature?autoCaptureStreak+1:1:0;autoCaptureSignature=signature;
    if(!signature){if(++emptyCaptureFrames>=4)lastAutoCaptureSignature='';}else emptyCaptureFrames=0;
    if(autoCaptureStreak >= 4 && signature!==lastAutoCaptureSignature && Date.now()-lastAutoCaptureAt > 3000 && !photoProcessing && !captureInProgress){
      autoCaptureStreak=0;lastAutoCaptureAt=Date.now();lastAutoCaptureSignature=signature;queueMicrotask(()=>{if(running&&workspace.settings.autoCapture)captureFrame();});
    }
    setStatus(detections.length?`프레임 검출 ${detections.length} · 누적 ${results.length}`:"바코드 탐색 중");
  } finally { busy=false; }
  drawOverlay(overlay,tracks,video.videoWidth,video.videoHeight,"cover");
  frames++; if(now-lastCountAt>=1000){$("fps").textContent=`${frames} fps`;frames=0;lastCountAt=now;}
}
async function startCamera() {
  await workspaceReadyPromise;
  if (running || cameraStartPromise) return cameraStartPromise;
  const requestId = ++cameraRequestId;
  cameraStartPromise = (async () => {
  requestPersistentStorage();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("HTTPS 또는 localhost에서 열어야 카메라를 쓸 수 있습니다.");
    const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facing},width:{ideal:1920},height:{ideal:1080}}});
    if (requestId !== cameraRequestId || !$("scannerScreen").classList.contains("active")) { acquired.getTracks().forEach(t=>t.stop()); return; }
    stream=acquired; video.srcObject=stream; await video.play();
    if (requestId !== cameraRequestId) { acquired.getTracks().forEach(t=>t.stop()); return; }
    running=true; $("cameraPlaceholder").classList.add("hidden");
    $("startCamera").disabled=true; setStatus("카메라 실행 중");
    autoCaptureStreak=0;
    if(workspace.settings.torch) await applyTorch();
    raf=requestAnimationFrame(scanFrame);
    } catch(error) { if(requestId!==cameraRequestId)return;stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;setStatus(error.name==="NotAllowedError"?"카메라 권한이 허용되지 않았습니다. 브라우저 설정에서 허용한 뒤 다시 시작하세요.":/device not found|requested device/i.test(error.message||"")||error.name==="NotFoundError"?"이 기기에서 카메라를 찾지 못했어요. 갤러리에서 사진을 불러와 스캔할 수 있습니다.":error.message||"카메라를 시작하지 못했습니다."); }
  })();
  try { await cameraStartPromise; } finally { if(requestId===cameraRequestId)cameraStartPromise=null; }
}
function stopCamera() { ++cameraRequestId;cameraStartPromise=null;running=false; cancelAnimationFrame(raf); if(stream) stream.getTracks().forEach(t=>t.stop()); stream=null; video.srcObject=null; tracks=[]; previousGray=null; previousScanMs=0;torchOn=false;$("torchButton").classList.remove("active");$("torchButton").innerHTML="▯<small>손전등 OFF</small>"; ctx.clearRect(0,0,overlay.width,overlay.height); $("startCamera").disabled=false; $("cameraPlaceholder").classList.remove("hidden"); setStatus("카메라가 종료됐습니다."); }
function renderResults() { if (typeof workspace !== "undefined") updateDraftSummary(); }
function orderRightToLeftColumns(items) {
  const groups=new Map();for(const item of items){const key=item.photoIndex??-1;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
  return [...groups.entries()].sort((a,b)=>a[0]-b[0]).flatMap(([,group])=>orderOnePhotoRightToLeft(group));
}
function orderOnePhotoRightToLeft(items) {
  const placed=items.map((item,index)=>({...item,index,cx:(item.left+item.right)/2,cy:(item.top+item.bottom)/2})).sort((a,b)=>a.cy-b.cy||b.cx-a.cx);
  const columns=[];
  for(const item of placed){const tolerance=Math.max(28,Math.min((item.right-item.left)*.8,140));let best=null,delta=Infinity;for(const col of columns){const d=Math.abs(item.cx-col.items.reduce((sum,x)=>sum+x.cx,0)/col.items.length);if(d<=tolerance&&d<delta){best=col;delta=d;}}if(best)best.items.push(item);else columns.push({items:[item]});}
  const direction=workspace?.settings?.barcodeOrder==="ltr"?1:-1;
  return columns.sort((a,b)=>direction*(a.items.reduce((s,x)=>s+x.cx,0)/a.items.length-b.items.reduce((s,x)=>s+x.cx,0)/b.items.length)).flatMap(col=>col.items.sort((a,b)=>a.cy-b.cy||direction*(a.cx-b.cx)));
}
function escapeHtml(value) { return value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
async function scanPhoto(file) {
  await zxingReadyPromise;
  if(!zxingReady)throw new Error("인식 엔진을 불러오지 못했습니다. 인터넷 연결 후 다시 인식해 주세요.");
  const img=new Image(), url=URL.createObjectURL(file);
  try{img.src=url;await img.decode();if(!img.naturalWidth||!img.naturalHeight)throw new Error("지원하지 않는 이미지입니다.");
    const scale=Math.min(1,2400/Math.max(img.naturalWidth,img.naturalHeight)); scanCanvas.width=Math.round(img.naturalWidth*scale); scanCanvas.height=Math.round(img.naturalHeight*scale); scanCtx.drawImage(img,0,0,scanCanvas.width,scanCanvas.height);
    const start=performance.now(), hits=decodeCanvas();
    return {file,hits,width:img.naturalWidth,height:img.naturalHeight,elapsedMs:Math.round(performance.now()-start),canvasWidth:scanCanvas.width,canvasHeight:scanCanvas.height};
  }finally{URL.revokeObjectURL(url);}
}
let workspace={documents:[],trash:[],draft:null,settings:{rotate:false,auto:true,sound:true,vibration:true,format:"xlsx",filenameFormat:"date_task",barcodeOrder:"rtl",ascii:false,trashDays:30}};
let workspaceReady=false,workspaceReadyResolve;const workspaceReadyPromise=new Promise(resolve=>{workspaceReadyResolve=resolve;});
let activeDocumentId=null, resultDocumentId=null, resultPhotoIndex=0, resultIsDraft=false, sortNewest=true, selectMode=false, selectedDocumentIds=new Set(), torchOn=false, toastTimer, barcodePage=0;
let settingsReturnToScanner=false;
const makeId=()=>`${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const formatBarcodeValue=value=>workspace?.settings?.ascii?String(value??"").replace(/[\x00-\x1f\x7f]/g,c=>`[ASCII ${c.charCodeAt(0)}]`):String(value??"");
function defaultDocumentName(){const now=new Date(),date=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;switch(workspace.settings.filenameFormat){case"task_date":return`작업1_${date}`;case"custom":return"작업1";default:return`${date}_작업1`;}}
function showScreen(id){document.querySelectorAll(".screen").forEach(s=>s.classList.toggle("active",s.id===id));window.dispatchEvent(new CustomEvent("batchbarcode:screen",{detail:id}));}
function currentCameraDocument(){return cameraDocumentId?workspace.documents.find(d=>d.id===cameraDocumentId):workspace.draft;}
function createDraft(){return{id:makeId(),name:defaultDocumentName(),createdAt:Date.now(),format:workspace.settings.format||"xlsx",photos:[]};}
function syncControlSettings(){
  for(const [id,key]of[["autoScanSetting","auto"],["rotateSetting","rotate"],["soundSetting","sound"],["vibrationSetting","vibration"]])$(id).checked=!!workspace.settings[key];
  for(const [id,label,key,symbol]of[["autoButton","자동 인식","auto","◎"],["soundButton","소리","sound","◖))"],["vibrationButton","진동","vibration","◈"]]){const enabled=!!workspace.settings[key];$(id).classList.toggle("active",enabled);$(id).innerHTML=`${symbol}<small>${label} ${enabled?"ON":"OFF"}</small>`;}
  $("frameCount").textContent=`자동 인식 ${workspace.settings.auto?"ON":"OFF"}`;$("rotateButton").classList.toggle("active",!!workspace.settings.rotate);$("rotateButton").setAttribute("aria-pressed",String(!!workspace.settings.rotate));
}
function toast(message){const el=$("toast");el.textContent=message;el.classList.remove("hidden");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.add("hidden"),2400);}
async function getWorkspace(){const db=await openLocalDatabase();return new Promise((resolve,reject)=>{const req=db.transaction("snapshots","readonly").objectStore("snapshots").get("workspace");req.onsuccess=()=>resolve(req.result?.workspace||null);req.onerror=()=>reject(req.error);});}
async function saveWorkspace(){if(!workspaceReady)await workspaceReadyPromise;const db=await openLocalDatabase();await new Promise((resolve,reject)=>{const tx=db.transaction("snapshots","readwrite");tx.objectStore("snapshots").put({id:"workspace",savedAt:Date.now(),workspace});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error("기기 저장이 중단되었습니다."));});$("storageStatus")&&($("storageStatus").textContent="이 기기에 저장됨");}
function uniqueBarcodes(doc){const map=new Map();for(const [photoIndex,photo] of (doc.photos||[]).entries())for(const hit of photo.hits||[]){const key=`${hit.format}\u0000${hit.value}`;if(!map.has(key))map.set(key,{...hit,photoIndex});}return [...map.values()];}
function updateDraftSummary(){const d=currentCameraDocument(),photos=d?.photos||[],count=photos.reduce((n,p)=>n+(p.hits?.length||0),0),unique=d?uniqueBarcodes(d).length:0;$("captureCount").innerHTML=`사진 ${photos.length}장<br />한 문서에 계속 추가`;$("scanSummary").textContent=`이번 문서 · 사진 ${photos.length}장 · 검출 ${count}개 · 고유 바코드 ${unique}개`;$("showDraftDetail").innerHTML=`현재 인식 바코드 목록<br /><small>문서 고유 ${unique}개</small>`;const last=photos.at(-1);$("showDraftPhotoResult").textContent=last?`마지막 촬영 · 인식 ${last.hits?.length||0}개${last.scanError?" · 재시도 필요":""} · 결과 보기`:"촬영 후 인식 결과가 여기에 표시됩니다.";}
function normalizeDraftResults(){results=[];let id=1;currentCameraDocument()?.photos.forEach((photo,photoIndex)=>(photo.hits||[]).forEach(hit=>results.push({...hit,id:id++,photoIndex,sourceName:photo.name,firstSeen:Date.now()})));nextId=id;}
async function resumeCameraView(){await workspaceReadyPromise;normalizeDraftResults();renderResults();syncControlSettings();showScreen("scannerScreen");if(!running)startCamera();}
async function openDraft(){await workspaceReadyPromise;cameraDocumentId=null;if(!workspace.draft)workspace.draft=createDraft();return resumeCameraView();}
async function openDocumentCamera(doc){await workspaceReadyPromise;if(!doc||!workspace.documents.some(d=>d.id===doc.id))return;cameraDocumentId=doc.id;return resumeCameraView();}
function renderHistory(){const query=$("historySearch").value.trim().toLowerCase(),docs=workspace.documents.filter(d=>!d.deletedAt&&(!query||d.name.toLowerCase().includes(query))).sort((a,b)=>(sortNewest?-1:1)*(a.savedAt-b.savedAt));$("historyCount").textContent="저장된 문서 "+docs.length+"개";$("emptyHistory").classList.toggle("hidden",docs.length>0);$("toggleSelect").textContent=selectMode?"선택 완료":"선택";$("historyItems").innerHTML=docs.map(d=>'<div class="history-card"><input type="checkbox" data-select="'+esc(d.id)+'" '+(selectedDocumentIds.has(d.id)?"checked":"")+'><button data-open="'+esc(d.id)+'"><b>'+esc(d.name)+'.'+(d.format||'xlsx')+'</b><small>'+new Date(d.savedAt).toLocaleString("ko-KR")+' · 사진 '+d.photos.length+'장 · 고유 바코드 '+uniqueBarcodes(d).length+'개</small></button></div>').join("");$("historySelection").classList.toggle("hidden",!selectMode);$("selectedCount").textContent=selectedDocumentIds.size+"개 선택";}
function showCurrentPhotoResult(){const d=currentCameraDocument();if(!d?.photos.length){toast("먼저 사진을 촬영하거나 불러오세요.");return;}resultIsDraft=d===workspace.draft;resultDocumentId=resultIsDraft?null:d.id;resultPhotoIndex=d.photos.length-1;renderPhotoResult();}
function renderCurrentBarcodeList(){const d=currentCameraDocument();if(!d?.photos.length){toast("먼저 사진을 촬영하거나 불러오세요.");return;}stopCamera();const unique=orderRightToLeftColumns(uniqueBarcodes(d)),pageSize=3,pageCount=Math.max(1,Math.ceil(unique.length/pageSize));barcodePage=Math.max(0,Math.min(barcodePage,pageCount-1));$("currentUniqueCount").textContent=unique.length+"개";$("currentPhotoCount").textContent=`원본 사진 ${d.photos.length}장 유지`;$("barcodeRange").textContent=unique.length?`${barcodePage*pageSize+1}–${Math.min((barcodePage+1)*pageSize,unique.length)} / ${unique.length}개`:`0–0 / 0개`;$("barcodePageLabel").textContent=`${barcodePage+1} / ${pageCount} 페이지`;$("barcodePrevious").disabled=barcodePage===0;$("barcodeNext").disabled=barcodePage>=pageCount-1;const page=unique.slice(barcodePage*pageSize,(barcodePage+1)*pageSize);$("currentBarcodeItems").innerHTML=page.map((h,i)=>`<li><button data-hit-photo="${h.photoIndex}" data-hit-value="${esc(h.value)}" data-hit-format="${esc(h.format)}"><span class="hit-meta">${barcodePage*pageSize+i+1}　${esc(h.format)} <b>✓ 완료</b></span><span>${esc(formatBarcodeValue(h.value))}</span></button></li>`).join("")||"<li class=empty-barcode>아직 인식 완료한 바코드가 없습니다.</li>";$("barcodeListNotice").textContent="ⓘ　완료 상태는 계속 유지됩니다. 같은 데이터는 문서에 중복 추가하지 않습니다.";showScreen("barcodeListScreen");}
function showDocumentSaveScreen(target){const d=target?.photos?target:currentCameraDocument();if(photoProcessing||captureInProgress){toast("사진 처리가 끝난 뒤 저장해 주세요.");return;}if(!d?.photos.length){toast("먼저 사진을 촬영해 주세요.");return;}saveTargetId=d.id;stopCamera();$("documentFilename").value=d.name||`스캔 ${new Date().toLocaleDateString("ko-KR")}`;document.querySelectorAll(".format-choice").forEach(b=>b.classList.toggle("selected",b.dataset.format===(workspace.settings.format||"xlsx")));$("filenameExtension").textContent=(workspace.settings.format||"xlsx")==="csv"?".csv":".xlsx";showScreen("documentSaveScreen");}
function renderTrash(){const docs=workspace.trash||[];$("emptyTrash").classList.toggle("hidden",docs.length>0);$("trashItems").innerHTML=docs.map(d=>`<div class="history-card"><button data-restore="${esc(d.id)}"><b>${esc(d.name)}</b><small>${d.photos.length}장 · 복구하려면 누르세요</small></button><button data-delete="${esc(d.id)}">완전 삭제</button></div>`).join("");}
function renderDetail(id){stopCamera();detailPreviewUrls.forEach(url=>URL.revokeObjectURL(url));detailPreviewUrls=[];activeDocumentId=id;const d=workspace.documents.find(x=>x.id===id);if(!d)return;const ext=(d.format||"xlsx")==="csv"?".csv":".xlsx",format=ext===".csv"?"CSV":"XLSX (Excel)";$("detailTitle").textContent=d.name+ext;$("detailDate").textContent="저장 "+new Date(d.savedAt).toLocaleString("ko-KR");$("detailSummary").textContent="사진 "+d.photos.length+"장     고유 바코드 "+uniqueBarcodes(d).length+"개";$("detailPhotoCount").textContent=d.photos.length+"장";$("detailBarcodeCount").textContent=uniqueBarcodes(d).length+"개";$("detailFileInfo").textContent=format+" · 파일 경로 /BatchBarcodeSnap/"+d.name+ext;$("detailPhotos").innerHTML=d.photos.map((p,i)=>'<button class="photo-tile" data-photo="'+i+'"><img src="'+(()=>{const url=URL.createObjectURL(p.blob);detailPreviewUrls.push(url);return url;})()+'" alt=""><span>사진 '+(i+1)+'<br>감지 '+p.hits.length+'개 · 읽음 '+p.hits.length+'개</span></button>').join("");$("detailBarcodes").innerHTML=orderRightToLeftColumns(uniqueBarcodes(d)).map((h,i)=>'<li><span class="num">'+(i+1)+'.</span><span class="fmt">'+esc(h.format)+'</span><span>'+esc(formatBarcodeValue(h.value))+'</span></li>').join("");showScreen("detailScreen");}
function renderPhotoResult(){const d=resultIsDraft?workspace.draft:workspace.documents.find(x=>x.id===resultDocumentId);if(!d)return;const p=d.photos[resultPhotoIndex];if(!p)return;stopCamera();const hits=orderOnePhotoRightToLeft(p.hits||[]);$("photoPosition").textContent=`사진 ${resultPhotoIndex+1} / ${d.photos.length}`;if(photoPreviewUrl)URL.revokeObjectURL(photoPreviewUrl);const url=photoPreviewUrl=URL.createObjectURL(p.blob);$("photoOriginalImage").src=url;$("photoResultImage").src=url;$("photoResultImage").onload=()=>{const boxes=hits.map((h,i)=>({...h,id:i+1,box:h,stable:true,lastSeen:Date.now()}));drawOverlay($("photoResultOverlay"),boxes,p.scanWidth||p.width||$("photoResultImage").naturalWidth,p.scanHeight||p.height||$("photoResultImage").naturalHeight);};$("photoResultSummary").textContent=`읽음 ${hits.length}개\n문서 전체: 사진 ${d.photos.length}장 · 고유 바코드 ${uniqueBarcodes(d).length}개`;$("photoResultList").innerHTML=hits.map((h,i)=>`<li><span class="num">${i+1}.</span><span class="fmt">${esc(h.format)} · ✓ 읽음</span><span>${esc(formatBarcodeValue(h.value))}</span></li>`).join("")||"<li>코드를 찾지 못했어요. 라벨을 더 가까이서 촬영해 주세요.</li>";requestAnimationFrame(()=>{const boxes=hits.map((h,i)=>({...h,id:i+1,box:h,stable:true,lastSeen:Date.now()}));drawOverlay($("photoResultOverlay"),boxes,p.scanWidth||p.width,p.scanHeight||p.height);});$("photoPrevious").disabled=resultPhotoIndex<=0;$("photoNext").disabled=resultPhotoIndex>=d.photos.length-1;showScreen("photoResultScreen");}
async function exportDocument(doc){const safeName=doc.name.replace(/[\\/:*?"<>|]/g,"_");if((doc.format||"xlsx")==="csv"){const q=v=>`"${String(v??"").replaceAll('"','""')}"`;const rows=[["순번","사진","형식","바코드 값","왼쪽","위","오른쪽","아래"],...doc.photos.flatMap((p,pi)=>p.hits.map((h,i)=>[i+1,p.name,h.format,h.value,Math.round(h.left),Math.round(h.top),Math.round(h.right),Math.round(h.bottom)]))];const csv="\ufeff"+rows.map(row=>row.map(q).join(",")).join("\r\n");const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));a.download=`${safeName}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500);return;}try{const XLSX=await import("https://esm.sh/xlsx@0.18.5");const wb=XLSX.utils.book_new();const all=doc.photos.flatMap((p,pi)=>p.hits.map((h,i)=>({photo:p.name,photoNo:pi+1,sequence:i+1,format:h.format,value:h.value,left:Math.round(h.left),top:Math.round(h.top),right:Math.round(h.right),bottom:Math.round(h.bottom)})));const unique=uniqueBarcodes(doc);XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(all.map((r,i)=>({"순번":i+1,"사진":r.photo,"형식":r.format,"바코드 값":r.value,"왼쪽":r.left,"위":r.top,"오른쪽":r.right,"아래":r.bottom}))),"사진별 기록");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(unique.map((h,i)=>({"순번":i+1,"형식":h.format,"바코드 값":h.value}))),"고유 바코드");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(all.map((r,i)=>({"순번":i+1,"사진 번호":r.photoNo,"사진":r.photo,"사진 내 순번":r.sequence,"형식":r.format,"바코드 값":r.value}))),"바코드별 기록");XLSX.writeFile(wb,`${safeName}.xlsx`);}
catch(error){console.warn("XLSX export failed; using CSV",error);const q=v=>`"${String(v??"").replaceAll('"','""')}"`;const rows=[["순번","사진","형식","바코드 값"],...doc.photos.flatMap((p,pi)=>p.hits.map((h,i)=>[i+1,p.name,h.format,h.value]))];const csv="\ufeff"+rows.map(row=>row.map(q).join(",")).join("\r\n");const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));a.download=`${safeName}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500);}}
async function addPhotoFiles(files,{targetDoc=null,returnToDetail=false}={}){
  await workspaceReadyPromise;
  if(photoProcessing){toast("사진 인식이 끝난 뒤 추가해 주세요.");return;}
  if(!files?.length)return;
  if(!targetDoc){targetDoc=currentCameraDocument();if(!targetDoc){workspace.draft=createDraft();targetDoc=workspace.draft;}}
  const target=targetDoc;photoProcessing=true;$("capturePhoto").disabled=true;requestPersistentStorage();showScreen("scannerScreen");let total=0,added=0,failed=0;
  try{
    for(const file of files){
      if(file.type&&!file.type.startsWith("image/")){failed++;continue;}
      const item={id:makeId(),name:file.name||`사진 ${target.photos.length+1}`,type:file.type||"image/jpeg",blob:file,width:0,height:0,scanWidth:0,scanHeight:0,hits:[],scanState:"scanning"};
      target.photos.push(item);added++;
      setStatus(`사진 ${added} / ${files.length}장 인식 중…`);
      try{const photo=await scanPhoto(file),sx=photo.width/photo.canvasWidth,sy=photo.height/photo.canvasHeight;Object.assign(item,{width:photo.width,height:photo.height,scanWidth:photo.width,scanHeight:photo.height,hits:photo.hits.map(h=>({...h,left:h.left*sx,top:h.top*sy,right:h.right*sx,bottom:h.bottom*sy})),elapsedMs:photo.elapsedMs,scanState:"done"});total+=item.hits.length;}
      catch(error){item.scanState="error";item.scanError=error.message||"사진 인식 실패";failed++;}
      normalizeDraftResults();renderResults();await saveWorkspace();
    }
    if(target!==workspace.draft)target.savedAt=Date.now();
    await saveWorkspace();
    if(returnToDetail)renderDetail(target.id);
    toast(`${added}장 추가 · ${total}개 위치 인식${failed?` · ${failed}장 재확인 필요`:""}`);
    setStatus(failed?"일부 사진은 재인식이 필요합니다. 결과에서 확인하세요.":"사진 인식 완료");
  }catch(error){console.error("Photo import failed",error);toast(`기기 저장 실패: ${error.message}`);}
  finally{photoProcessing=false;$("capturePhoto").disabled=false;normalizeDraftResults();renderResults();}
}
async function importIntoDocument(files,doc){return addPhotoFiles(files,{targetDoc:doc,returnToDetail:true});}
async function captureFrame(){
  if(captureInProgress||photoProcessing){toast("사진 처리가 끝난 뒤 촬영해 주세요.");return;}
  if(!running||!video.videoWidth){toast("먼저 카메라를 시작하세요.");return;}
  const targetDoc=currentCameraDocument();captureInProgress=true;$("capturePhoto").disabled=true;
  try{const c=document.createElement("canvas"),rotate=workspace.settings.rotate;c.width=rotate?video.videoHeight:video.videoWidth;c.height=rotate?video.videoWidth:video.videoHeight;const x=c.getContext("2d");if(rotate){x.translate(c.width,0);x.rotate(Math.PI/2);}x.drawImage(video,0,0,video.videoWidth,video.videoHeight);const blob=await new Promise(resolve=>c.toBlob(resolve,"image/jpeg",.94));if(!blob){toast("사진을 만들지 못했습니다.");return;}if(workspace.settings.sound){try{const Audio=window.AudioContext||window.webkitAudioContext;if(Audio){const ac=new Audio(),osc=ac.createOscillator(),gain=ac.createGain();osc.frequency.value=880;gain.gain.value=.035;osc.connect(gain).connect(ac.destination);osc.onended=()=>ac.close();osc.start();osc.stop(ac.currentTime+.07);}}catch{}}if(workspace.settings.vibration)navigator.vibrate?.(35);await addPhotoFiles([new File([blob],`촬영_${new Date().toISOString().replaceAll(":","-")}.jpg`,{type:"image/jpeg"})],{targetDoc});}
  catch(error){toast(`촬영 실패: ${error.message}`);}finally{captureInProgress=false;$("capturePhoto").disabled=false;}
}
async function applyTorch(){const track=stream?.getVideoTracks()[0];if(!track){toast("카메라를 먼저 시작하세요.");return;}try{if(!track.getCapabilities?.().torch)throw new Error('unsupported');await track.applyConstraints({advanced:[{torch:!torchOn}]});torchOn=!torchOn;workspace.settings.torch=torchOn;if($("torchSetting"))$("torchSetting").checked=torchOn;await saveWorkspace();$("torchButton").classList.toggle("active",torchOn);$("torchButton").innerHTML=`▯<small>손전등 ${torchOn?"ON":"OFF"}</small>`;}catch{toast("이 브라우저/카메라는 손전등 제어를 지원하지 않습니다.");}}
async function getLegacySnapshot(){const db=await openLocalDatabase();return new Promise((resolve,reject)=>{const req=db.transaction("snapshots","readonly").objectStore("snapshots").get("current");req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);});}
function migrateLegacySnapshot(legacy){if(!legacy?.photos?.length)return null;const photos=legacy.photos.map((p,index)=>({id:makeId(),name:p.name||("사진 "+(index+1)),type:p.type||"image/jpeg",blob:p.blob,width:p.width||0,height:p.height||0,scanWidth:p.width||0,scanHeight:p.height||0,hits:[]}));for(const hit of legacy.results||[]){const i=Number.isInteger(hit.photoIndex)?hit.photoIndex:Math.max(0,photos.length-1);if(!photos[i])continue;photos[i].hits.push({value:hit.value,format:hit.format,left:hit.left||0,top:hit.top||0,right:hit.right||0,bottom:hit.bottom||0});}return{id:makeId(),name:"이전 스캔 기록",createdAt:legacy.savedAt||Date.now(),savedAt:legacy.savedAt||Date.now(),photos};}
async function initWorkspace(){let migrated=false;try{const stored=await getWorkspace();if(stored)workspace={...workspace,...stored,settings:{...workspace.settings,...stored.settings}};if(!stored){const legacy=await getLegacySnapshot();const restored=migrateLegacySnapshot(legacy);if(restored){workspace.documents=[restored];migrated=true;}}}catch(e){console.error(e);toast("로컬 저장소를 열지 못했습니다.");}finally{workspaceReady=true;workspaceReadyResolve?.();}if(migrated)await saveWorkspace();$("autoScanSetting").checked=workspace.settings.auto;$("rotateSetting").checked=workspace.settings.rotate;$("soundSetting").checked=workspace.settings.sound;$("vibrationSetting").checked=workspace.settings.vibration;$("barcodeOrderSetting").value=workspace.settings.barcodeOrder||"rtl";$("asciiSetting").checked=!!workspace.settings.ascii;$("filenameFormatSetting").value=workspace.settings.filenameFormat||"date_task";$("exportFormatSetting").value=workspace.settings.format||"xlsx";$("trashDaysSetting").value=String(workspace.settings.trashDays||30);$("autoButton").classList.toggle("active",workspace.settings.auto);$("rotateButton").classList.toggle("active",workspace.settings.rotate);$("homeFormat").textContent=(workspace.settings.format||"xlsx")==="csv"?"CSV":"XLSX (Excel)";document.querySelectorAll(".format-choice").forEach(b=>b.classList.toggle("selected",b.dataset.format===(workspace.settings.format||"xlsx")));[...workspace.documents,...workspace.trash,...(workspace.draft?[workspace.draft]:[])].forEach(d=>{d.format=d.format||"xlsx";d.photos=d.photos||[];d.photos.forEach(p=>{p.hits=p.hits||[];if(p.scanState==="scanning"){p.scanState="interrupted";p.scanError="이전 인식 작업이 중단되었습니다. 다시 인식해 주세요.";}});});syncControlSettings();renderHistory();updateDraftSummary();}
$("exitScanner").addEventListener("click",()=>{stopCamera();showScreen("homeScreen");});$("startCamera").addEventListener("click",startCamera);$("capturePhoto").addEventListener("click",captureFrame);$("torchButton").addEventListener("click",applyTorch);
$("autoButton").addEventListener("click",async()=>{workspace.settings.auto=!workspace.settings.auto;$("autoButton").classList.toggle("active",workspace.settings.auto);$("autoButton").innerHTML=`◎<small>자동 인식 ${workspace.settings.auto?"ON":"OFF"}</small>`;await saveWorkspace();});$("rotateButton").addEventListener("click",async()=>{workspace.settings.rotate=!workspace.settings.rotate;syncControlSettings();await saveWorkspace();toast(`새 촬영 사진 ${workspace.settings.rotate?"90° 회전 보정 ON":"회전 보정 OFF"}`);});
for(const [id,key] of [["autoScanSetting","auto"],["rotateSetting","rotate"],["soundSetting","sound"],["vibrationSetting","vibration"]])$(id).addEventListener("change",async e=>{workspace.settings[key]=e.target.checked;syncControlSettings();await saveWorkspace();});
$("soundButton").addEventListener("click",async()=>{$("soundSetting").checked=!$("soundSetting").checked;$("soundSetting").dispatchEvent(new Event("change"));$("soundButton").innerHTML=`◖))<small>소리 ${workspace.settings.sound?"ON":"OFF"}</small>`;});$("vibrationButton").addEventListener("click",async()=>{$("vibrationSetting").checked=!$("vibrationSetting").checked;$("vibrationSetting").dispatchEvent(new Event("change"));$("vibrationButton").innerHTML=`◈<small>진동 ${workspace.settings.vibration?"ON":"OFF"}</small>`;});
$("photoInput").addEventListener("change",async e=>{const files=[...(e.target.files||[])];e.target.value="";if(!files.length)return;if(activeDocumentId&&$("detailScreen").classList.contains("active")){const d=workspace.documents.find(x=>x.id===activeDocumentId);if(d){await importIntoDocument(files,d);return;}}await addPhotoFiles(files);});
$("saveDocument").addEventListener("click",showDocumentSaveScreen);
$("historyBack").addEventListener("click",()=>showScreen("homeScreen"));$("historySearch").addEventListener("input",renderHistory);$("historySort").addEventListener("click",()=>{sortNewest=!sortNewest;$("historySort").textContent=sortNewest?"최근 저장순 ▾":"오래된순 ▾";renderHistory();});$("toggleSelect").addEventListener("click",()=>{selectMode=!selectMode;if(!selectMode)selectedDocumentIds.clear();renderHistory();});$("historyItems").addEventListener("click",e=>{const check=e.target.closest("[data-select]");if(check){if(check.checked){selectMode=true;selectedDocumentIds.add(check.dataset.select);}else{selectedDocumentIds.delete(check.dataset.select);if(!selectedDocumentIds.size)selectMode=false;}renderHistory();return;}const open=e.target.closest("[data-open]");if(open)renderDetail(open.dataset.open);});$("selectAll").addEventListener("change",e=>{document.querySelectorAll("#historyItems .history-card:not([hidden]) [data-select]").forEach(c=>{c.checked=e.target.checked;if(e.target.checked)selectedDocumentIds.add(c.dataset.select);else selectedDocumentIds.delete(c.dataset.select);});renderHistory();});$("exportSelected").addEventListener("click",()=>[...selectedDocumentIds].forEach((id,i)=>{const d=workspace.documents.find(x=>x.id===id);setTimeout(()=>d&&exportDocument(d),i*350);}));$("shareSelected").addEventListener("click",async()=>{const names=[...selectedDocumentIds].map(id=>workspace.documents.find(x=>x.id===id)?.name).filter(Boolean);if(navigator.share)await navigator.share({title:"BatchBarcode Snap",text:names.join("\n")});else toast("선택한 파일을 저장한 뒤 공유 메뉴에서 공유하세요.");});$("deleteSelected").addEventListener("click",async()=>{if(!selectedDocumentIds.size)return;workspace.trash.unshift(...workspace.documents.filter(d=>selectedDocumentIds.has(d.id)).map(d=>({...d,deletedAt:Date.now()})));workspace.documents=workspace.documents.filter(d=>!selectedDocumentIds.has(d.id));selectedDocumentIds.clear();selectMode=false;await saveWorkspace();renderHistory();});
$("openTrash").addEventListener("click",()=>{renderTrash();showScreen("trashScreen");});$("trashBack").addEventListener("click",()=>{renderHistory();showScreen("historyScreen");});$("trashItems").addEventListener("click",async e=>{const restore=e.target.closest("[data-restore]"),del=e.target.closest("[data-delete]");if(restore){const d=workspace.trash.find(x=>x.id===restore.dataset.restore);if(d){delete d.deletedAt;workspace.documents.unshift(d);workspace.trash=workspace.trash.filter(x=>x.id!==d.id);}await saveWorkspace();renderTrash();}if(del&&confirm("이 문서를 완전히 삭제할까요?")){workspace.trash=workspace.trash.filter(x=>x.id!==del.dataset.delete);await saveWorkspace();renderTrash();}});
$("detailBack").addEventListener("click",()=>{renderHistory();showScreen("historyScreen");});$("detailPhotos").addEventListener("click",e=>{const tile=e.target.closest("[data-photo]");if(!tile)return;resultIsDraft=false;resultDocumentId=activeDocumentId;resultPhotoIndex=Number(tile.dataset.photo);renderPhotoResult();});$("photoBack").addEventListener("click",()=>{if(resultIsDraft){resumeCameraView();}else renderDetail(resultDocumentId);});$("photoPrevious").addEventListener("click",()=>{const d=resultIsDraft?workspace.draft:workspace.documents.find(x=>x.id===resultDocumentId);if(!d)return;resultPhotoIndex=Math.max(0,resultPhotoIndex-1);renderPhotoResult();});$("photoNext").addEventListener("click",()=>{const d=resultIsDraft?workspace.draft:workspace.documents.find(x=>x.id===resultDocumentId);if(!d)return;resultPhotoIndex=Math.min(d.photos.length-1,resultPhotoIndex+1);renderPhotoResult();});
$("renameDocument").addEventListener("click",async()=>{const d=workspace.documents.find(x=>x.id===activeDocumentId),name=prompt("문서 이름",d?.name);if(d&&name!==null){d.name=name.trim()||d.name;await saveWorkspace();renderDetail(d.id);}});$("deleteDocument").addEventListener("click",async()=>{const d=workspace.documents.find(x=>x.id===activeDocumentId);if(!d)return;d.deletedAt=Date.now();workspace.documents=workspace.documents.filter(x=>x.id!==d.id);workspace.trash.unshift(d);await saveWorkspace();renderHistory();showScreen("historyScreen");});$("exportDocument").addEventListener("click",()=>{const d=workspace.documents.find(x=>x.id===activeDocumentId);if(d)exportDocument(d);});
$("addMorePhotos").addEventListener("click",()=>{$("photoInput").click();});$("photoInput").setAttribute("multiple","");window.addEventListener("resize",()=>{if(video.videoWidth&&running)drawOverlay(overlay,tracks,video.videoWidth,video.videoHeight,"cover");});window.addEventListener("pagehide",stopCamera);
$("showDraftPhotoResult").addEventListener("click",showCurrentPhotoResult);
$("returnToCamera").addEventListener("click",()=>{const d=resultIsDraft?workspace.draft:workspace.documents.find(x=>x.id===resultDocumentId);if(resultIsDraft)openDraft();else if(d)openDocumentCamera(d);});$("saveFromResult").addEventListener("click",()=>{const d=resultIsDraft?workspace.draft:workspace.documents.find(x=>x.id===resultDocumentId);if(d)showDocumentSaveScreen(d);});
$("detailOpen").addEventListener("click",()=>{const d=workspace.documents.find(x=>x.id===activeDocumentId);if(d)exportDocument(d);});$("detailShare").addEventListener("click",()=>{const d=workspace.documents.find(x=>x.id===activeDocumentId);if(d)exportDocument(d);toast("파일을 저장한 뒤 휴대폰 공유 메뉴에서 공유할 수 있어요.");});
$("newDocument").addEventListener("click",openDraft);$("homeSettings").addEventListener("click",()=>{settingsReturnToScanner=false;showScreen("settingsScreen");});$("scannerSettings").addEventListener("click",()=>{settingsReturnToScanner=true;stopCamera();showScreen("settingsScreen");});$("settingsBack").addEventListener("click",()=>{if(settingsReturnToScanner){settingsReturnToScanner=false;resumeCameraView();}else showScreen("homeScreen");});$("openHistory").addEventListener("click",()=>{stopCamera();renderHistory();showScreen("historyScreen");});
$("scanSummary").addEventListener("click",showCurrentPhotoResult);$("scanSummary").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();showCurrentPhotoResult();}});$("showDraftDetail").addEventListener("click",renderCurrentBarcodeList);
$("barcodeListBack").addEventListener("click",()=>{resumeCameraView();});$("barcodeReturnCamera").addEventListener("click",()=>{resumeCameraView();});$("barcodePrevious").addEventListener("click",()=>{barcodePage=Math.max(0,barcodePage-1);renderCurrentBarcodeList();});$("barcodeNext").addEventListener("click",()=>{barcodePage++;renderCurrentBarcodeList();});$("currentBarcodeItems").addEventListener("click",e=>{const row=e.target.closest("[data-hit-photo]");if(!row)return;const d=currentCameraDocument();resultIsDraft=d===workspace.draft;resultDocumentId=resultIsDraft?null:d.id;resultPhotoIndex=Number(row.dataset.hitPhoto);renderPhotoResult();});
$("documentSaveBack").addEventListener("click",()=>{resumeCameraView();});document.querySelectorAll(".format-choice").forEach(button=>button.addEventListener("click",async()=>{workspace.settings.format=button.dataset.format;document.querySelectorAll(".format-choice").forEach(x=>x.classList.toggle("selected",x===button));$("filenameExtension").textContent=button.dataset.format==="csv"?".csv":".xlsx";await saveWorkspace();}));$("confirmSaveDocument").addEventListener("click",async()=>{if(photoProcessing||captureInProgress){toast("사진 처리가 끝난 뒤 저장해 주세요.");return;}const d=workspace.draft?.id===saveTargetId?workspace.draft:workspace.documents.find(x=>x.id===saveTargetId);if(!d?.photos.length){toast("저장할 사진이 없습니다.");return;}const button=$("confirmSaveDocument");button.disabled=true;const previousDocs=[...workspace.documents],previousDraft=workspace.draft;try{d.name=($("documentFilename").value.trim()||d.name).replace(/[\\/:*?"<>|]/g,"_").replace(/\.(xlsx|csv)$/i,"");d.format=workspace.settings.format||"xlsx";d.savedAt=Date.now();workspace.documents=[d,...workspace.documents.filter(x=>x.id!==d.id)];if(workspace.draft?.id===d.id)workspace.draft=null;await saveWorkspace();cameraDocumentId=null;normalizeDraftResults();renderResults();renderHistory();showScreen("historyScreen");toast("문서를 이 기기에 저장했습니다.");}catch(error){workspace.documents=previousDocs;workspace.draft=previousDraft;toast("문서 저장 실패: "+error.message);}finally{button.disabled=false;}});
$("barcodeOrderSetting").addEventListener("change",async e=>{workspace.settings.barcodeOrder=e.target.value;await saveWorkspace();});$("asciiSetting").addEventListener("change",async e=>{workspace.settings.ascii=e.target.checked;await saveWorkspace();});$("filenameFormatSetting").addEventListener("change",async e=>{workspace.settings.filenameFormat=e.target.value;await saveWorkspace();});$("exportFormatSetting").addEventListener("change",async e=>{workspace.settings.format=e.target.value;$("homeFormat").textContent=e.target.value==="csv"?"CSV":"XLSX (Excel)";await saveWorkspace();});$("trashDaysSetting").addEventListener("change",async e=>{workspace.settings.trashDays=Number(e.target.value);await saveWorkspace();});initWorkspace().then(()=>installWebParity({$,getWorkspace:()=>workspace,saveWorkspace,uniqueBarcodes,orderHits:orderOnePhotoRightToLeft,formatBarcodeValue,escapeHtml:esc,renderDetail,renderPhotoResult,renderHistory,renderTrash,showScreen,toast,stopCamera,openDraft,scanPhoto,getActiveDocument:()=>workspace.documents.find(x=>x.id===activeDocumentId),getResult:()=>({doc:resultIsDraft?workspace.draft:workspace.documents.find(x=>x.id===resultDocumentId),photoIndex:resultPhotoIndex,isDraft:resultIsDraft}),normalizeDraftResults,redrawPhotoOverlay,addPhotoFiles,showDocumentSaveScreen,openDocumentCamera,importIntoDocument,getCameraDocument:currentCameraDocument,resumeCameraView,isPhotoProcessing:()=>photoProcessing||captureInProgress})).catch(error=>{console.error("Web app startup failed",error);toast("웹앱 시작 실패: "+error.message);});
if("serviceWorker"in navigator&&(location.protocol==="https:"||location.hostname==="localhost"))navigator.serviceWorker.register("./sw.js").catch(error=>console.warn("Service worker registration failed",error));

// Keep early taps from racing the browser database restore.
document.addEventListener("click",event=>{if(!workspaceReady){event.preventDefault();event.stopImmediatePropagation();toast("저장된 기록을 불러오는 중입니다. 잠시 후 다시 눌러 주세요.");}},true);
window.addEventListener("unhandledrejection",event=>{console.error("Web action failed",event.reason);toast("작업을 완료하지 못했습니다: "+(event.reason?.message||"잠시 후 다시 시도해 주세요."));});
