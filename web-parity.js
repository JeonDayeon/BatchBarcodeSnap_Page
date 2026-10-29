import { buildDocumentFile, downloadDocumentFile, shareDocumentFiles, openDocumentFile, canShareDocumentFiles, documentFileErrorMessage } from './document-files.js?v=18';

// Browser implementations of the Android document and photo actions.
export function installWebParity(api) {
  const { $, getWorkspace, saveWorkspace, uniqueBarcodes, orderHits, formatBarcodeValue,
    escapeHtml: esc, renderDetail, renderPhotoResult, renderHistory, showScreen,
    toast, stopCamera, openDraft, scanPhoto, getActiveDocument, getResult } = api;
  let selectedPhotos = new Set(), selectedPhotoDocument = null, suppressPhotoClick = false;
  let dateStart = '', dateEnd = '', alphabetical = false, working = false, saveReturnToResult=false, pendingImportDoc=null;
  const ws = getWorkspace;
  document.addEventListener('click',e=>{if(working && e.target.closest('.screen')){e.preventDefault();e.stopImmediatePropagation();toast('현재 처리가 끝날 때까지 잠시 기다려 주세요.');}},true);
  const currentScreen = () => document.querySelector('.screen.active')?.id;
  const resultPhoto = () => { const r = getResult(); return { ...r, photo: r.doc?.photos[r.photoIndex] }; };
  const loadImage = async blob => {
    if(typeof createImageBitmap==='function') return createImageBitmap(blob);
    const image=new Image(),url=URL.createObjectURL(blob);image.src=url;
    try{await image.decode();image.close=()=>URL.revokeObjectURL(url);return image;}catch(error){URL.revokeObjectURL(url);throw error;}
  };
  const intercept = (id, handler, event = 'click') => $(id)?.addEventListener(event, e => {
    e.preventDefault(); e.stopImmediatePropagation();
    Promise.resolve(handler(e)).catch(error => { if (error?.name !== 'AbortError') toast(error?.message || '작업을 완료하지 못했습니다.'); });
  }, true);

  function dialog(title, content, actions) {
    const el = document.createElement('dialog'); el.className = 'app-dialog';
    el.innerHTML = `<h2>${esc(title)}</h2><div class="dialog-body">${content}</div><div class="dialog-actions"></div>`;
    document.body.append(el);
    return new Promise(resolve => {
      const finish = value => { el.close(); el.remove(); resolve(value); };
      for (const action of actions) {
        const b = document.createElement('button'); b.type = 'button'; b.className = action.danger ? 'danger-button' : 'secondary-button'; b.textContent = action.label;
        b.onclick = () => { if (action.validate && !action.validate(el)) return; finish({ action: action.value, element: el }); };
        el.querySelector('.dialog-actions').append(b);
      }
      el.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
      el.showModal();
    });
  }
  async function confirmation(title, text) {
    return (await dialog(title, `<p>${esc(text)}</p>`, [{label:'취소',value:'cancel'},{label:'삭제',value:'delete',danger:true}]))?.action === 'delete';
  }
  async function run(label, operation) {
    if (working) { toast('처리 중입니다. 잠시 기다려 주세요.'); return; }
    working = true; $('operationStatus').textContent = label; $('operationStatus').classList.remove('hidden');
    document.body.classList.add('operation-busy');
    try { return await operation(); }
    finally { working = false; $('operationStatus').classList.add('hidden'); document.body.classList.remove('operation-busy'); }
  }
  const fileOptions = doc => ({format:doc.format || ws().settings.format || 'xlsx', ascii:!!ws().settings.ascii, order:orderHits});
  function preparedFileDialog(files, { title = '문서 파일 공유', open = false } = {}) {
    const el = document.createElement('dialog'); el.className = 'app-dialog';
    el.innerHTML = `<h2>${esc(title)}</h2><div class="dialog-body"><p>파일이 준비되었습니다. 아래 버튼을 눌러 공유하거나 기기에 저장하세요.</p><ul>${files.map((file, index) => `<li>${esc(file.name)}${files.length > 1 ? ` <button type="button" class="secondary-button" data-save-file="${index}">파일 저장</button>` : ''}</li>`).join('')}</ul><p role="status" aria-live="polite"></p></div><div class="dialog-actions"></div>`;
    document.body.append(el);
    const status = el.querySelector('[role="status"]'), actions = el.querySelector('.dialog-actions');
    let sharing = false;
    const addButton = (label, handler) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'; button.textContent = label; button.onclick = handler; actions.append(button); return button;
    };
    const close = () => { if (!sharing) { el.close(); el.remove(); } };
    const saveFile = file => {
      try { downloadDocumentFile(file); status.textContent = `${file.name} 파일의 다운로드를 요청했습니다. 브라우저의 다운로드 목록 또는 휴대폰 ‘파일’ 앱에서 확인하세요.`; }
      catch { status.textContent = '파일을 내려받지 못했습니다. 브라우저의 다운로드 허용 설정을 확인한 뒤 ‘파일 저장’을 다시 눌러 주세요.'; }
    };
    for (const button of el.querySelectorAll('[data-save-file]')) button.onclick = () => saveFile(files[Number(button.dataset.saveFile)]);
    addButton('닫기', close);
    if (files.length === 1) addButton('파일 저장', () => saveFile(files[0]));
    if (open && files.length === 1) addButton('파일 열기', () => {
      try {
        const result = openDocumentFile(files[0]);
        status.textContent = result === 'opened' ? '문서 파일을 새 창에서 열었습니다.' : '새 창 대신 다운로드를 요청했습니다. 내려받은 파일을 Excel에서 열어 주세요.';
      } catch (error) { status.textContent = documentFileErrorMessage(error, 'open'); }
    });
    const shareButton = addButton('파일 공유', () => {
      if (sharing) return;
      // This handler itself opens the native share sheet. Do not await a dialog
      // promise, create XLSX data, or inspect userActivation before calling it.
      const request = shareDocumentFiles(files, { fallbackToDownload: false });
      sharing = true;
      for (const button of el.querySelectorAll('button')) button.disabled = true;
      status.textContent = '공유 창을 여는 중…';
      Promise.resolve(request).then(result => {
        if (result === 'shared') status.textContent = '파일 공유를 완료했습니다.';
        else if (result === 'cancelled') status.textContent = '공유를 취소했습니다. 파일은 준비되어 있으니 다시 공유하거나 저장할 수 있어요.';
        else status.textContent = '이 브라우저는 파일 공유를 지원하지 않습니다. ‘파일 저장’으로 내려받은 뒤 공유해 주세요.';
      }).catch(error => {
        status.textContent = error?.name === 'DocumentFileShareError' ? error.message : documentFileErrorMessage(error);
      }).finally(() => {
        sharing = false;
        for (const button of el.querySelectorAll('button')) button.disabled = false;
        shareButton.disabled = !canShareDocumentFiles(files);
      });
    });
    shareButton.disabled = !canShareDocumentFiles(files);
    if (shareButton.disabled) status.textContent = '이 브라우저는 파일 공유를 지원하지 않습니다. ‘파일 저장’으로 내려받은 뒤 공유해 주세요.';
    el.addEventListener('cancel', event => { event.preventDefault(); close(); });
    el.showModal();
  }
  async function fileAction(doc, action) {
    if (!doc) return;
    const file = await run('문서 파일을 만드는 중…', () => buildDocumentFile(doc, fileOptions(doc)));
    if (!file) return;
    if (action === 'share') {
      preparedFileDialog([file]);
    } else if (action === 'open') {
      preparedFileDialog([file], {title:'문서 파일 열기',open:true});
    } else { downloadDocumentFile(file); toast('문서 파일을 다운로드했습니다.'); }
  }
  intercept('exportDocument', () => fileAction(getActiveDocument(), 'save'));
  intercept('detailOpen', () => fileAction(getActiveDocument(), 'open'));
  intercept('detailShare', () => fileAction(getActiveDocument(), 'share'));
  function selectedDocuments() {
    return [...document.querySelectorAll('#historyItems [data-select]:checked')].map(el => ws().documents.find(d => d.id === el.dataset.select)).filter(Boolean);
  }
  intercept('exportSelected', async () => {
    const docs = selectedDocuments(); if (!docs.length) return toast('문서를 선택해 주세요.');
    const file = await run('선택 문서를 만드는 중…', () => buildDocumentFile(docs, {...fileOptions(docs[0]), name:'선택한_문서'}));
    if(file) { downloadDocumentFile(file); toast('선택한 문서를 한 파일로 다운로드했습니다.'); }
  });
  intercept('shareSelected', async () => {
    const docs = selectedDocuments(); if (!docs.length) return toast('문서를 선택해 주세요.');
    const files = await run('공유 파일을 만드는 중…', () => Promise.all(docs.map(d => buildDocumentFile(d,fileOptions(d)))));
    if(!files)return;
    preparedFileDialog(files, {title:'선택 문서 공유'});
  });
  intercept('deleteSelected', async () => {
    const docs = selectedDocuments(); if (!docs.length) return toast('문서를 선택해 주세요.');
    if (!await confirmation('문서 삭제', `선택한 문서 ${docs.length}개를 휴지통으로 옮길까요?`)) return;
    const ids = new Set(docs.map(d=>d.id)); ws().trash.unshift(...docs.map(d=>({...d,deletedAt:Date.now()})));
    ws().documents = ws().documents.filter(d=>!ids.has(d.id)); await saveWorkspace(); renderHistory(); toast('휴지통으로 옮겼습니다.');
  });
  intercept('deleteDocument', async () => {
    const d=getActiveDocument(); if (!d || !await confirmation('문서 삭제','이 작업을 휴지통으로 옮길까요?')) return;
    ws().documents=ws().documents.filter(x=>x.id!==d.id); ws().trash.unshift({...d,deletedAt:Date.now()}); await saveWorkspace(); renderHistory(); showScreen('historyScreen');
  });
  const expiredTrash=()=>ws().trash.filter(d=>d.deletedAt&&Date.now()-d.deletedAt>Number(ws().settings.trashDays||30)*86400000);
  intercept('purgeExpiredTrash',async()=>{
    const docs=expiredTrash();if(!docs.length)return;
    if(!await confirmation('보관 기간 지난 문서 정리',`${docs.length}개 문서를 이 브라우저에서 영구 삭제할까요? 복구할 수 없습니다.`))return;
    const ids=new Set(docs.map(d=>d.id));ws().trash=ws().trash.filter(d=>!ids.has(d.id));await saveWorkspace();api.renderTrash();
  });
  intercept('exitScanner', async () => {
    if (working || api.isPhotoProcessing?.()) return toast('사진 처리가 끝난 뒤 나갈 수 있어요.');
    const cameraDoc=api.getCameraDocument?.();
    if(cameraDoc && cameraDoc!==ws().draft){stopCamera();renderDetail(cameraDoc.id);return;}
    if (!ws().draft?.photos.length) {stopCamera(); showScreen('homeScreen'); return;}
    const choice = await dialog('촬영 중인 작업', `<p>사진 ${ws().draft.photos.length}장이 아직 작업 목록에 저장되지 않았어요.</p>`, [{label:'계속 촬영',value:'continue'},{label:'저장하기',value:'save'},{label:'저장하지 않고 나가기',value:'discard',danger:true}]);
    if(choice?.action === 'save') {saveReturnToResult=false;api.showDocumentSaveScreen();}
    if(choice?.action === 'discard') {ws().draft=null; api.normalizeDraftResults(); await saveWorkspace(); stopCamera(); showScreen('homeScreen');}
  });
  intercept('saveFromResult', async () => {
    const r=getResult(); if(r.doc) {saveReturnToResult=true;api.showDocumentSaveScreen(r.doc);}
  });
  intercept('saveDocument',()=>{saveReturnToResult=false;api.showDocumentSaveScreen();});
  intercept('documentSaveBack',()=>{if(saveReturnToResult){saveReturnToResult=false;renderPhotoResult();}else api.resumeCameraView();});

  function decorateHistory() {
    if (!$('historyItems')) return;
    const rows=[...$('historyItems').children], visible=[];
    for(const row of rows) {
      const id=row.querySelector('[data-open]')?.dataset.open, d=ws().documents.find(x=>x.id===id);
      if(!d) continue;
      const time=d.createdAt||d.savedAt, start=dateStart?new Date(dateStart+'T00:00:00').getTime():-Infinity, end=dateEnd?new Date(dateEnd+'T23:59:59.999').getTime():Infinity;
      row.hidden = time<start||time>end; if(!row.hidden) visible.push({row,d});
    }
    visible.sort((a,b)=>alphabetical?a.d.name.localeCompare(b.d.name,'ko'):(b.d.createdAt||b.d.savedAt)-(a.d.createdAt||a.d.savedAt));
    const visibleRows=rows.filter(x=>!x.hidden);
    if(visible.some((x,i)=>x.row!==visibleRows[i])) for(const x of visible) $('historyItems').append(x.row);
    $('historyCount').textContent=`저장된 문서 ${visible.length}개`;
    $('emptyHistory').classList.toggle('hidden',visible.length>0);
    const selected=rows.filter(x=>x.querySelector('[data-select]')?.checked).length;
    const all=visible.length>0 && visible.every(x=>x.row.querySelector('[data-select]')?.checked);
    $('selectAll').checked=all; $('selectAll').indeterminate=selected>0&&!all;
    $('selectedCount').textContent=`${selected}개 선택`;
    for(const id of ['exportSelected','shareSelected','deleteSelected']) $(id).disabled=selected===0;
    $('historySort').textContent=alphabetical?'가나다순 ▾':'최근 저장순 ▾';
  }
  intercept('historySort', async () => {
    const c=await dialog('정렬', '', [{label:'최근 저장순',value:'recent'},{label:'가나다순',value:'name'},{label:'취소',value:'cancel'}]);
    if(!c||c.action==='cancel')return; alphabetical=c.action==='name'; ws().settings.historySort=alphabetical?'name':'recent'; await saveWorkspace(); decorateHistory();
  });
  intercept('historyPeriod', async () => {
    const c=await dialog('저장 기간', `<label>시작일<input id="periodStart" type="date" value="${dateStart}"></label><label>종료일<input id="periodEnd" type="date" value="${dateEnd}"></label><div class="period-shortcuts"><button type="button" data-period="today">오늘</button><button type="button" data-period="yesterday">어제</button><button type="button" data-period="month">이번 달</button><button type="button" data-period="lastMonth">지난달</button></div><p class="dialog-error" role="alert"></p>`, [{label:'전체 기간',value:'all'},{label:'취소',value:'cancel'},{label:'기간 검색',value:'apply',validate:el=>{
      const s=el.querySelector('#periodStart').value,e=el.querySelector('#periodEnd').value;
      if(!s||!e||s>e){el.querySelector('.dialog-error').textContent='시작일과 종료일을 올바르게 선택하세요.';return false;}return true;
    }}]);
    if(!c||c.action==='cancel')return;
    if(c.action==='all'){dateStart='';dateEnd='';} else {dateStart=c.element.querySelector('#periodStart').value;dateEnd=c.element.querySelector('#periodEnd').value;}
    $('historyPeriod').textContent=dateStart?'지정기간 ▾':'전체 기간 ▾';decorateHistory();
  });
  document.addEventListener('click', e=>{
    const b=e.target.closest('[data-period]');if(!b)return;
    const d=new Date(), key=b.dataset.period; let start=new Date(d.getFullYear(),d.getMonth(),d.getDate()),end=new Date(start);
    if(key==='yesterday'){start.setDate(start.getDate()-1);end=new Date(start);}
    if(key==='month')start=new Date(d.getFullYear(),d.getMonth(),1);
    if(key==='lastMonth'){start=new Date(d.getFullYear(),d.getMonth()-1,1);end=new Date(d.getFullYear(),d.getMonth(),0);}
    const date=x=>`${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;
    b.closest('dialog').querySelector('#periodStart').value=date(start);b.closest('dialog').querySelector('#periodEnd').value=date(end);
  });
  intercept('historyBack', ()=>{
    if(!$('historySelection').classList.contains('hidden')) $('toggleSelect').click();else showScreen('homeScreen');
  });

  function decorateDetail() {
    const d=getActiveDocument(); if(!d) return;
    if(selectedPhotoDocument!==d.id){selectedPhotos.clear();selectedPhotoDocument=d.id;}
    const selecting=selectedPhotos.size>0;
    for(const row of $('detailPhotos').querySelectorAll('[data-photo]')){
      const p=d.photos[Number(row.dataset.photo)], selected=selectedPhotos.has(p?.id||p?.name);
      row.classList.toggle('photo-selected',selected);row.classList.toggle('photo-selecting',selecting);row.setAttribute('aria-pressed',String(selected));
    }
    $('photoSelectionActions').classList.toggle('hidden',!selecting);$('deleteSelectedPhotos').textContent=`선택 사진 ${selectedPhotos.size}장 삭제`;
    $('addMorePhotos').classList.toggle('hidden',selecting);
    $('detailScreen').querySelector('.detail-footer').classList.toggle('hidden',selecting);$('deleteDocument').classList.toggle('hidden',selecting);
    $('detailFileInfo').textContent=`${(d.format||'xlsx').toUpperCase()} · 이 브라우저에 저장됨 · 내보내기는 브라우저 다운로드 위치 사용`;
  }
  function togglePhoto(index) {
    const d=getActiveDocument(),p=d?.photos[index];if(!p)return;const key=p.id||p.name;
    if(selectedPhotos.has(key))selectedPhotos.delete(key);else selectedPhotos.add(key);decorateDetail();
  }
  let holdTimer, downPoint;
  $('detailPhotos').addEventListener('pointerdown',e=>{
    const row=e.target.closest('[data-photo]');if(!row || e.button>0)return;
    downPoint={x:e.clientX,y:e.clientY};clearTimeout(holdTimer);
    holdTimer=setTimeout(()=>{togglePhoto(Number(row.dataset.photo));suppressPhotoClick=true;},400);
  });
  $('detailPhotos').addEventListener('pointermove',e=>{if(downPoint&&Math.hypot(e.clientX-downPoint.x,e.clientY-downPoint.y)>10)clearTimeout(holdTimer);});
  for(const type of ['pointerup','pointercancel','pointerleave'])$('detailPhotos').addEventListener(type,()=>{clearTimeout(holdTimer);downPoint=null;});
  $('detailPhotos').addEventListener('contextmenu',e=>{const row=e.target.closest('[data-photo]');if(row){e.preventDefault();if(!suppressPhotoClick)togglePhoto(Number(row.dataset.photo));}});
  $('detailPhotos').addEventListener('click',e=>{
    const row=e.target.closest('[data-photo]');if(!row)return;
    if(suppressPhotoClick||selectedPhotos.size){e.preventDefault();e.stopImmediatePropagation();if(!suppressPhotoClick)togglePhoto(Number(row.dataset.photo));suppressPhotoClick=false;}
  },true);
  intercept('selectPhotos',()=>{const d=getActiveDocument();if(d?.photos.length)togglePhoto(0);});
  intercept('exitPhotoSelection',()=>{selectedPhotos.clear();decorateDetail();});
  intercept('deleteSelectedPhotos',async()=>{
    const d=getActiveDocument();if(!d||!selectedPhotos.size)return;
    if(!await confirmation('선택한 사진 삭제',`선택한 사진 ${selectedPhotos.size}장을 인식 기록과 함께 삭제할까요? 이 브라우저의 이 문서에서만 삭제됩니다.`))return;
    d.photos=d.photos.filter(p=>!selectedPhotos.has(p.id||p.name));selectedPhotos.clear();await saveWorkspace();
    if(d.photos.length)renderDetail(d.id);else{renderHistory();showScreen('historyScreen');}toast('선택한 사진과 인식 기록을 삭제했습니다.');
  });
  intercept('detailBack',()=>{if(selectedPhotos.size){selectedPhotos.clear();decorateDetail();}else{renderHistory();showScreen('historyScreen');}});
  intercept('addMorePhotos',async()=>{
    const d=getActiveDocument();if(!d)return;
    const c=await dialog('사진 추가','',[{label:'갤러리에서 선택',value:'gallery'},{label:'카메라로 촬영',value:'camera'},{label:'취소',value:'cancel'}]);
    if(c?.action==='gallery'){pendingImportDoc=d;$('detailPhotoInput').click();}
    if(c?.action==='camera')api.openDocumentCamera(d);
  });
  $('detailPhotoInput').addEventListener('change',async e=>{
    const files=[...e.target.files],target=pendingImportDoc;pendingImportDoc=null;e.target.value='';
    if(files.length&&target&&ws().documents.some(d=>d.id===target.id))try{await api.importIntoDocument(files,target);}catch(error){toast(error.message);}
  });

  intercept('retryPhoto',async()=>{
    const {doc,photo}=resultPhoto();if(!photo)return;
    await run('이 사진을 다시 인식하는 중…',async()=>{
      try {
        const r=await scanPhoto(photo.blob),sx=r.width/r.canvasWidth,sy=r.height/r.canvasHeight;
        photo.hits=r.hits.map(h=>({...h,left:h.left*sx,right:h.right*sx,top:h.top*sy,bottom:h.bottom*sy}));
        photo.width=r.width;photo.height=r.height;photo.scanWidth=r.width;photo.scanHeight=r.height;photo.elapsedMs=r.elapsedMs;photo.engine=r.engine;photo.rawHits=r.rawHits;photo.passes=r.passes;photo.scanState='done';delete photo.scanError;
        if(doc===ws().draft)api.normalizeDraftResults();await saveWorkspace();renderPhotoResult();toast(`다시 인식 완료 · ${photo.hits.length}개`);
      }catch(error){photo.scanError=error.message;await saveWorkspace();renderPhotoResult();throw error;}
    });
  });
  intercept('rotateResultPhoto',async()=>{
    const {photo,doc}=resultPhoto();if(!photo)return;
    await run('사진과 바코드 좌표를 회전하는 중…',async()=>{
      const bitmap=await loadImage(photo.blob),canvas=document.createElement('canvas');canvas.width=bitmap.height;canvas.height=bitmap.width;
      const c=canvas.getContext('2d');c.translate(canvas.width,0);c.rotate(Math.PI/2);c.drawImage(bitmap,0,0);bitmap.close();
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.96));if(!blob)throw new Error('사진 회전에 실패했습니다.');
      const oldHeight=photo.scanHeight||photo.height;
      photo.hits=photo.hits.map(h=>({...h,left:oldHeight-h.bottom,top:h.left,right:oldHeight-h.top,bottom:h.right}));
      photo.blob=blob;photo.type=blob.type;photo.width=canvas.width;photo.height=canvas.height;photo.scanWidth=canvas.width;photo.scanHeight=canvas.height;
      if(doc===ws().draft)api.normalizeDraftResults();await saveWorkspace();renderPhotoResult();toast('사진과 인식 위치를 시계 방향 90° 회전했습니다.');
    });
  });

  let zoomCleanup=()=>{};
  async function openZoom(withOverlay,focusIndex) {
    const {photo}=resultPhoto();if(!photo)return;
    const image=await loadImage(photo.blob),hits=orderHits(photo.hits||[]);
    const dialogEl=document.createElement('dialog');dialogEl.className='zoom-dialog';
    dialogEl.innerHTML=`<header><button type="button" data-close aria-label="사진 확대 닫기">‹ 닫기</button><strong>${withOverlay?'인식 결과':'원본 사진'}</strong><button type="button" data-reset>초기화</button></header><div class="zoom-tools"><button data-zoom="out" aria-label="축소">−</button><span>두 손가락 확대 · 끌어서 이동</span><button data-zoom="in" aria-label="확대">＋</button></div><div class="zoom-viewport"><canvas></canvas></div><p>사진을 두 번 누르면 초기화됩니다.</p>`;
    document.body.append(dialogEl);dialogEl.showModal();
    const viewport=dialogEl.querySelector('.zoom-viewport'),canvas=dialogEl.querySelector('canvas'),context=canvas.getContext('2d');
    // The stored photo stays full resolution; the viewer limits its display surface.
    const ratio=Math.min(1,3000/Math.max(image.width,image.height));canvas.width=Math.round(image.width*ratio);canvas.height=Math.round(image.height*ratio);context.drawImage(image,0,0,canvas.width,canvas.height);image.close();
    if(withOverlay)for(const [i,h] of hits.entries()){
      const sx=canvas.width/(photo.scanWidth||photo.width),sy=canvas.height/(photo.scanHeight||photo.height),x=h.left*sx,y=h.top*sy,w=(h.right-h.left)*sx,hh=(h.bottom-h.top)*sy;
      context.lineWidth=Math.max(2,canvas.width/500);context.strokeStyle=i===focusIndex?'#f79009':'#12b76a';context.strokeRect(x,y,w,hh);context.font=`bold ${Math.max(14,canvas.width/70)}px sans-serif`;context.fillStyle=context.strokeStyle;context.fillText(`${i+1} ✓`,x,Math.max(18,y-4));
    }
    let scale=1,x=0,y=0;const pointers=new Map();let gesture=null;
    const fit=()=>Math.min(viewport.clientWidth/canvas.width,viewport.clientHeight/canvas.height);
    const paint=()=>{canvas.style.width=canvas.width*fit()+'px';canvas.style.height=canvas.height*fit()+'px';canvas.style.transform=`translate(calc(-50% + ${x}px),calc(-50% + ${y}px)) scale(${scale})`;};
    const reset=()=>{scale=1;x=0;y=0;paint();};
    const close=()=>{zoomCleanup();dialogEl.close();dialogEl.remove();};
    dialogEl.querySelector('[data-close]').onclick=close;dialogEl.querySelector('[data-reset]').onclick=reset;dialogEl.addEventListener('cancel',e=>{e.preventDefault();close();});
    dialogEl.querySelector('[data-zoom="in"]').onclick=()=>{scale=Math.min(12,scale*1.5);paint();};dialogEl.querySelector('[data-zoom="out"]').onclick=()=>{scale=Math.max(1,scale/1.5);paint();};
    viewport.addEventListener('wheel',e=>{e.preventDefault();scale=Math.max(1,Math.min(12,scale*(e.deltaY<0?1.15:1/1.15)));paint();},{passive:false});
    const startGesture=()=>{const p=[...pointers.values()];gesture={x,y,scale,point:p[0],distance:p.length>1?Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y):0};};
    viewport.onpointerdown=e=>{viewport.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});startGesture();};
    viewport.onpointermove=e=>{if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});const p=[...pointers.values()];if(p.length>1&&gesture.distance){scale=Math.max(1,Math.min(12,gesture.scale*Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)/gesture.distance));}else{x=gesture.x+p[0].x-gesture.point.x;y=gesture.y+p[0].y-gesture.point.y;}paint();};
    viewport.onpointerup=viewport.onpointercancel=e=>{pointers.delete(e.pointerId);if(pointers.size)startGesture();};viewport.ondblclick=reset;
    const resize=()=>paint();window.addEventListener('resize',resize);zoomCleanup=()=>window.removeEventListener('resize',resize);paint();
    if(Number.isInteger(focusIndex)&&hits[focusIndex]){const h=hits[focusIndex],cx=(h.left+h.right)/2/(photo.scanWidth||photo.width)*canvas.width,cy=(h.top+h.bottom)/2/(photo.scanHeight||photo.height)*canvas.height;scale=3;x=(canvas.width/2-cx)*fit()*scale;y=(canvas.height/2-cy)*fit()*scale;paint();}
  }
  $('photoOriginalImage').addEventListener('click',()=>openZoom(false).catch(e=>toast(e.message)));
  $('photoResultImageWrap').addEventListener('click',()=>openZoom(true).catch(e=>toast(e.message)));
  $('photoResultList').addEventListener('click',e=>{const row=e.target.closest('li');if(!row)return;const i=[...row.parentElement.children].indexOf(row);if(i<getResult().doc?.photos[getResult().photoIndex]?.hits.length)openZoom(true,i).catch(e=>toast(e.message));});
  for(const id of ['photoOriginalImage','photoResultImageWrap']){$(id).tabIndex=0;$(id).setAttribute('role','button');$(id).setAttribute('aria-label',id==='photoOriginalImage'?'원본 사진 크게 보기':'인식 결과 크게 보기');$(id).addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$(id).click();}});}

  const refresh=()=>{
    if(currentScreen()==='historyScreen')decorateHistory();
    if(currentScreen()==='detailScreen')decorateDetail();
    if(currentScreen()==='trashScreen'){$('purgeExpiredTrash').classList.toggle('hidden',!expiredTrash().length);$('purgeExpiredTrash').textContent=`보관 기간 지난 문서 ${expiredTrash().length}개 정리`;}
    if(currentScreen()==='photoResultScreen'){
      const {photo}=resultPhoto();$('photoScanError').textContent=photo?.scanError?`인식 오류: ${photo.scanError} · 다시 인식을 눌러 주세요.`:'';
    }
  };
  const observer=new MutationObserver(refresh);
  for(const id of ['historyItems','trashItems','detailPhotos','photoResultList'])observer.observe($(id),{childList:true});
  for(const screen of document.querySelectorAll('.screen'))observer.observe(screen,{attributes:true,attributeFilter:['class']});
  $('historySearch').addEventListener('input',()=>queueMicrotask(decorateHistory));
  $('historyItems').addEventListener('click',()=>queueMicrotask(decorateHistory));
  $('toggleSelect').addEventListener('click',()=>queueMicrotask(decorateHistory));
  window.addEventListener('resize',()=>{if(currentScreen()==='photoResultScreen')api.redrawPhotoOverlay?.();});
  if(typeof ResizeObserver==='function')new ResizeObserver(()=>api.redrawPhotoOverlay?.()).observe($('photoResultImageWrap'));
  $('storagePath').textContent='▱　이 브라우저의 기기 내 저장소';
  $('storageInfo').addEventListener('click',()=>dialog('저장 위치','<p>사진과 작업은 현재 브라우저의 IndexedDB에 저장됩니다. 파일 내보내기는 휴대폰 또는 브라우저의 다운로드 위치를 사용합니다.</p>',[{label:'확인',value:'ok'}]));
  for(const [id,key] of [['autoCaptureSetting','autoCapture'],['torchSetting','torch']]){
    $(id).checked=!!ws().settings[key];$(id).addEventListener('change',async e=>{ws().settings[key]=e.target.checked;await saveWorkspace();});
  }
  alphabetical=ws().settings.historySort==='name';
  refresh();
}

