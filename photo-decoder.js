let sequence=0;
async function decodeOnMainThread(file,onProgress) {
  const {scanPhotoSource}=await import('./photo-engine.js?v=19');
  const image=new Image(),url=URL.createObjectURL(file);
  try {image.src=url;await image.decode();return await scanPhotoSource(image,()=>document.createElement('canvas'),onProgress);}
  finally {URL.revokeObjectURL(url);}
}

function decodeInWorker(file,onProgress) {
  return new Promise((resolve,reject)=>{
    let worker,timer,finished=false;
    const finish=(error,result)=>{
      if(finished)return;
      finished=true;clearTimeout(timer);
      if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}
      error?reject(error):resolve(result);
    };
    try {
      const id=++sequence;
      worker=new Worker(new URL('./photo-worker.js?v=19',import.meta.url),{type:'module'});
      timer=setTimeout(()=>{
        const error=new Error('사진 인식 시간이 초과됐습니다. 원본은 보존되어 있으니 결과의 다시 인식을 눌러 시도해 주세요.');
        error.name='PhotoDecodeTimeoutError';finish(error);
      },120000);
      worker.onmessage=({data})=>{
        if(data?.id!==id)return;
        if(data.progress){
          try {onProgress(data.progress);} catch(error) {finish(error);}
        } else finish(data.error?new Error(data.error):null,data.result);
      };
      worker.onerror=event=>{event?.preventDefault?.();finish(new Error('사진 인식 작업자를 시작하지 못했습니다.'));};
      worker.onmessageerror=()=>finish(new Error('사진 인식 결과를 전달하지 못했습니다.'));
      worker.postMessage({id,file});
    } catch(error) {finish(error);}
  });
}

export async function decodePhotoFile(file,onProgress=()=>{}) {
  if(typeof Worker==='function' && typeof OffscreenCanvas==='function' && typeof createImageBitmap==='function') {
    try {return await decodeInWorker(file,onProgress);}
    catch(error) {
      // A long-running scan must not silently start another two-minute attempt.
      if(error?.name==='PhotoDecodeTimeoutError')throw error;
      // Some browsers expose these APIs but block module workers or cannot clone
      // this file. The same local File can still be decoded on the main thread.
      onProgress({stage:'이 브라우저에서 사진 인식을 다시 준비하는 중',count:0});
    }
  }
  return decodeOnMainThread(file,onProgress);
}

