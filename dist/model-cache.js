// Install an exact pinned local model package into WebLLM's browser cache.
// Selected file bytes stay local. Only a fixed, same-origin manifest is fetched.
const MAGIC='UITPMDL1';
const HEADER_LIMIT=64*1024;
const ASSET_LIMIT=128*1024*1024;
const MAX_ASSETS=64;
const CACHE_NAMES=['config','model','wasm'];
const TYPES=['arraybuffer','json'];
const SHA=/^[a-f0-9]{64}$/u;
const REVISION=/^[a-f0-9]{40}$/u;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,names)=>object(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));

export class ModelPackageError extends Error {
  constructor(code,message){super(message);this.name='ModelPackageError';this.code=code;}
}
const invalid=()=>new ModelPackageError('MODEL_PACKAGE_INVALID','Этот файл не является пакетом установленной на сайте модели. Выберите подготовленный пакет УИТП.');
const corrupt=()=>new ModelPackageError('MODEL_PACKAGE_CORRUPT','Пакет модели повреждён или не совпадает с проверенным снимком. Импорт остановлен; скачайте пакет заново.');
const canceled=()=>new ModelPackageError('MODEL_PACKAGE_CANCELED','Импорт модели отменён. Уже проверенные файлы остаются в локальном кэше.');
const cacheError=()=>new ModelPackageError('MODEL_CACHE_IMPORT_FAILED','Браузер не смог сохранить модель. Проверьте свободное место и разрешение локального хранилища, затем повторите импорт.');
const checkAbort=signal=>{if(signal?.aborted)throw canceled();};
const hex=buffer=>[...new Uint8Array(buffer)].map(b=>b.toString(16).padStart(2,'0')).join('');

export function validatePackageManifest(value,baseUrl){
  if(!keys(value,['format','model','revision','assets'])||value.format!=='uitp-model-v1'
    ||typeof value.model!=='string'||!/^[a-zA-Z0-9_.-]{3,120}$/u.test(value.model)
    ||typeof value.revision!=='string'||!REVISION.test(value.revision)
    ||!Array.isArray(value.assets)||!value.assets.length||value.assets.length>MAX_ASSETS)throw invalid();
  const origin=new URL(baseUrl).origin,paths=new Set();let bytes=0;
  for(const asset of value.assets){
    if(!keys(asset,['file','cache','type','bytes','sha256','path'])
      ||typeof asset.file!=='string'||!/^[-a-zA-Z0-9_.]{1,120}$/u.test(asset.file)||asset.file.startsWith('.')
      ||!CACHE_NAMES.includes(asset.cache)||!TYPES.includes(asset.type)
      ||!Number.isSafeInteger(asset.bytes)||asset.bytes<1||asset.bytes>ASSET_LIMIT
      ||typeof asset.sha256!=='string'||!SHA.test(asset.sha256)||typeof asset.path!=='string'
      ||!/^(?:\.\/)?(?:model-assets|vendor)\/[a-zA-Z0-9_./-]+$/u.test(asset.path)
      ||asset.path.length>300||asset.path.includes('\\')||asset.path.includes('%')||asset.path.includes('?')||asset.path.includes('#')
      ||asset.path.split('/').some(p=>p==='..'))throw invalid();
    const url=new URL(asset.path,baseUrl);
    if(url.origin!==origin||url.username||url.password||url.search||url.hash
      ||!/^\/(?:model-assets|vendor)\//u.test(url.pathname)||!url.pathname.endsWith('/'+asset.file)
      ||paths.has(url.href))throw invalid();
    if(asset.type==='json'&&asset.bytes>1024*1024)throw invalid();
    paths.add(url.href);bytes+=asset.bytes;
  }
  if(!Number.isSafeInteger(bytes)||bytes>2*1024*1024*1024)throw invalid();
  return value;
}

function sameManifest(header,pinned){
  if(header.format!==pinned.format||header.model!==pinned.model||header.revision!==pinned.revision||header.assets.length!==pinned.assets.length)return false;
  const fields=['file','cache','type','bytes','sha256','path'];
  return header.assets.every((asset,index)=>fields.every(field=>asset[field]===pinned.assets[index][field]));
}

