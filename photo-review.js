export function photoHitState(hit){return hit.hasConflict?'conflict':hit.recognized!==false&&String(hit.value??'').trim()?'decoded':'unknown';}
export function photoMarker(hit,index,selected=false){
  const state=photoHitState(hit);
  return {state,color:selected?'#d92d20':state==='decoded'?'#12b76a':'#d97706',label:`${index+1} ${state==='decoded'?'✓':'?'}`};
}
export function rotatePhotoHit(hit,height){
  const rotateBounds=b=>[b.left,b.top,b.right,b.bottom].every(v=>v===0)?{...b}:{...b,left:height-b.bottom,top:b.left,right:height-b.top,bottom:b.right};
  const rotated=rotateBounds(hit);
  if(Array.isArray(hit.corners))rotated.corners=hit.corners.map(p=>({x:height-p.y,y:p.x}));
  if(Array.isArray(hit.locationBounds))rotated.locationBounds=hit.locationBounds.map(rotateBounds);
  return rotated;
}
