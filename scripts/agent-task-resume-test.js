import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {AgentTaskStore} from '../src/agent-task-store.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-task-resume-'));
try{
 const store=new AgentTaskStore({root}),task=store.create('owner',{prompt:'fix the repository',workspaceRoot:'/fixture'});
 store.before(task,{step:0,call:{id:'1',function:{name:'apply_patch',arguments:JSON.stringify({new_text:'FILE_CONTENT_MUST_NOT_PERSIST'})}}});
 const script=`import {AgentTaskStore} from ${JSON.stringify(new URL('../src/agent-task-store.js',import.meta.url).href)};const s=new AgentTaskStore({root:${JSON.stringify(root)}});const t=s.get('owner',${JSON.stringify(task.id)});if(t.status!=='interrupted'||t.journal[0].state!=='in_flight')throw Error('restart state');console.log(t.id);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
 const restarted=new AgentTaskStore({root});assert.throws(()=>restarted.get('other',task.id),e=>e.code==='TASK_NOT_FOUND');
 assert.throws(()=>restarted.resume('owner',task.id,'/different'),e=>e.code==='TASK_WORKSPACE_CHANGED');
 const resumed=restarted.resume('owner',task.id,'/fixture');assert.equal(resumed.attempt,2);assert.match(restarted.resumeObservation(resumed).content,/UNKNOWN outcome/);
 assert.ok(!fs.readFileSync(store.file('owner',task.id),'utf8').includes('FILE_CONTENT_MUST_NOT_PERSIST'));
 assert.throws(()=>restarted.resume('owner',task.id,'/fixture'),e=>e.code==='TASK_ALREADY_RUNNING');
 restarted.finish(resumed,'completed');assert.throws(()=>restarted.resume('owner',task.id,'/fixture'),e=>e.code==='TASK_ALREADY_COMPLETED');
 console.log('PASS real process restart, unknown in-flight outcome, no automatic replay, scope/owner checks, no file content checkpoint, task completion');
}finally{fs.rmSync(root,{recursive:true,force:true});}
