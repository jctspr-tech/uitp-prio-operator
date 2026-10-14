import { mkdir, writeFile, readFile, stat, rename, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root=dirname(fileURLToPath(import.meta.url));
const assets=[
  ['webllm.js','lib/index.js','341bae95822bfee1d0fd6a0e6cd2db8613bb8edf809390ac142fba36ec17792c'],
  ['webllm-LICENSE','LICENSE','d412ab9d5ac17e6931705aac01e5a0d323da5acd2e89a2c19aa8fc05becc59ad'],
];
await mkdir(resolve(root,'dist/vendor'),{recursive:true});
for(const [name,path,hash] of assets){
  const target=resolve(root,'dist/vendor',name);
  let bytes;try{bytes=await readFile(target);}catch{}
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==hash){
    const response=await fetch(`https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/${path}`,{signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw Error('WebLLM download failed: '+response.status);
    bytes=Buffer.from(await response.arrayBuffer());
    if(createHash('sha256').update(bytes).digest('hex')!==hash)throw Error('WebLLM integrity check failed');
    await writeFile(target,bytes);
  }
}
const manifest=JSON.parse(await readFile(resolve(root,'model-assets.json'),'utf8'));
async function verified(target,hash,bytes){
  try{
    if(bytes!==undefined&&(await stat(target)).size!==bytes)return false;
    const h=createHash('sha256');for await(const chunk of createReadStream(target))h.update(chunk);
    return h.digest('hex')===hash;
  }catch{return false;}
}
async function downloadAsset(asset,folder){
  if(!/^[a-zA-Z0-9_.-]+$/.test(asset.file))throw Error('Invalid asset path');
  const target=resolve(root,folder,asset.file),temp=target+'.download';
  await mkdir(dirname(target),{recursive:true});
  if(await verified(target,asset.sha256,asset.bytes))return;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const url=new URL(asset.url);
      if(attempt)url.searchParams.set('build_retry',`${Date.now()}-${attempt}`);
      const response=await fetch(url,{signal:AbortSignal.timeout(180000)});
      if(!response.ok||response.status===206)throw Error('Asset HTTP '+response.status);
      const hash=createHash('sha256');let length=0;
      const checker=new Transform({transform(chunk,encoding,callback){
        length+=chunk.length;
        if(length>asset.bytes)return callback(Error('Oversized asset'));
        hash.update(chunk);callback(null,chunk);
      }});
      await pipeline(Readable.fromWeb(response.body),checker,createWriteStream(temp));
      if(length!==asset.bytes||hash.digest('hex')!==asset.sha256)throw Error('Asset integrity check failed');
      await rename(temp,target);console.log('Verified model asset '+asset.file);return;
    }catch(error){
      await unlink(temp).catch(()=>{});
      if(attempt===2)throw Error('Cannot prepare verified model asset '+asset.file+' ('+error.name+')');
    }
  }
}
const queue=[...manifest.assets];
await Promise.all([0,1].map(async()=>{while(queue.length)await downloadAsset(queue.shift(),'dist/model-assets');}));
await downloadAsset(manifest.wasm,'dist/vendor');
console.log('Pinned WebLLM and model snapshot '+manifest.revision+' verified. Free static AI build ready.');
