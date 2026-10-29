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
    // Crops constructed in JavaScript have plain width/height/data properties.
    // BarcodeDetector requires a real ImageData (or another CanvasImageSource).
    const input=typeof ImageData==='function' && !(image instanceof ImageData) && image?.data && image.width>0 && image.height>0
      ? new ImageData(image.data instanceof Uint8ClampedArray?image.data:new Uint8ClampedArray(image.data),image.width,image.height)
      : image;
    const found=await detector.detect(input);
    return found.filter(r=>typeof r.rawValue==='string'&&r.rawValue.length&&labels[r.format]).map(r=>{
      const b=r.boundingBox,corners=r.cornerPoints?.length===4?r.cornerPoints:[{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x+b.width,y:b.y+b.height},{x:b.x,y:b.y+b.height}];
      return {value:r.rawValue,format:labels[r.format],corners:corners.map(p=>({x:p.x,y:p.y})),left:Math.min(...corners.map(p=>p.x)),top:Math.min(...corners.map(p=>p.y)),right:Math.max(...corners.map(p=>p.x)),bottom:Math.max(...corners.map(p=>p.y)),engine:'browser-native'};
    }).filter(r=>[r.left,r.top,r.right,r.bottom].every(Number.isFinite)&&r.right>r.left&&r.bottom>r.top);
  }catch{return [];}
}

/** Keep readings and uncertainty independent from the rectangle chosen to draw. */
export function mergeHitMetadata(first,second={}){
  const readings=new Map(),bounds=new Map(),errors=new Set();
  for(const hit of [first,second]){
    const reported=[...(hit.locationReads||[])];
    if(typeof hit.value==='string'&&hit.value.length)reported.push({value:hit.value,format:hit.format,recognized:hit.hasConflict||hit.recognized!==false});
    for(const value of hit.alternativeValues||[])if(typeof value==='string'&&value.length)reported.push({value,format:hit.format});
    for(const reading of reported){
      if(typeof reading.value!=='string'||!reading.value.length)continue;
      const key=JSON.stringify([reading.format||hit.format,reading.value]),prior=readings.get(key);
      readings.set(key,{...reading,format:reading.format||hit.format,recognized:prior?.recognized===true||reading.recognized!==false});
    }
    for(const box of [...(hit.locationBounds||[]),hit]){
      if(![box.left,box.top,box.right,box.bottom].every(Number.isFinite))continue;
      const rect={left:box.left,top:box.top,right:box.right,bottom:box.bottom};bounds.set(JSON.stringify(rect),rect);
    }
    for(const error of hit.decodeErrors||[])errors.add(String(error));
  }
  const locationReads=[...readings.values()],validValues=[...new Set(locationReads.filter(reading=>reading.recognized).map(reading=>reading.value))];
  const hasConflict=!!(first.hasConflict||second.hasConflict||validValues.length>1);
  return {locationReads,locationBounds:[...bounds.values()],alternativeValues:validValues.filter(value=>value!==first.value),hasConflict,recognized:!hasConflict&&validValues.length>0,...(errors.size?{decodeErrors:[...errors]}:{})};
}

export function combineEngineHits(primary,supplement){
  const output=primary.map(h=>({...h}));
  for(const hit of supplement){
    const same=output.find(other=>{
      if(other.format!==hit.format)return false;
      const intersection=Math.max(0,Math.min(other.right,hit.right)-Math.max(other.left,hit.left))*Math.max(0,Math.min(other.bottom,hit.bottom)-Math.max(other.top,hit.top));
      return intersection/Math.max(1,Math.min((other.right-other.left)*(other.bottom-other.top),(hit.right-hit.left)*(hit.bottom-hit.top)))>.55;
    });
    if(!same)output.push({...hit,...mergeHitMetadata(hit)});
    else {
      const metadata=mergeHitMetadata(same,hit);
      // An unread candidate is evidence about location, not a disagreeing value.
      // A later valid decode replaces it while every observation stays available.
      if((same.recognized===false||!same.value)&&!same.hasConflict&&hit.recognized!==false&&hit.value)Object.assign(same,hit);
      Object.assign(same,metadata);
      same.alternativeValues=metadata.alternativeValues.filter(value=>value!==same.value);
    }
  }
  return output;
}
