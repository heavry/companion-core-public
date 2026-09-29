process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";
process.env.UPSTREAM_PRIMARY_BASE_URL="";process.env.UPSTREAM_SECONDARY_BASE_URL="";process.env.UPSTREAM_API_KEY="";process.env.UPSTREAM_PRIMARY_API_KEY="";process.env.UPSTREAM_SECONDARY_API_KEY="";process.env.UPSTREAM_CHAT_API_KEY="";process.env.UPSTREAM_AGENT_API_KEY="";process.env.UPSTREAM_SUMMARY_API_KEY="";process.env.TAVILY_BASE_URL="";process.env.TAVILY_API_KEY="";process.env.SEARXNG_BASE_URL="";

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"companion-developer-runtime-")),repo=path.join(root,"repo"),bare=path.join(root,"remote.git"),ledger=path.join(root,"invocations.jsonl");
fs.mkdirSync(repo);process.env.COMPANION_INVOCATION_LEDGER_PATH=ledger;process.env.COMPANION_INVOCATION_SUMMARY_PATH=path.join(root,"summary.json");process.env.COMPANION_PRICING_REVISIONS_PATH=path.join(root,"prices.json");
const git=(args,cwd=repo)=>{const result=spawnSync("git",args,{cwd,encoding:"utf8"});if(result.status!==0)throw new Error(result.stderr);return result.stdout.trim();};
git(["init","-b","main"]);git(["config","user.name","Companion Test"]);git(["config","user.email","companion@example.invalid"]);fs.writeFileSync(path.join(repo,"README.md"),"baseline\n");git(["add","README.md"]);git(["commit","-m","baseline"]);spawnSync("git",["init","--bare",bare],{encoding:"utf8"});git(["remote","add","origin",bare]);git(["push","-u","origin","main"]);

