import { mkdir, writeFile, readFile } from 'node:fs/promises';
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
console.log('Pinned WebLLM 0.2.85 assets verified. Static AI build ready.');
