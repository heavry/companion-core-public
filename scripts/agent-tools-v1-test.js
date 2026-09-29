import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-tools-v1-'));
process.env.DATABASE_PATH=path.join(root,'data/companion.db');process.env.COMPANION_INVOCATION_LEDGER_PATH=path.join(root,'data/ledger.jsonl');process.env.COMPANION_LOCAL_RUNTIME_CONTROLS_PATH=path.join(root,'data/controls.json');
const {AgentToolsV1,agentV1Context}=await import('../src/agent-tools-v1.js');
const {LocalAgentRuntime}=await import('../src/local-agent-runtime.js');
const {runNativeAgent}=await import('../src/native-agent-runtime.js');
const {createAgentLifecycle}=await import('../src/agent-lifecycle.js');
const {SessionPermissionStore}=await import('../src/session-permissions.js');
const workspace=path.join(root,'project');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'add.mjs'),'export const add=(a,b)=>a-b;\n');
fs.writeFileSync(path.join(workspace,'test.mjs'),"import {add} from './add.mjs'; if(add(2,3)!==5)throw Error('expected five'); console.log('TEST_PASSED');");
const controls={enabled:()=>true,assertEnabled:()=>{},onChange:()=>{}};
const runtime=new AgentToolsV1({artifactRoot:path.join(root,'artifacts'),localRuntime:new LocalAgentRuntime({controls})});
const context=agentV1Context([{role:'user',content:'修复项目代码并测试'}],{workspaceRoot:workspace});
const opts={workspaceRoot:workspace,sessionId:'test',paths:[]};
const run=(name,args)=>runtime.execute(name,args,opts);
const permission=new SessionPermissionStore({filePath:path.join(root,'permissions.json')});permission.setMode('test','full_autonomy');
let commandId,stage=0;
const actions=[['list_directory',{path:'.',depth:1}],['search_files',{query:'add',path:'.'}],['read_file',{path:'add.mjs'}],['apply_patch',{path:'add.mjs',changes:[{old_text:'does not exist',new_text:'x'}]}],['apply_patch',{path:'add.mjs',changes:[{old_text:'a-b',new_text:'a*b'}]}],['run_command',{command:`${process.execPath} test.mjs`}],['read_command_output',()=>({process_id:commandId})],['apply_patch',{path:'add.mjs',changes:[{old_text:'a*b',new_text:'a+b'}]}],['run_command',{command:`${process.execPath} test.mjs`}],['read_command_output',()=>({process_id:commandId})]];
try{
 const result=await runNativeAgent({messages:[{role:'user',content:'fix add'}],tools:context.tools,capabilities:context.capabilities,lifecycle:createAgentLifecycle(),permissionStore:permission,sessionId:'test',maxSteps:16,callModel:async({messages})=>{
  if(stage===4)assert.ok(messages.at(-1).content.includes('FS_PATCH_PRECONDITION_FAILED'),'tool errors feed back into reasoning');
  if(stage===7)assert.ok(messages.at(-1).content.includes('expected five'),'actual failed test output reaches model: '+messages.at(-1).content);
  if(stage===10)assert.ok(messages.at(-1).content.includes('TEST_PASSED'),'actual successful test output reaches model');
  const action=actions[stage++];return {choices:[{message:action?{role:'assistant',content:'',tool_calls:[{id:String(stage),type:'function',function:{name:action[0],arguments:JSON.stringify(typeof action[1]==='function'?action[1]():action[1])}}]}:{role:'assistant',content:'已修复并通过测试'}}]};
 },executeTool:async({capability,args})=>{const result=await run(capability.name,args);if(capability.name==='run_command')commandId=JSON.parse(result.modelContent).process_id;return result;}});
 assert.equal(result.toolCalls,10);assert.equal(result.steps,11);
 await assert.rejects(run('run_command',{command:'echo hi',unrestricted:true}),e=>e.code==='CONFIRMATION_REQUIRED');
 const dangerous=context.capabilities.find(c=>c.name==='run_command').resolveInvocation({unrestricted:true});assert.equal(permission.policyDecision('test',dangerous).kind,'ask');
 const outside=path.join(root,'outside.txt');fs.writeFileSync(outside,'safe');
 let r=JSON.parse((await run('run_command',{command:`echo changed > '${outside}'`})).modelContent);assert.notEqual(r.exit_code,0);assert.equal(fs.readFileSync(outside,'utf8'),'safe');
 r=JSON.parse((await run('run_command',{command:'rm add.mjs'})).modelContent);assert.notEqual(r.exit_code,0);assert.ok(fs.existsSync(path.join(workspace,'add.mjs')));
 fs.writeFileSync(path.join(workspace,'.env'),'PRIVATE_TEST');r=JSON.parse((await run('run_command',{command:'cat .env'})).modelContent);assert.notEqual(r.exit_code,0);
 r=JSON.parse((await run('run_command',{command:'ln .env innocent.txt && cat innocent.txt'})).modelContent);const linked=await run('read_command_output',{process_id:r.process_id});assert.ok(!linked.modelContent.includes('PRIVATE_TEST'),'hard links cannot bypass credential read denial');
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 const stream='BT /F1 16 Tf 20 50 Td (PDF_AGENT_FIXTURE) Tj ET';objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
 let pdf='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer << /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 const pdfPath=path.join(workspace,'fixture.pdf');fs.writeFileSync(pdfPath,pdf);const extracted=await run('read_pdf',{path:pdfPath,start_page:1,end_page:1});assert.ok(extracted.modelContent.includes('PDF_AGENT_FIXTURE'));
 r=JSON.parse((await run('run_command',{command:'echo changed > .env'})).modelContent);assert.notEqual(r.exit_code,0);assert.equal(fs.readFileSync(path.join(workspace,'.env'),'utf8'),'PRIVATE_TEST');
 const protectedProcess=spawn('/bin/sleep',['20']);try{r=JSON.parse((await run('run_command',{command:`kill -TERM ${protectedProcess.pid}`})).modelContent);assert.notEqual(r.exit_code,0);assert.equal(protectedProcess.exitCode,null);}finally{protectedProcess.kill('SIGKILL');}
 const restored=new AgentToolsV1({artifactRoot:path.join(root,'artifacts'),localRuntime:new LocalAgentRuntime({controls})});assert.ok((await restored.execute('read_command_output',{process_id:commandId},opts)).modelContent.includes('TEST_PASSED'));
 await assert.rejects(restored.execute('get_process_status',{process_id:commandId},{...opts,sessionId:'other'}),e=>e.code==='PROCESS_NOT_FOUND');
 console.log('PASS 11-step coding loop: inspect, failed patch, failed real test, repair, successful real test; sandbox writes/deletes/credentials; dangerous approval; durable output; session isolation');
}finally{fs.rmSync(root,{recursive:true,force:true});}
