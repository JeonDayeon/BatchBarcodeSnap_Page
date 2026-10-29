const labels={code_128:'Code 128',data_matrix:'Data Matrix',qr_code:'QR Code',code_39:'Code 39',code_93:'Code 93',ean_13:'EAN-13',ean_8:'EAN-8',upc_a:'UPC-A',upc_e:'UPC-E',itf:'ITF',aztec:'Aztec',pdf417:'PDF417'};
let ready;
async function getDetector(){
  if(typeof BarcodeDetector!=='function')return null;
  return ready ||= (async()=>{
    const supported=await BarcodeDetector.getSupportedFormats();
    const formats=['code_128','data_matrix','qr_code'].filter(f=>supported.includes(f));
    return formats.length?new BarcodeDetector({formats}):null;
  })().catch(()=>null);
}
export async function detectNativePixels(image){
  try{
    const detector=await getDetector();if(!detector)return [];
    const found=await detector.detect(image);
    return found.filter(r=>typeof r.rawValue==='string'&&r.rawValue.length&&labels[r.format]).map(r=>{
      const b=r.boundingBox,corners=r.cornerPoints?.length===4?r.cornerPoints:[{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x+b.width,y:b.y+b.height},{x:b.x,y:b.y+b.height}];
      return {value:r.rawValue,format:labels[r.format],corners:corners.map(p=>({x:p.x,y:p.y})),left:Math.min(...corners.map(p=>p.x)),top:Math.min(...corners.map(p=>p.y)),right:Math.max(...corners.map(p=>p.x)),bottom:Math.max(...corners.map(p=>p.y)),engine:'browser-native'};
    }).filter(r=>[r.left,r.top,r.right,r.bottom].every(Number.isFinite)&&r.right>r.left&&r.bottom>r.top);
  }catch{return [];}
}
export function combineEngineHits(primary,supplement){
  const output=primary.map(h=>({...h}));
  for(const hit of supplement){
    const same=output.find(other=>{
      if(other.format!==hit.format)return false;
      const intersection=Math.max(0,Math.min(other.right,hit.right)-Math.max(other.left,hit.left))*Math.max(0,Math.min(other.bottom,hit.bottom)-Math.max(other.top,hit.top));
      return intersection/Math.max(1,Math.min((other.right-other.left)*(other.bottom-other.top),(hit.right-hit.left)*(hit.bottom-hit.top)))>.55;
    });
    if(!same)output.push(hit);
    else {
      if(same.value!==hit.value||hit.hasConflict)same.hasConflict=true;
      same.alternativeValues=[...new Set([...(same.alternativeValues||[]),...(hit.alternativeValues||[]),...(same.value!==hit.value?[hit.value]:[])])];
    }
  }
  return output;
}
