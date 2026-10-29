let worker=null,pending=null,sequence=0;
export function stopLiveDecoder() {
  worker?.terminate();worker=null;
  if(pending){clearTimeout(pending.timer);pending.reject(new DOMException('카메라 인식 중단','AbortError'));pending=null;}
}
export function decodeLiveFrame(image) {
  if(typeof Worker!=='function')return import('./photo-engine.js?v=19').then(engine=>engine.scanFramePixels(image));
  if(pending)return Promise.reject(new Error('이전 프레임 인식 중입니다.'));
  if(!worker){
    worker=new Worker(new URL('./live-worker.js?v=19',import.meta.url),{type:'module'});
    const owner=worker;
    worker.onmessage=({data})=>{
      if(worker!==owner||!pending||data.id!==pending.id)return;
      const job=pending;pending=null;clearTimeout(job.timer);
      data.error?job.reject(new Error(data.error)):job.resolve(data.hits);
    };
    worker.onerror=()=>{if(worker!==owner)return;const job=pending;pending=null;worker?.terminate();worker=null;if(job){clearTimeout(job.timer);job.reject(new Error('실시간 인식 엔진을 시작하지 못했습니다.'));}};
  }
  return new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{const job=pending;pending=null;worker?.terminate();worker=null;job?.reject(new Error('실시간 인식 응답 시간이 초과됐습니다.'));},30000);
    pending={id,timer,resolve,reject};
    worker.postMessage({id,image},[image.data.buffer]);
  });
}