function readSlice(file,start,end,signal,Reader){
  checkAbort(signal);
  return new Promise((resolve,reject)=>{
    const reader=new Reader();let settled=false;
    const finish=(error,result)=>{
      if(settled)return;settled=true;signal?.removeEventListener('abort',abort);
      reader.onload=null;reader.onerror=null;reader.onabort=null;
      if(error)reject(error);else resolve(result);
    };
    const abort=()=>{try{reader.abort();}catch{}finish(canceled());};
    signal?.addEventListener('abort',abort,{once:true});
    reader.onload=()=>{
      if(signal?.aborted)return finish(canceled());
      const result=reader.result;
      if(!(result instanceof ArrayBuffer)||result.byteLength!==end-start)return finish(corrupt());
      finish(null,result);
    };
    reader.onerror=()=>finish(corrupt());reader.onabort=()=>finish(canceled());
    try{reader.readAsArrayBuffer(file.slice(start,end));}catch{finish(invalid());}
  });
}

function openCache(indexedDB,name,signal){
  checkAbort(signal);
  return new Promise((resolve,reject)=>{
    let request,settled=false;
    const fail=error=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);reject(error);};
    const abort=()=>fail(canceled());
    signal?.addEventListener('abort',abort,{once:true});
    try{request=indexedDB.open('webllm/'+name,1);}catch{return fail(cacheError());}
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('urls'))db.createObjectStore('urls',{keyPath:'url'});
    };
    request.onerror=()=>fail(cacheError());request.onblocked=()=>fail(cacheError());
    request.onsuccess=()=>{
      const db=request.result;
      if(settled){db.close();return;}
      if(signal?.aborted){db.close();return fail(canceled());}
      if(!db.objectStoreNames.contains('urls')){db.close();return fail(cacheError());}
      settled=true;signal?.removeEventListener('abort',abort);
      resolve(db);
    };
  });
}

function writeCache(db,url,data,signal){
  checkAbort(signal);
  return new Promise((resolve,reject)=>{
    let transaction,settled=false;
    const finish=error=>{
      if(settled)return;settled=true;signal?.removeEventListener('abort',abort);
      if(error)reject(error);else resolve();
    };
    const abort=()=>{try{transaction?.abort();}catch{}finish(canceled());};
    signal?.addEventListener('abort',abort,{once:true});
    try{
      transaction=db.transaction(['urls'],'readwrite');
      transaction.oncomplete=()=>finish(signal?.aborted?canceled():null);
      transaction.onerror=()=>finish(cacheError());transaction.onabort=()=>finish(signal?.aborted?canceled():cacheError());
      transaction.objectStore('urls').put({url,data});
    }catch{finish(cacheError());}
  });
}

