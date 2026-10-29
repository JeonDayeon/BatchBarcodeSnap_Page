let sequence=0;
export async function decodePhotoFile(file,onProgress=()=>{}) {
  if(typeof Worker==='function' && typeof OffscreenCanvas==='function' && typeof createImageBitmap==='function') {
    return new Promise((resolve,reject)=>{
      const id=++sequence,worker=new Worker(new URL('./photo-worker.js?v=17',import.meta.url),{type:'module'});
      const timer=setTimeout(()=>{worker.terminate();reject(new Error('사진 인식 시간이 초과됐습니다. 바코드가 더 크게 보이는 사진으로 다시 시도해 주세요.'));},120000);
      const finish=(error,result)=>{clearTimeout(timer);worker.terminate();error?reject(error):resolve(result);};
      worker.onmessage=({data})=>{if(data.id!==id)return;if(data.progress)onProgress(data.progress);else finish(data.error?new Error(data.error):null,data.result);};
      worker.onerror=()=>finish(new Error('사진 인식 엔진을 시작하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.'));
      worker.postMessage({id,file});
    });
  }
  const {scanPhotoSource}=await import('./photo-engine.js?v=17');
  const image=new Image(),url=URL.createObjectURL(file);
  try {image.src=url;await image.decode();return await scanPhotoSource(image,()=>document.createElement('canvas'),onProgress);}
  finally {URL.revokeObjectURL(url);}
}
