import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import {spawn,execFileSync} from 'node:child_process';
const repo=path.resolve(import.meta.dirname,'..'),real=process.argv.includes('--real'),coding=process.argv.includes('--coding'),resume=process.argv.includes('--resume');
const root=fs.mkdtempSync(path.join(os.homedir(),'Downloads/companion-agent-smoke-'));
fs.mkdirSync(path.join(root,'config'));fs.copyFileSync(path.join(repo,'config/persona.json'),path.join(root,'config/persona.json'));
let route=null;if(real){const {config}=await import('../src/config.js');route=config.upstreamProviders.primary.routes.chat;}
const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
const chunk=(name,data)=>{const n=Buffer.from(name),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([n,data])));return Buffer.concat([head,n,data,tail]);};
const w=256,h=128,pixels=Buffer.alloc(h*(w*3+1),255);for(let y=0;y<h;y++){pixels[y*(w*3+1)]=0;for(let x=0;x<w;x++){const c=x>20&&x<95&&y>25&&y<100?[240,20,20]:(x-185)**2+(y-64)**2<38**2?[20,40,240]:[255,255,255];for(let i=0;i<3;i++)pixels[y*(w*3+1)+1+x*3+i]=c[i];}}
const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const workspace=path.join(root,'project');fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace,'add.mjs'),'export const add=(a,b)=>a-b;\n');
fs.writeFileSync(path.join(workspace,'test.mjs'),"import {add} from './add.mjs';if(add(2,3)!==5)throw Error('expected five');console.log('TEST_PASSED');");
let image=path.join(root,'shapes.png');fs.writeFileSync(image,png);
if(process.argv.includes('--jpeg')){const jpeg=path.join(root,'shapes.jpeg');execFileSync('/usr/bin/sips',['-s','format','jpeg',image,'--out',jpeg],{stdio:'ignore'});image=jpeg;}
let sawImage=false,child,log='';const requestedTools=[];let killedForResume=false;
const proxy=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);for(const m of body.messages??[])for(const t of m.tool_calls??[])if(!requestedTools.includes(t.id))requestedTools.push(t.id);sawImage ||= (body.messages??[]).some(m=>Array.isArray(m.content)&&m.content.some(p=>p.image_url?.url?.match(/^data:image\/(?:png|jpeg);base64,/)));
  if(resume&&!killedForResume&&(body.messages??[]).some(m=>m.role==='tool'&&m.name==='apply_patch')){killedForResume=true;child.kill('SIGKILL');res.destroy();return;}
  if(real){try{body.model=route.model;const up=await fetch(route.baseUrl+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${route.apiKey}`},body:JSON.stringify(body),signal:AbortSignal.timeout(150000)});res.writeHead(up.status,{'content-type':up.headers.get('content-type')??'application/json'});res.end(Buffer.from(await up.arrayBuffer()));}catch{res.writeHead(502);res.end('{}');}}
  else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'左边是红色正方形，右边是蓝色圆形。'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));}
});
const listen=server=>new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server.address().port)));
try{
 const proxyPort=await listen(proxy),probe=http.createServer(),port=await listen(probe);await new Promise(r=>probe.close(r));
 const base=`http://127.0.0.1:${proxyPort}/v1`,key='disposable-agent-smoke-only';
 const env={PATH:process.env.PATH,HOME:os.homedir(),TMPDIR:os.tmpdir(),COMPANION_HOST:'127.0.0.1',COMPANION_PORT:String(port),COMPANION_API_KEY:key,COMPANION_ADMIN_KEY:key,DATABASE_PATH:path.join(root,'data/companion.db'),COMPANION_DEPLOYMENT_ROLE:'development-test',COMPANION_PRIMARY_LOCK_PATH:path.join(root,'data/primary.lock'),COMPANION_INSTANCE_ID:'agent-smoke-'+Date.now(),UPSTREAM_BASE_URL:base,UPSTREAM_CHAT_MODEL:'smoke',UPSTREAM_AGENT_MODEL:'smoke',UPSTREAM_SUMMARY_MODEL:'smoke',COMPANION_BLOCK_REAL_UPSTREAM:'1',EMBEDDING_ENABLED:'false',COMPANION_PROACTIVE_DISABLED:'1',COMPANION_AUTONOMOUS_LIFE_ENABLED:'0',COMPANION_NATURAL_DIARY_ENABLED:'false',COMPANION_REPLY_LATENCY_ENABLED:'0',COMPANION_NATURAL_PRESENCE_EVENT_LLM_ENABLED:'0',SUMMARY_EVERY_MESSAGES:'9999',COMPANION_CHAT_VOICE_MESSAGE_ENABLED:'0',COMPANION_MODALITY_VOICE_BIAS:'0',COMPANION_DEBUG_LOG:path.join(root,'debug.log')};
 child=spawn(process.execPath,[path.join(repo,'src/server.js')],{cwd:root,env,stdio:['ignore','pipe','pipe']});for(const pipe of [child.stdout,child.stderr])pipe.on('data',b=>{log=(log+b).slice(-20000);});
 for(let i=0;i<120;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 if(coding){
  const granted=await fetch(`http://127.0.0.1:${port}/admin/session-workspace`,{method:'PUT',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({source:'chat',external_key:'local-agent-vision-smoke',path:workspace})});
  const state=await granted.json();assert.equal(granted.status,200,JSON.stringify(state));
  const permitted=await fetch(`http://127.0.0.1:${port}/admin/sessions/${state.session_id}/permissions`,{method:'PATCH',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({mode:'full_autonomy'})});assert.equal(permitted.status,200);
 }
 let resumeTaskId=null;
 const send=()=>fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','x-companion-session':'local-agent-vision-smoke','x-companion-source':'chat'},body:JSON.stringify({model:'yuna-chat',metadata:resumeTaskId?{agentResumeTaskId:resumeTaskId}:{},messages:[{role:'user',content:resumeTaskId?'继续上次任务':coding?`修复当前授权项目 add.mjs 中加法函数的 bug。先看代码并运行 ${process.execPath} test.mjs，读取失败，然后修改，重新运行并读取成功结果再回复。`:`${image}\n请说出图片左右两边的形状和颜色。`}]}),signal:AbortSignal.timeout(600000)});
 let response;
 if(resume){
  try{await send();}catch{}assert.ok(killedForResume,'server killed after actual patch');
  const taskRoot=path.join(root,'data/agent-tasks'),owner=fs.readdirSync(taskRoot)[0];const file=fs.readdirSync(path.join(taskRoot,owner)).find(f=>f.endsWith('.json'));resumeTaskId=JSON.parse(fs.readFileSync(path.join(taskRoot,owner,file),'utf8')).id;
  child=spawn(process.execPath,[path.join(repo,'src/server.js')],{cwd:root,env,stdio:['ignore','pipe','pipe']});for(const pipe of [child.stdout,child.stderr])pipe.on('data',b=>{log=(log+b).slice(-20000);});
  for(let i=0;i<120;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 }
 response=await send();
 const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));if(!coding)assert.ok(sawImage,'actual upstream payload contains image bytes');
 const answer=(result.companion_bubbles??[result.choices?.[0]?.message?.content]).join(' ');if(!coding){assert.match(answer,/红|red/i);assert.match(answer,/蓝|blue/i);assert.match(answer,/圆|circle/i);}else{assert.ok(requestedTools.length>=5);assert.ok(fs.readFileSync(path.join(workspace,'add.mjs'),'utf8').includes('+'));}
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(root,'data/companion.db'),{readOnly:true});const rows=db.prepare('SELECT content_json,tool_calls_json FROM messages').all();assert.ok(rows.every(r=>!r.content_json.includes('data:image/')&&!r.content_json.includes(png.toString('base64'))));assert.ok(rows.every(r=>!String(r.tool_calls_json).includes('new_text')&&!String(r.tool_calls_json).includes('old_text')),'file edit bodies remain outside durable chat');db.close();
 const report={passed:true,mode:real?'real-model':'mock-provider',actualImagePayload:sawImage,coding,resume,killedForResume,toolCalls:requestedTools.length,durableBase64:false,answer};fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,artifact:path.join(root,'report.json')}));
}finally{child?.kill('SIGTERM');proxy.closeAllConnections();proxy.close();fs.writeFileSync(path.join(root,'server.log'),log);}
