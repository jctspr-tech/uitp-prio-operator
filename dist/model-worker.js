import { WebWorkerMLCEngineHandler } from './vendor/webllm.js';

// WebLLM's normal percentage starts only after its first config/WASM fetches.
// Report bounded asset phases without logging prompts, credentials, or raw exceptions.
const assetProgress = phase => self.postMessage({
  kind:'initProgressCallback',uuid:'',content:{progress:0,operatorPhase:phase}
});
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
  return nativeFetch(resource,{...options,signal:AbortSignal.any(signals)});
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
