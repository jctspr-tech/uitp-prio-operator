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
const manifest=JSON.parse(await readFile(resolve(root,'model-assets-1.5b.json'),'utf8'));
if(!/^model-assets\/[a-zA-Z0-9_./-]+$/u.test(manifest.staticDirectory)||manifest.staticDirectory.split('/').includes('..'))throw Error('Invalid model snapshot directory');
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
// WebLLM normalizes model roots to /resolve/<revision>/. Keep the
// mirrored snapshot at the same shape so all config/weight URLs resolve.
await Promise.all([0,1].map(async()=>{while(queue.length)await downloadAsset(queue.shift(),'dist/'+manifest.staticDirectory);}));
await downloadAsset(manifest.wasm,'dist/vendor');
// Small verified downloads are more reliable in embedded browsers and on slow
// connections than one 100+ MB request. The worker reconstructs the original
// byte stream before WebLLM caches it, without changing any model weights.
const chunkSize=8*1024*1024;
const weightIndex={version:1,revision:manifest.revision,files:{}};
for(const asset of manifest.assets.filter(a=>/^params_shard_\d+\.bin$/u.test(a.file))){
  const fileRecord={bytes:asset.bytes,sha256:asset.sha256,chunks:[]};
  const source=resolve(root,'dist',manifest.staticDirectory,asset.file);
  for(let offset=0,part=0;offset<asset.bytes;offset+=chunkSize,part++){
    const length=Math.min(chunkSize,asset.bytes-offset);
    const blocks=[];
    for await(const block of createReadStream(source,{start:offset,end:offset+length-1}))blocks.push(block);
    const bytes=Buffer.concat(blocks);
    if(bytes.length!==length)throw Error('Incomplete model chunk');
    const file=`chunks/${asset.file.slice(0,-4)}/part-${String(part).padStart(3,'0')}.bin`;
    const target=resolve(root,'dist',manifest.staticDirectory,file);
    await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes);
    fileRecord.chunks.push({file,bytes:length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  weightIndex.files[asset.file]=fileRecord;
}
await writeFile(resolve(root,'dist',manifest.staticDirectory,'weight-chunks.json'),JSON.stringify(weightIndex));
console.log('Verified model weight chunks prepared: '+Object.values(weightIndex.files).reduce((n,f)=>n+f.chunks.length,0));
console.log('Pinned WebLLM and model snapshot '+manifest.revision+' verified. Free static AI build ready.');
