// Large virtual weight shards are assembled from small, independently verified files.
// No Range requests, inference prompts, credentials or API services are involved.
export const WEIGHT_CHUNK_MAX_BYTES=8*1024*1024;
export const WEIGHT_CHUNK_TIMEOUT_MS=240_000;
const MAX_FILE_BYTES=512*1024*1024;
const SHA=/^[a-f0-9]{64}$/iu;
const FILE=/^params_shard_(0|[1-9]\d{0,2})\.bin$/u;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,names)=>record(value)&&Object.keys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k));
const invalid=message=>Object.assign(new Error(message),{name:'WeightManifestError'});
const integrity=message=>Object.assign(new Error(message),{name:'WeightIntegrityError'});
const aborted=signal=>{if(signal?.aborted)throw signal.reason||new DOMException('Weight download canceled','AbortError');};
const mergeSignals=signals=>{const present=signals.filter(Boolean);return present.length===1?present[0]:present.length?AbortSignal.any(present):undefined;};
const hex=bytes=>[...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');

export function validateWeightManifest(value){
  if(!keys(value,['version','revision','files'])||value.version!==1||typeof value.revision!=='string'||!/^[a-f0-9]{40}$/iu.test(value.revision)||!record(value.files))throw invalid('Invalid weight chunk manifest.');
  const entries=Object.entries(value.files);
  if(!entries.length||entries.length>32)throw invalid('Invalid number of weight files.');
  for(const[file,meta]of entries){
    const match=FILE.exec(file);
    if(!match||!keys(meta,['bytes','sha256','chunks'])||!Number.isSafeInteger(meta.bytes)||meta.bytes<1||meta.bytes>MAX_FILE_BYTES||typeof meta.sha256!=='string'||!SHA.test(meta.sha256)||!Array.isArray(meta.chunks)||!meta.chunks.length||meta.chunks.length>128)throw invalid('Invalid weight file metadata.');
    let total=0;
    for(const[part,chunk]of meta.chunks.entries()){
      const expected=`chunks/params_shard_${match[1]}/part-${String(part).padStart(3,'0')}.bin`;
      if(!keys(chunk,['file','bytes','sha256'])||chunk.file!==expected||!Number.isSafeInteger(chunk.bytes)||chunk.bytes<1||chunk.bytes>WEIGHT_CHUNK_MAX_BYTES||typeof chunk.sha256!=='string'||!SHA.test(chunk.sha256))throw invalid('Invalid weight chunk path, length or checksum.');
      total+=chunk.bytes;
    }
    if(total!==meta.bytes)throw invalid('Weight chunk lengths do not match the virtual file.');
  }
  return value;
}

async function readBounded(response,expectedBytes,signal){
  aborted(signal);
  const header=response.headers.get('content-length');
  if(header!==null&&/^\d+$/u.test(header)&&Number(header)>expectedBytes){try{await response.body?.cancel();}catch{}throw integrity('Weight response exceeds its expected length.');}
  if(!response.body)throw integrity('Weight response has no body.');
  const reader=response.body.getReader(),result=new Uint8Array(expectedBytes);let count=0;
  try{
    while(true){
      aborted(signal);const{value,done}=await reader.read();if(done)break;
      if(!(value instanceof Uint8Array)||count+value.byteLength>expectedBytes)throw integrity('Weight response exceeds its expected length.');
      result.set(value,count);count+=value.byteLength;
    }
    aborted(signal);
    if(count!==expectedBytes)throw integrity('Weight response is truncated.');
    return result;
  }catch(error){try{await reader.cancel(error);}catch{}throw error;}
  finally{reader.releaseLock();}
}

// One factory instance belongs to one worker. The in-flight manifest is shared;
// a failed/canceled lookup is evicted so the next request can retry cleanly.
export function createWeightDownloader({nativeFetch=globalThis.fetch.bind(globalThis),baseUrl=globalThis.location?.href,onProgress,chunkTimeoutMs=WEIGHT_CHUNK_TIMEOUT_MS,maxAttempts=3,cryptoProvider=globalThis.crypto}={}){
  if(typeof nativeFetch!=='function'||!baseUrl||!Number.isFinite(chunkTimeoutMs)||chunkTimeoutMs<=0||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>3)throw invalid('Invalid weight downloader configuration.');
  const origin=new URL(baseUrl).origin,indexCache=new Map();
  const notify=value=>{try{onProgress?.(value);}catch{/* UI progress cannot corrupt verified bytes. */}};
  const fetchAsset=async(url,signal,accept,cache='no-store')=>{
    const combined=mergeSignals([signal,AbortSignal.timeout(chunkTimeoutMs)]);
    aborted(combined);
    // Deliberately do not propagate arbitrary headers or Range from the caller.
    const response=await nativeFetch(url.href,{method:'GET',signal:combined,cache,credentials:'same-origin',redirect:'error',headers:{Accept:accept}});
    return{response,signal:combined};
  };
  const retryable=error=>error?.name==='TypeError'||error?.name==='NetworkError'||error?.name==='TimeoutError'||error?.name==='AbortError'||error?.name==='WeightIntegrityError'||error?.retryable===true;
  async function withRetry(action,signal,label){
    for(let attempt=1;attempt<=maxAttempts;attempt++){
      aborted(signal);
      try{return await action(attempt);}
      catch(error){
        aborted(signal);
        if(attempt===maxAttempts||!retryable(error))throw error;
        notify({phase:'weights',event:'retry',file:label,attempt:attempt+1,maxAttempts});
      }
    }
  }
  async function loadIndex(url,signal){
    const key=url.href;
    if(!indexCache.has(key)){
      const pending=withRetry(async()=>{
        const{response,signal:combined}=await fetchAsset(url,signal,'application/json');
        if(response.status===404){try{await response.body?.cancel();}catch{}return null;}
        if(!response.ok){try{await response.body?.cancel();}catch{}throw Object.assign(new Error('Weight manifest HTTP '+response.status),{name:'WeightHTTPError',status:response.status,retryable:response.status>=500&&response.status<=599});}
        // A manifest is small; an oversized response never enters JSON parsing.
        const declared=response.headers.get('content-length');
        if(declared!==null&&/^\d+$/u.test(declared)&&Number(declared)>256*1024)throw invalid('Weight manifest is too large.');
        const reader=response.body?.getReader();if(!reader)throw invalid('Weight manifest has no body.');
        const chunks=[];let size=0;
        try{while(true){aborted(combined);const{value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>256*1024)throw invalid('Weight manifest is too large.');chunks.push(value);}}
        catch(error){try{await reader.cancel(error);}catch{}throw error;}
        finally{reader.releaseLock();}
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
        let value;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{throw invalid('Weight manifest is not valid JSON.');}
        return validateWeightManifest(value);
      },signal,'weight-chunks.json');
      indexCache.set(key,pending);
      pending.catch(()=>{if(indexCache.get(key)===pending)indexCache.delete(key);});
    }
    return indexCache.get(key);
  }
  async function fetchWeight(resource,options={}){
    options=options??{};
    const request=typeof Request!=='undefined'&&resource instanceof Request?resource:null;
    let url;try{url=new URL(typeof resource==='string'||resource instanceof URL?resource:resource?.url||String(resource),baseUrl);}catch{return null;}
    if(url.origin!==origin||!FILE.test(url.pathname.split('/').at(-1))||(options.method||request?.method||'GET').toUpperCase()!=='GET')return null;
    const external=mergeSignals([options.signal,request?.signal]);aborted(external);
    const indexUrl=new URL('./weight-chunks.json',url),manifest=await loadIndex(indexUrl,external);aborted(external);
    if(manifest===null)return null;
    const file=url.pathname.split('/').at(-1),meta=manifest.files[file];
    if(!meta)throw invalid('Requested weight file is absent from the chunk manifest.');
    const canceled=new AbortController(),signal=mergeSignals([external,canceled.signal]);let part=0,loaded=0;
    const body=new ReadableStream({
      async pull(controller){
        try{
          aborted(signal);
          if(part===meta.chunks.length){if(loaded!==meta.bytes)throw integrity('Assembled weight length is incorrect.');controller.close();return;}
          const chunk=meta.chunks[part],chunkUrl=new URL(chunk.file,indexUrl);
          if(chunkUrl.origin!==origin||!chunkUrl.pathname.startsWith(new URL('./chunks/',indexUrl).pathname))throw invalid('Weight chunk escaped the model directory.');
          const bytes=await withRetry(async attempt=>{
            // Immutable revision/path + checksum permit cache reuse after an
            // interrupted startup. Retries bypass/refresh a possibly bad entry.
            const{response,signal:combined}=await fetchAsset(chunkUrl,signal,'application/octet-stream',attempt===1?'force-cache':'reload');
            if(!response.ok){try{await response.body?.cancel();}catch{}throw Object.assign(new Error('Weight chunk HTTP '+response.status),{name:'WeightHTTPError',status:response.status,retryable:response.status>=500&&response.status<=599});}
            const data=await readBounded(response,chunk.bytes,combined);
            if(!cryptoProvider?.subtle)throw invalid('Checksum verification is unavailable.');
            const hash=hex(await cryptoProvider.subtle.digest('SHA-256',data));aborted(combined);
            if(hash!==chunk.sha256.toLowerCase())throw integrity('Weight chunk checksum mismatch.');
            return data;
          },signal,chunk.file);
          aborted(signal);loaded+=bytes.byteLength;part++;
          notify({phase:'weights',event:'verified',file,chunk:part,totalChunks:meta.chunks.length,loadedBytes:loaded,totalBytes:meta.bytes});
          controller.enqueue(bytes);
        }catch(error){controller.error(error);}
      },
      cancel(reason){canceled.abort(reason||new DOMException('Weight response canceled','AbortError'));}
    });
    return new Response(body,{status:200,headers:{'Content-Type':'application/octet-stream','Content-Length':String(meta.bytes),'X-Weight-Chunked':'1','X-Weight-SHA256':meta.sha256.toLowerCase()}});
  }
  return Object.freeze({fetch:fetchWeight});
}

let defaultDownloader;
export async function fetchChunkedWeight(resource,options={},dependencies={}){
  if(Object.keys(dependencies).length)return createWeightDownloader(dependencies).fetch(resource,options);
  defaultDownloader??=createWeightDownloader();
  return defaultDownloader.fetch(resource,options);
}