const ghLog=path.join(root,"gh-args.log"),fakeGh=path.join(root,"fake-gh.sh");fs.writeFileSync(fakeGh,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\ncase "$*" in\n  *"issue create"*) printf '%s\\n' 'https://github.example/test/issue/1' ;;\n  *"pr create"*) printf '%s\\n' 'https://github.example/test/pull/2' ;;\n  *"pr checks"*) printf '%s\\n' '[{"name":"tests","state":"SUCCESS","bucket":"pass","link":"https://ci.example/1"}]' ;;\n  *) printf '%s\\n' '{"nameWithOwner":"fixture/repo","url":"https://github.example/fixture/repo","defaultBranchRef":{"name":"main"}}' ;;\nesac\n`,{mode:0o700});
process.env.GH_TOKEN="fixture-secret-token-must-not-appear";

const { DeveloperOperationsRuntime,developerOperationsCapabilityContext }=await import("../src/developer-operations-runtime.js");
const runtime=new DeveloperOperationsRuntime({ghExecutable:fakeGh}),owner="developer-fixture",run=(name,args={})=>runtime.execute(name,args,{workspaceRoot:repo,sessionId:owner});
let result=await run("git_status");let data=JSON.parse(result.modelContent);assert.equal(data.branch,"main");assert.equal(data.dirty_files.length,0);
await assert.rejects(run("git_commit",{message:"must fail"}),error=>error.code==="GIT_PROTECTED_BRANCH","protected branch cannot be committed by full autonomy");
result=await run("git_branch",{action:"create",name:"agent/fixture"});assert.equal(JSON.parse(result.modelContent).after.branch,"agent/fixture");
fs.writeFileSync(path.join(repo,"feature.txt"),"first\n");result=await run("git_status");assert(JSON.parse(result.modelContent).dirty_files.some(line=>line.includes("feature.txt")));
await run("git_add",{paths:["feature.txt"]});await run("git_commit",{message:"feat: fixture"});result=await run("git_push",{remote:"origin",set_upstream:true});assert.equal(JSON.parse(result.modelContent).after.branch,"agent/fixture");assert.equal(git(["rev-parse","refs/remotes/origin/agent/fixture"]),git(["rev-parse","HEAD"]));
fs.appendFileSync(path.join(repo,"feature.txt"),"second\n");result=await run("git_diff",{paths:["feature.txt"]});data=JSON.parse(result.modelContent);assert(data.files.some(line=>line.includes("feature.txt"))&&data.diff.includes("second"));
fs.writeFileSync(path.join(repo,"credentials.pem"),"PRIVATE_DIFF_MARKER=must-not-appear\n");git(["add","credentials.pem"]);result=await run("git_diff",{staged:true});data=JSON.parse(result.modelContent);assert(!data.diff.includes("PRIVATE_DIFF_MARKER")&&data.omitted_sensitive_files.includes("credentials.pem"),"Git diff omits credential-bearing files");
await assert.rejects(run("git_diff",{paths:["credentials.pem"]}),error=>error.code==="LOCAL_SENSITIVE_PATH_BLOCKED","explicit sensitive Git paths are blocked");git(["restore","--staged","credentials.pem"]);fs.rmSync(path.join(repo,"credentials.pem"));
await assert.rejects(run("git_branch",{action:"switch",name:"main"}),error=>error.code==="GIT_WIP_PRESENT","dirty WIP prevents branch switching");
await run("git_add",{paths:["feature.txt"]});await run("git_commit",{message:"feat: second"});await run("git_tag",{name:"fixture-v1",message:"fixture",push:true});await assert.rejects(run("git_tag",{name:"fixture-v1",message:"overwrite"}),error=>error.code==="GIT_TAG_EXISTS","tag overwrite is blocked");
await assert.rejects(run("git_tag",{name:"-f",message:"must not become an option"}),error=>error.code==="GIT_ARGUMENT_INVALID","option-shaped tag names cannot bypass no-overwrite safety");
await assert.rejects(run("git_push",{remote:"--force"}),error=>error.code==="GIT_ARGUMENT_INVALID","option-shaped remotes cannot request force push");
result=await run("git_log",{limit:3});assert(JSON.parse(result.modelContent).commits.length>=2);

const context=developerOperationsCapabilityContext([{role:"user",content:"修复这个 repo，提交 push，然后在 GitHub 开 PR 并检查 CI"}],{workspaceRoot:repo});assert(context.capabilities.length<=12);assert(context.capabilities.some(item=>item.name==="git_status")&&context.capabilities.some(item=>item.name==="github_pr"));
const { localAgentCapabilityContext }=await import("../src/local-agent-runtime.js"),localContext=localAgentCapabilityContext([{role:"user",content:"修复这个 repo，提交 push，然后在 GitHub 开 PR 并检查 CI"}],{workspaceRoot:repo}),combined=[...context.capabilities,...localContext.capabilities].slice(0,12).map(item=>item.name);assert(combined.includes("fs_patch")&&combined.includes("terminal_exec")&&combined.includes("fs_read"),"combined 12-tool selector retains patch, execution and source reads");
const noRoot=developerOperationsCapabilityContext([{role:"user",content:"检查 git status 并启动服务"}],{});assert(noRoot.capabilities.every(item=>["process_list","process_inspect","port_inspect","service_health"].includes(item.name)),"workspace tools are absent without a workspace scope");
assert.equal(developerOperationsCapabilityContext([{role:"user",content:"CIRCUIT_USES_SECONDARY"}],{workspaceRoot:repo}),null,"CI intent requires a complete word and does not alter ordinary provider traffic");
assert.equal(developerOperationsCapabilityContext([{role:"user",content:"PRIMARY_PROCESS_UNAVAILABLE"}],{workspaceRoot:repo}),null,"process intent requires a complete word and does not alter ordinary provider traffic");

result=await run("github_repo_read",{repo:"fixture/repo"});assert.equal(JSON.parse(result.modelContent).nameWithOwner,"fixture/repo");
result=await run("github_issue",{action:"create",repo:"fixture/repo",title:"Fixture",body:"Safe body"});assert.match(JSON.parse(result.modelContent).url,/issue\/1/);
result=await run("github_pr",{action:"create",repo:"fixture/repo",title:"Fixture PR",body:"Safe body",base:"main",head:"agent/fixture"});assert.match(JSON.parse(result.modelContent).url,/pull\/2/);
result=await run("github_ci_status",{repo:"fixture/repo",number:2});assert.equal(JSON.parse(result.modelContent)[0].state,"SUCCESS");
const ghArgs=fs.readFileSync(ghLog,"utf8");assert(!ghArgs.includes(process.env.GH_TOKEN)&&!/auth token/.test(ghArgs),"GitHub credential is runtime-only and never appears in gh arguments");

result=await run("process_start",{executable:"/bin/bash",args:["-lc","printf 'ready\\n'; sleep 30"]});const processId=JSON.parse(result.modelContent).process_id;
await new Promise(resolve=>setTimeout(resolve,80));result=await run("process_inspect",{process_id:processId});assert.equal(JSON.parse(result.modelContent).status,"running");
result=await run("logs_tail",{process_id:processId,lines:20});assert.match(JSON.parse(result.modelContent).output,/ready/);
result=await run("process_list",{owned_only:true});assert(JSON.parse(result.modelContent).processes.some(item=>item.pid>0));
await assert.rejects(run("process_stop",{process_id:"proc_0000000000000000"}),error=>error.code==="PROCESS_NOT_OWNED","arbitrary process kill is blocked");await run("process_stop",{process_id:processId});

fs.writeFileSync(path.join(repo,"service.log"),"one\ntwo\nthree\n");result=await run("logs_tail",{path:"service.log",lines:2});assert.match(JSON.parse(result.modelContent).lines,/two\nthree/);
fs.writeFileSync(path.join(repo,".env"),"LOG_SECRET_MARKER=must-not-appear\n");await assert.rejects(run("logs_tail",{path:".env",lines:2}),error=>error.code==="LOCAL_SENSITIVE_PATH_BLOCKED","log tail cannot read credential-bearing paths");
const healthServer=http.createServer((_req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end('{"ok":true}');});await new Promise(resolve=>healthServer.listen(0,"127.0.0.1",resolve));const port=healthServer.address().port;
result=await run("service_health",{url:`http://127.0.0.1:${port}/health`});assert.equal(JSON.parse(result.modelContent).healthy,true);result=await run("port_inspect",{port});assert(JSON.parse(result.modelContent).listeners.length>=1);await new Promise(resolve=>healthServer.close(resolve));
await assert.rejects(runtime.execute("service_health",{url:"https://example.com/health"},{sessionId:owner}),/loopback|workspace|repo/i,"remote health checks are outside the service capability");

const records=fs.readFileSync(ledger,"utf8").trim().split("\n").map(line=>JSON.parse(line));assert(records.some(item=>item.feature==="git"&&item.inputTokens===null));assert(records.some(item=>item.feature==="github"&&item.success===true));assert(records.some(item=>item.feature==="process"&&Number.isInteger(item.durationMs)));
fs.rmSync(root,{recursive:true,force:true});console.log("developer-operations-runtime-test: ok");
