import { scanFramePixels } from './photo-engine.js?v=19';
self.onmessage=async({data})=>{
  try {self.postMessage({id:data.id,hits:await scanFramePixels(data.image)});}
  catch(error){self.postMessage({id:data.id,error:error.message||'실시간 인식 실패'});}
};
