import { WebWorkerMLCEngineHandler } from './vendor/webllm.js';
import { createWeightDownloader } from './weight-download.js?v=20261015-ai5';

// WebLLM's normal percentage starts only after its first config/WASM fetches.
// Report bounded asset phases without logging prompts, credentials, or raw exceptions.
const assetProgress = phase => self.postMessage({
  kind:'initProgressCallback',uuid:'',content:{progress:0,operatorPhase:phase}
});
const assetError = (phase,httpStatus,error,assetPath='',fetchStep='request') => {
  const allowedNames=['TimeoutError','AbortError','TypeError','NetworkError','SecurityError','QuotaExceededError','WeightManifestError','WeightIntegrityError','WeightHTTPError'];
  const errorName=allowedNames.includes(error?.name)?error.name:'Error';
  // This channel applies only to public runtime/model asset downloads, never model prompts.
  // Strip complete URLs/query strings and possible credentials from the short browser error.
  const message=typeof error?.message==='string'?error.message.replace(/https?:\/\/[^\s"']+/gu,'[asset-url]').replace(/\bsk-[\w-]+/gu,'[redacted]').replace(/Bearer\s+\S+/giu,'Bearer [redacted]').replace(/[\r\n]/gu,' ').slice(0,180):'';
  if(loading)self.postMessage({kind:'initProgressCallback',uuid:'',content:{progress:0,operatorPhase:'asset-error',assetType:phase,httpStatus:Number.isInteger(httpStatus)?httpStatus:0,errorName,assetPath,fetchStep,errorMessage:message}});
};
let loading=false,reloadId='';
const nativeFetch=self.fetch.bind(self);
const weightDownloader=createWeightDownloader({nativeFetch,baseUrl:self.location.href,onProgress:report=>{
  if(!loading)return;
  self.postMessage({kind:'initProgressCallback',uuid:'',content:{progress:0,operatorPhase:report.event==='retry'?'weight-retry':'weight-chunks',chunk:report.chunk,totalChunks:report.totalChunks,attempt:report.attempt,maxAttempts:report.maxAttempts}});
}});
self.fetch=async(resource,options={})=>{
  options=options??{};
  const url=typeof resource==='string'?resource:resource?.url||String(resource);
  let assetPath='';
  try {
    const pathname=new URL(url,self.location.href).pathname;
    if(/^\/(?:model-assets\/|vendor\/)[a-zA-Z0-9_./-]+$/u.test(pathname))assetPath=pathname.slice(0,180);
  }catch{}
  let phase='asset';
  if(url.includes('mlc-chat-config.json'))phase='config';
  else if(url.includes('.wasm'))phase='wasm';
  else if(url.includes('tokenizer'))phase='tokenizer';
  else if(url.includes('tensor')||url.includes('params_shard'))phase='weights';
  if(loading)assetProgress(phase);
  // Each model-asset request has a body-inclusive deadline. Retry only transient
  // request/network/5xx failures, never HTTP4xx or inference; partial body reads are not replayed.
  let response;
  const resourceSignal=typeof Request!=='undefined'&&resource instanceof Request?resource.signal:null;
  const externalSignal=options.signal||resourceSignal;
  try {response=await weightDownloader.fetch(resource,options);}
  catch(error){assetError(phase,Number(error?.status)||0,error,assetPath,'chunked');throw error;}
  if(!response)for(let attempt=0;attempt<3;attempt++){
    if(externalSignal?.aborted)throw new DOMException('Model asset loading canceled','AbortError');
    try {
      const deadline=AbortSignal.timeout(240_000);
      const signals=[externalSignal,deadline].filter(Boolean);
      response=await nativeFetch(resource,{...options,signal:AbortSignal.any(signals)});
      if(response.status>=500&&response.status<=599&&attempt<2){
        await response.body?.cancel();
        await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));continue;
      }
      break;
    }catch(error){
      const transient=error?.name==='TimeoutError'||error?.name==='NetworkError'||error?.name==='TypeError'&&/(?:fetch|network|load failed)/iu.test(error.message||'');
      if(transient&&!externalSignal?.aborted&&attempt<2){await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));continue;}
      assetError(phase,0,error,assetPath,'request');throw error;
    }
  }
  if(!response.ok){assetError(phase,response.status,null,assetPath,'http');return response;}
  if(!response.body)return response;
  // Stream through exactly once. This reports failures during body download without
  // cloning or buffering a second copy of the large model weight shards.
  const reader=response.body.getReader();
  const body=new ReadableStream({
    async pull(controller){
      try {const {done,value}=await reader.read();if(done)controller.close();else controller.enqueue(value);}
      catch(error){assetError(phase,response.status,error,assetPath,'body');controller.error(error);}
    },
    cancel(reason){return reader.cancel(reason);}
  });
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
};

const handler = new WebWorkerMLCEngineHandler();
const nativePost=handler.postMessage.bind(handler);
handler.postMessage=message=>{
  if(message.uuid===reloadId&&(message.kind==='return'||message.kind==='throw'))loading=false;
  nativePost(message);
};
self.onmessage = event => {
  if(event.data?.kind==='reload'){loading=true;reloadId=event.data.uuid;}
  handler.onmessage(event);
};
assetProgress('worker-ready');
