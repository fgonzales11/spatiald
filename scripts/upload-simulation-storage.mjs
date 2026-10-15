import {readFile,writeFile} from 'node:fs/promises';
const origin=process.argv[2];if(!/^https:\/\//.test(origin||''))throw Error('Use the deployed HTTPS site origin.');
const directory=new URL('../.simulation-upload/',import.meta.url),manifest=JSON.parse(await readFile(new URL('manifest.json',directory)));
console.log('Ready for the import token on hidden stdin.');
if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
const token=await new Promise(resolve=>{let input='';const onData=chunk=>{input+=chunk;if(input.includes('\n')){process.stdin.off('data',onData);process.stdin.pause();if(process.stdin.isTTY)process.stdin.setRawMode(false);resolve(JSON.parse(input.split('\n')[0]).token);}};process.stdin.on('data',onData);process.stdin.resume();});
if(typeof token!=='string'||token.length<32)throw Error('Missing owner import token.');
const checkpointPath=new URL('progress.json',directory);let completed=new Set();try{const old=JSON.parse(await readFile(checkpointPath));if(old.revision===manifest.revision)completed=new Set(old.completed);}catch{}
const batches=[];let batch=[],bytes=0;
for(const entry of manifest.entries){if(batch.length>=70||bytes+entry.bytes>6*1024*1024){batches.push(batch);batch=[];bytes=0;}batch.push(entry);bytes+=entry.bytes;}if(batch.length)batches.push(batch);
let cursor=0,done=completed.size,last=0,checkpoint=Promise.resolve();
async function post(action,body){
 for(let attempt=0;attempt<4;attempt++){
  try{const response=await fetch(`${origin}/api/simulation-assets/${action}?revision=${manifest.revision}`,{method:'POST',headers:{authorization:`Bearer ${token}`},body,signal:AbortSignal.timeout(90000)});
   const result=await response.json();if(!response.ok){if([429,502,503,504].includes(response.status)&&attempt<3){await new Promise(r=>setTimeout(r,1000*2**attempt));continue;}throw Error(`Storage ${action} failed (${response.status}): ${result.error||'Unknown error'}`);}return result;
  }catch(error){if(attempt===3||!/fetch|timeout|network/i.test(error.message))throw error;await new Promise(r=>setTimeout(r,1000*2**attempt));}
 }
}
await Promise.all(Array.from({length:4},async()=>{while(cursor<batches.length){const id=cursor++,entries=batches[id];if(completed.has(id))continue;
 const header=Buffer.from(JSON.stringify(entries)),size=Buffer.alloc(4);size.writeUInt32LE(header.length);
 const data=await Promise.all(entries.map(e=>readFile(new URL(e.path,directory))));
 const result=await post('import',Buffer.concat([size,header,...data]));if(result.stored!==entries.length)throw Error('Incomplete batch acknowledgement');
 completed.add(id);done++;
 const progress=JSON.stringify({revision:manifest.revision,completed:[...completed]});checkpoint=checkpoint.then(()=>writeFile(checkpointPath,progress));await checkpoint;
 if(Date.now()-last>3000||done===batches.length){last=Date.now();console.log(`Circuit storage: ${done}/${batches.length} verified batches.`);}
}}));
const result=await post('complete',JSON.stringify({count:manifest.entries.length}));console.log(JSON.stringify({sealed:result.sealed,objects:result.count,revision:manifest.revision}));
