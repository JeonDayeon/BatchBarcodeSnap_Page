import { scanPhotoSource } from './photo-engine.js?v=19';
self.onmessage=async ({data})=>{
  let image;
  try {
    image=await createImageBitmap(data.file);
    const result=await scanPhotoSource(image,()=>new OffscreenCanvas(1,1),progress=>self.postMessage({id:data.id,progress}));
    self.postMessage({id:data.id,result});
  } catch(error) {self.postMessage({id:data.id,error:error.message||'사진 인식에 실패했습니다.'});}
  finally {image?.close();}
};

