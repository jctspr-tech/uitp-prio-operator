import { WebWorkerMLCEngineHandler } from './vendor/webllm.js';

// WebLLM's normal percentage starts only after its first config/WASM fetches.
// Report bounded asset phases without logging prompts, credentials, or raw exceptions.
const assetProgress = phase => self.postMessage({
  kind:'initProgressCallback',uuid:'',content:{progress:0,operatorPhase:phase}
});
const assetError = (phase,httpStatus,error) => {
  const allowedNames=['TimeoutError','AbortError','TypeError','NetworkError','SecurityError','QuotaExceededError'];
  const errorName=allowedNames.includes(error?.name)?error.name:'Error';
  if(loading)self.postMessage({kind:'initProgressCallback',uuid:'',content:{progress:0,operatorPhase:'asset-error',assetType:phase,httpStatus:Number.isInteger(httpStatus)?httpStatus:0,errorName}});
};
let loading=false,reloadId='';
const nativeFetch=self.fetch.bind(self);
self.fetch=async(resource,options={})=>{
  const url=typeof resource==='string'?resource:resource?.url||String(resource);
  let phase='asset';
  if(url.includes('mlc-chat-config.json'))phase='config';
  else if(url.includes('.wasm'))phase='wasm';
  else if(url.includes('tokenizer'))phase='tokenizer';
  else if(url.includes('tensor')||url.includes('params_shard'))phase='weights';
  if(loading)assetProgress(phase);
  // Keep timeout active while the response body is read by the artifact cache.
  const deadline=AbortSignal.timeout(90_000);
  const signals=[options.signal||(resource instanceof Request?resource.signal:null),deadline].filter(Boolean);
  let response;
  try {response=await nativeFetch(resource,{...options,signal:AbortSignal.any(signals)});}
  catch(error){assetError(phase,0,error);throw error;}
  if(!response.ok){assetError(phase,response.status,null);return response;}
  if(!response.body)return response;
  // Stream through exactly once. This reports failures during body download without
  // cloning or buffering a second copy of the large model weight shards.
  const reader=response.body.getReader();
  const body=new ReadableStream({
    async pull(controller){
      try {const {done,value}=await reader.read();if(done)controller.close();else controller.enqueue(value);}
      catch(error){assetError(phase,response.status,error);controller.error(error);}
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
