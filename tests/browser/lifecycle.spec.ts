import { spawn, spawnSync } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { test, expect } from '@playwright/test';

test('interrupted acceptance cleans up its database, app, worker and subprocess group',async({},info)=>{
  test.skip(info.project.name!=='desktop'||process.platform==='win32');
  const program=`
    import { startAcceptance, execute } from './scripts/acceptance-environment.ts';
    const env=await startAcceptance();env.startWorker();
    console.log(JSON.stringify({container:env.container,directory:env.directory,origin:env.origin}));
    try{await execute(process.execPath,['-e',${JSON.stringify("const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('grandchild:'+child.pid);setInterval(()=>{},1000);")}],env.environment,text=>process.stdout.write(text));}
    catch{/* The signal intentionally interrupts this command. */}finally{await env.cleanup();}
  `;
  const child=spawn(process.execPath,['--import','./scripts/register-typescript.mjs','--input-type=module','-e',program],{stdio:['ignore','pipe','ignore']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});
  let owned:{container:string;directory:string;origin:string}|undefined;
  let descendant:number|undefined;
  try{
    await expect.poll(()=>output,{timeout:30000}).toContain('grandchild:');
    owned=JSON.parse(output.split('\n').find(line=>line.startsWith('{'))!);
    descendant=Number(output.match(/grandchild:(\d+)/)![1]);
    expect((await fetch(`${owned!.origin}/api/health`)).ok).toBe(true);
    await expect.poll(async()=>{
      try{return Boolean(JSON.parse(await readFile(`${owned!.directory}/worker-status.json`,'utf8')).lastSuccess);}
      catch{return false;}
    }).toBe(true);
    const closed=once(child,'close',{signal:AbortSignal.timeout(20000)});child.kill('SIGTERM');
    const [code]=await closed;expect(code).toBe(143);
    expect(spawnSync('docker',['inspect',owned!.container],{stdio:'ignore'}).status).not.toBe(0);
    await expect(access(owned!.directory)).rejects.toThrow();
    await expect(fetch(`${owned!.origin}/api/health`,{signal:AbortSignal.timeout(1000)})).rejects.toThrow();
    const state=spawnSync('ps',['-o','stat=','-p',String(descendant)],{encoding:'utf8'});
    expect(state.stdout.trim()===''||state.stdout.trim().startsWith('Z')).toBe(true);
  }finally{
    if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close',{signal:AbortSignal.timeout(20000)});child.kill('SIGTERM');await closed;}
    if(owned){
      spawnSync('docker',['rm','-fv',owned.container],{stdio:'ignore',timeout:30000});
      await rm(owned.directory,{recursive:true,force:true});
    }
    if(descendant){try{process.kill(descendant,'SIGTERM');}catch{/* Already stopped. */}}
  }
});
