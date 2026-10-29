function timeout(promise,ms){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('촬영 응답 시간 초과')),ms);})]).finally(()=>clearTimeout(timer));}
function toBlob(canvas){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('사진 생성 실패')),'image/jpeg',.96));}
async function rotatePhoto(blob){
  let image,url;
  if(typeof createImageBitmap==='function')image=await createImageBitmap(blob);
  else{image=new Image();url=URL.createObjectURL(blob);image.src=url;await image.decode();}
  try{const width=image.width||image.naturalWidth,height=image.height||image.naturalHeight,c=document.createElement('canvas');c.width=height;c.height=width;const x=c.getContext('2d');x.translate(height,0);x.rotate(Math.PI/2);x.drawImage(image,0,0);return await toBlob(c);}
  finally{image.close?.();if(url)URL.revokeObjectURL(url);}
}
export async function captureCameraPhoto({stream,video,rotate=false}){
  const track=stream?.getVideoTracks()[0];let blob,mode='video-frame';
  if(track?.readyState==='live'&&typeof ImageCapture==='function'){
    try{
      const camera=new ImageCapture(track),caps=await timeout(camera.getPhotoCapabilities(),3000);
      const w=caps.imageWidth?.max,h=caps.imageHeight?.max;
      if(w>0&&h>0){
        const ratio=Math.min(1,4096/Math.max(w,h),Math.sqrt(12000000/(w*h)));
        const width=Math.round(w*ratio),height=Math.round(h*ratio);
        if(width>=(caps.imageWidth.min||1)&&height>=(caps.imageHeight.min||1)){
          blob=await timeout(camera.takePhoto({imageWidth:width,imageHeight:height}),15000);
          if(blob?.size)mode='still-photo';
        }
      }
    }catch{/* Camera API support differs; retain the existing video capture path. */}
  }
  if(!blob?.size){
    if(!video.videoWidth||!video.videoHeight)throw new Error('카메라 영상이 종료되었습니다. 다시 시작해 주세요.');
    const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;c.getContext('2d').drawImage(video,0,0);blob=await toBlob(c);
  }
  if(rotate)blob=await rotatePhoto(blob);
  return {blob,mode};
}
