// Run expensive photo decodes one at a time while allowing new captures to queue.
export function createPhotoJobQueue(process, onChange=()=>{}) {
  const waiting=[];let current=null,draining=false;
  const count=()=>waiting.length+(current&&!current.job.cancelled?1:0);
  const notify=(phase,job,result)=>{try{onChange({phase,job,result,count:count()});}catch(error){console.error('Photo queue UI update failed',error);}};
  async function drain(){
    if(draining)return;draining=true;
    try{
      while(waiting.length){
        const entry=waiting.shift();current=entry;notify('started',entry.job);
        let result;
        try{result={ok:true,value:await process(entry.job)};}
        catch(error){result={ok:false,error};}
        current=null;notify('finished',entry.job,result);entry.resolve(result);
      }
    }finally{draining=false;notify('idle');}
  }
  return {
    get pendingCount(){return count();},
    has(id){return current?.job.photo.id===id&&!current.job.cancelled||waiting.some(entry=>entry.job.photo.id===id);},
    cancelWhere(predicate){
      if(current&&predicate(current.job)){current.job.cancelled=true;current.resolve({ok:false,cancelled:true});}
      for(let i=waiting.length-1;i>=0;i--)if(predicate(waiting[i].job)){const [entry]=waiting.splice(i,1);entry.job.cancelled=true;entry.resolve({ok:false,cancelled:true});}
      notify('cancelled');
    },
    enqueue(job){
      const existing=current?.job.photo.id===job.photo.id&&!current.job.cancelled?current:waiting.find(entry=>entry.job.photo.id===job.photo.id);
      if(existing)return existing.promise;
      let resolve;const promise=new Promise(done=>{resolve=done;});
      waiting.push({job,promise,resolve});notify('queued',job);void drain();return promise;
    }
  };
}