export function createModelCacheImporter({fetchImpl=globalThis.fetch?.bind(globalThis),indexedDBImpl=globalThis.indexedDB,cryptoImpl=globalThis.crypto,FileReaderImpl=globalThis.FileReader,baseUrl=globalThis.location?.href,manifestUrl=new URL('./model-cache-manifest.json',import.meta.url).href}={}){
  let importing=false;
  async function importModelPackage(file,{onProgress,signal}={}){
    if(importing)throw new ModelPackageError('MODEL_PACKAGE_BUSY','Другой пакет уже импортируется. Дождитесь завершения или отмените его.');
    if(!file||!Number.isSafeInteger(file.size)||file.size<13||typeof file.slice!=='function')throw invalid();
    if(!baseUrl||typeof fetchImpl!=='function'||!indexedDBImpl||typeof FileReaderImpl!=='function'||!cryptoImpl?.subtle)throw cacheError();
    const fixedUrl=new URL(manifestUrl,baseUrl);
    if(fixedUrl.origin!==new URL(baseUrl).origin)throw invalid();
    importing=true;const connections=new Map();
    const notify=value=>{try{onProgress?.(value);}catch{/* UI progress cannot change verified cache bytes. */}};
    let totalBytes=0,loadedBytes=0,completedAssets=0;
    try{
      checkAbort(signal);
      notify({phase:'validating',progress:0,text:'Проверяем локальный пакет модели. Файл никуда не отправляется.',completedAssets:0,totalAssets:0,loadedBytes:0,totalBytes:0});
      const deadline=AbortSignal.timeout(30_000),fetchSignal=signal?AbortSignal.any([signal,deadline]):deadline;
      let response;
      try{response=await fetchImpl(fixedUrl.href,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',signal:fetchSignal});}
      catch{checkAbort(signal);throw new ModelPackageError('MODEL_PACKAGE_MANIFEST_UNAVAILABLE','Не удалось получить проверенный список файлов модели. Проверьте соединение с сайтом и повторите импорт.');}
      if(!response.ok)throw new ModelPackageError('MODEL_PACKAGE_MANIFEST_UNAVAILABLE','На сайте недоступен проверенный список файлов модели. Импорт не начат.');
      const manifestText=await response.text();
      if(new TextEncoder().encode(manifestText).length>HEADER_LIMIT)throw invalid();
      let pinned;try{pinned=JSON.parse(manifestText);}catch{throw invalid();}
      validatePackageManifest(pinned,baseUrl);
      const prefix=await readSlice(file,0,12,signal,FileReaderImpl);
      if(new TextDecoder().decode(new Uint8Array(prefix,0,8))!==MAGIC)throw invalid();
      const headerLength=new DataView(prefix).getUint32(8,true);
      if(headerLength<2||headerLength>HEADER_LIMIT||12+headerLength>file.size)throw invalid();
      let header;
      try{header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readSlice(file,12,12+headerLength,signal,FileReaderImpl)));}catch(error){if(error instanceof ModelPackageError)throw error;throw invalid();}
      validatePackageManifest(header,baseUrl);
      if(!sameManifest(header,pinned))throw invalid();
      totalBytes=pinned.assets.reduce((n,asset)=>n+asset.bytes,0);
      if(file.size!==12+headerLength+totalBytes)throw corrupt();
      let offset=12+headerLength;
      for(const asset of pinned.assets){
        checkAbort(signal);
        const bytes=await readSlice(file,offset,offset+asset.bytes,signal,FileReaderImpl);
        const checksum=hex(await cryptoImpl.subtle.digest('SHA-256',bytes));
        checkAbort(signal);if(checksum!==asset.sha256)throw corrupt();
        let data=bytes;
        if(asset.type==='json'){
          try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw corrupt();}
          if(!object(data))throw corrupt();
        }
        if(!connections.has(asset.cache))connections.set(asset.cache,await openCache(indexedDBImpl,asset.cache,signal));
        await writeCache(connections.get(asset.cache),new URL(asset.path,baseUrl).href,data,signal);
        offset+=asset.bytes;loadedBytes+=asset.bytes;completedAssets++;
        notify({phase:'installing',completedAssets,totalAssets:pinned.assets.length,loadedBytes,totalBytes,progress:loadedBytes/totalBytes,text:`Проверено и сохранено файлов модели: ${completedAssets} из ${pinned.assets.length}.`});
      }
      checkAbort(signal);
      notify({phase:'complete',completedAssets,totalAssets:pinned.assets.length,loadedBytes,totalBytes,progress:1,text:'Модель сохранена на этом устройстве. Теперь можно подготовить ответ.'});
      return {model:pinned.model,revision:pinned.revision,installedAssets:completedAssets,totalBytes};
    }catch(error){
      if(signal?.aborted)throw canceled();
      if(error instanceof ModelPackageError)throw error;
      throw cacheError();
    }finally{
      for(const db of connections.values()){try{db.close();}catch{}}
      importing=false;
    }
  }
  return Object.freeze({importModelPackage});
}

let defaultImporter;
export async function importModelPackage(file,options={}){
  defaultImporter??=createModelCacheImporter();
  return defaultImporter.importModelPackage(file,options);
}
