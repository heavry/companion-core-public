import { redactSecrets } from "./runtime.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export const SESSION_PERMISSION_MODES=Object.freeze(["ask","risk_based","session_grant","full_autonomy"]);
const VALID_MODES=new Set(SESSION_PERMISSION_MODES);
const VALID_ACTIONS=new Set(["allow_once","allow_session","deny"]);

function nowIso(){return new Date().toISOString();}
function cleanId(value,max=240){return String(value??"").replace(/[\u0000-\u001f\u007f]/g,"").slice(0,max);}
function capabilityId(capability){return cleanId(capability?.capabilityId??capability?.id??capability?.name??"");}

export function permissionScopeFor(capability){
  const permissions=new Set(Array.isArray(capability?.permissions)?capability.permissions:[]);
  if(permissions.has("external_action"))return "external_action";
  if(permissions.has("sensitive"))return "sensitive";
  if([...permissions].some(p=>p.endsWith(".write")||p.endsWith(".control")||p==="app.launch")||permissions.has("write")||capability?.sideEffect==="non_idempotent")return "write";
  return "read";
}

export function sessionGrantAllowed(capability){
  const scope=permissionScopeFor(capability);
  return !requiresOneTimeConfirmation(capability)&&!["external_action","sensitive"].includes(scope)&&capability?.riskLevel!=="high"&&!["non_idempotent","unknown"].includes(capability?.sideEffect);
}

function requiresOneTimeConfirmation(capability){
  // Legacy adapters are not sandboxed. They cannot become a bypass around run_command.
  return /^(?:terminal_exec|terminal_session_start|terminal_session_write|process_start|fs_delete|git_add|git_commit|git_push|git_pull|git_stash)$/.test(String(capability?.name??""))||capability?.requiresConfirmation===true;
}

export function fullAutonomyAllowed(capability){
  return !requiresOneTimeConfirmation(capability)&&capability?.hardSafetyBoundary!==true&&capability?.riskLevel!=="high"&&!["external_action","sensitive"].includes(permissionScopeFor(capability));
}

function publicCapability(capability){
  return {
    capability_id:capabilityId(capability),
    source_type:cleanId(capability?.sourceType??"unknown",32),
    source_id:cleanId(capability?.sourceId??"",96)||null,
    integration_name:cleanId(capability?.integrationName??capability?.sourceId??"Integration",64),
    display_name:cleanId(capability?.displayName??capability?.name??"tool",96),
    scope:permissionScopeFor(capability),
    risk_level:cleanId(capability?.riskLevel??"low",16),
    read_only:permissionScopeFor(capability)==="read"
  };
}

export class SessionPermissionStore{
  constructor({filePath=config.sessionPermissionsPath,ttlMs=config.sessionPermissionGrantTtlMs,pendingTtlMs=config.sessionPermissionPendingTtlMs,onEvent=()=>{},clock=()=>Date.now()}={}){
    this.filePath=filePath;this.ttlMs=ttlMs;this.pendingTtlMs=pendingTtlMs;this.onEvent=onEvent;this.clock=clock;
    this.sessions=new Map();this.pending=new Map();this.interrupted=new Map();this.load();
  }
  load(){
    let parsed={},loaded=false;try{parsed=JSON.parse(fs.readFileSync(this.filePath,"utf8"));loaded=true;}catch{}
    for(const raw of Array.isArray(parsed?.sessions)?parsed.sessions:[]){
      const sessionId=cleanId(raw?.session_id);if(!sessionId)continue;
      const mode=VALID_MODES.has(raw?.mode)?raw.mode:"risk_based";
      const grants=(Array.isArray(raw?.grants)?raw.grants:[]).filter(g=>g?.session_id===sessionId&&Date.parse(g.expires_at)>this.clock()).map(g=>({...g}));
      let workspaceRoot=null;try{if(path.isAbsolute(raw?.workspace_root??"")&&fs.statSync(raw.workspace_root).isDirectory())workspaceRoot=fs.realpathSync(raw.workspace_root);}catch{}
      this.sessions.set(sessionId,{mode,grants,workspaceRoot});
    }
    const interruptedInputs=[...(Array.isArray(parsed?.pending)?parsed.pending:[]),...(Array.isArray(parsed?.interrupted)?parsed.interrupted:[])];
    for(const pending of interruptedInputs){
      const requestId=cleanId(pending?.request_id),sessionId=cleanId(pending?.session_id),callId=cleanId(pending?.call_id);
      if(!requestId||!sessionId||!callId)continue;
      const interruptedAt=pending?.interrupted_at??nowIso();if(Date.parse(interruptedAt)+24*60*60*1000<=this.clock())continue;
      this.interrupted.set(`${sessionId}:${callId}`,{...pending,status:"interrupted",interrupted_at:interruptedAt,failure_category:"tool_error",failure_code:"approval_interrupted",failure_summary:"审批因服务重启而中断",failure_reason:"请重新发送这项请求"});
    }
    if(loaded)this.persist();
  }
  persist(){
    if(!this.filePath)return;
    fs.mkdirSync(path.dirname(this.filePath),{recursive:true});
    const tmp=`${this.filePath}.${process.pid}.tmp`;
    const sessions=[...this.sessions.entries()].map(([session_id,value])=>({session_id,mode:value.mode,grants:value.grants,workspace_root:value.workspaceRoot??null}));
    const pending=[...this.pending.values()].map(record=>record.pending);
    const interrupted=[...this.interrupted.values()].slice(-512);
    fs.writeFileSync(tmp,JSON.stringify({version:1,sessions,pending,interrupted},null,2),{mode:0o600});fs.renameSync(tmp,this.filePath);try{fs.chmodSync(this.filePath,0o600);}catch{}
  }
  state(sessionId){
    const id=cleanId(sessionId);if(!this.sessions.has(id))this.sessions.set(id,{mode:"risk_based",grants:[],workspaceRoot:null});
    const state=this.sessions.get(id),before=state.grants.length;state.grants=state.grants.filter(g=>Date.parse(g.expires_at)>this.clock());if(before!==state.grants.length)this.persist();return state;
  }
  setMode(sessionId,mode){
    if(!VALID_MODES.has(mode))throw Object.assign(new Error("invalid permission mode"),{statusCode:400,code:"INVALID_PERMISSION_MODE"});
    const state=this.state(sessionId);state.mode=mode;this.persist();this.emit("permission.mode_changed",sessionId,{mode});return this.snapshot(sessionId);
  }
  workspaceRoot(sessionId){return this.state(sessionId).workspaceRoot??null;}
  setWorkspace(sessionId,value){
    const requested=String(value??"").trim();
    if(!path.isAbsolute(requested))throw Object.assign(new Error("workspace path must be an absolute directory"),{statusCode:400,code:"INVALID_WORKSPACE_PATH"});
    let root;try{root=fs.realpathSync(requested);if(!fs.statSync(root).isDirectory())throw new Error("not a directory");}catch{throw Object.assign(new Error("workspace directory is unavailable"),{statusCode:400,code:"WORKSPACE_UNAVAILABLE"});}
    const state=this.state(sessionId);state.workspaceRoot=root;this.persist();this.emit("workspace.changed",sessionId,{workspace:this.publicWorkspace(root)});return this.snapshot(sessionId);
  }
  clearWorkspace(sessionId){const state=this.state(sessionId),changed=Boolean(state.workspaceRoot);state.workspaceRoot=null;this.persist();if(changed)this.emit("workspace.changed",sessionId,{workspace:null});return this.snapshot(sessionId);}
  publicWorkspace(root){return root?{path:root,name:path.basename(root)||root}:null;}
  matchingGrant(sessionId,capability){
    const state=this.state(sessionId);if(state.mode!=="session_grant")return null;
    const id=capabilityId(capability),scope=permissionScopeFor(capability);
    return state.grants.find(g=>g.capability_id===id&&g.scope===scope)??null;
  }
  policyDecision(sessionId,capability){
    const state=this.state(sessionId),scope=permissionScopeFor(capability);
    if(requiresOneTimeConfirmation(capability)||capability?.riskLevel==="high"||["external_action","sensitive"].includes(scope))return {kind:"ask",reason:"dangerous action requires explicit one-time confirmation",failureCategory:"permission_required"};
    if(state.mode==="full_autonomy")return fullAutonomyAllowed(capability)?{kind:"allow",reason:"full autonomy within the selected capability and workspace scope",source:"full_autonomy"}:{kind:"ask",reason:"this action crosses a hard safety boundary",failureCategory:"permission_required"};
    if(state.mode==="session_grant"&&this.matchingGrant(sessionId,capability))return {kind:"allow",reason:"matching session grant",source:"session_grant"};
    if(state.mode==="ask"&&capability?.sourceType!=="core")return {kind:"ask",reason:"current session requires approval",failureCategory:"permission_required"};
    if(scope!=="read"||capability?.riskLevel==="high"||["non_idempotent","unknown"].includes(capability?.sideEffect))return {kind:"ask",reason:"this action can change external state",failureCategory:"permission_required"};
    return {kind:"allow",source:"risk_policy"};
  }
  beginRequest({sessionId,callId,capability,args={},reason,signal}={}){
    const requestId=`perm_${crypto.randomBytes(10).toString("hex")}`,createdAt=this.clock(),expiresAt=createdAt+this.pendingTtlMs;
    const pending={request_id:requestId,session_id:cleanId(sessionId),call_id:cleanId(callId),...publicCapability(capability),action_preview:redactSecrets(JSON.stringify(args),1200),reason:cleanId(reason||"Current session has no matching grant",180),can_allow_session:sessionGrantAllowed(capability),created_at:new Date(createdAt).toISOString(),expires_at:new Date(expiresAt).toISOString(),status:"pending"};
    let resolvePromise;const promise=new Promise(resolve=>{resolvePromise=resolve;});
    const record={pending,resolve:resolvePromise,timer:null,abort:null,signal};this.pending.set(requestId,record);
    this.persist();
    record.timer=setTimeout(()=>this.resolve(pending.session_id,requestId,"deny",{reason:"approval expired"}),this.pendingTtlMs);record.timer.unref?.();
    if(signal){record.abort=()=>this.cancel(requestId,"request cancelled");if(signal.aborted)record.abort();else signal.addEventListener("abort",record.abort,{once:true});}
    this.emit("permission.requested",pending.session_id,{request:pending});
    return {pending,promise};
  }
  async request(options={}){
    return this.beginRequest(options).promise;
  }
  resolve(sessionId,requestId,action,{reason=""}={}){
    if(!VALID_ACTIONS.has(action))throw Object.assign(new Error("invalid permission decision"),{statusCode:400,code:"INVALID_PERMISSION_DECISION"});
    const record=this.pending.get(requestId);if(!record||record.pending.session_id!==cleanId(sessionId))throw Object.assign(new Error("approval request not found or no longer pending"),{statusCode:404,code:"PERMISSION_REQUEST_NOT_FOUND"});
    if(action==="allow_session"&&!record.pending.can_allow_session)throw Object.assign(new Error("this action cannot be granted for the session"),{statusCode:409,code:"SESSION_GRANT_NOT_ALLOWED"});
    let grant=null;if(action==="allow_session"){
      const state=this.state(sessionId),created=this.clock();state.mode="session_grant";
      grant={id:`grant_${crypto.randomBytes(8).toString("hex")}`,session_id:record.pending.session_id,capability_id:record.pending.capability_id,scope:record.pending.scope,source_type:record.pending.source_type,source_id:record.pending.source_id,integration_name:record.pending.integration_name,display_name:record.pending.display_name,created_at:new Date(created).toISOString(),expires_at:new Date(created+this.ttlMs).toISOString(),source:"user_approval"};
      state.grants=state.grants.filter(g=>!(g.capability_id===grant.capability_id&&g.scope===grant.scope));state.grants.push(grant);this.persist();
    }
    this.pending.delete(requestId);clearTimeout(record.timer);if(record.abort)record.signal?.removeEventListener?.("abort",record.abort);this.persist();
    const decision=action==="deny"?"deny":"allow",outcome={decision,action,request_id:requestId,call_id:record.pending.call_id,capability_id:record.pending.capability_id,reason:cleanId(reason||(decision==="allow"?"approved by user":"denied by user"),180),grant};
    this.emit("permission.resolved",record.pending.session_id,outcome);record.resolve(outcome);return {ok:true,...outcome,snapshot:this.snapshot(sessionId)};
  }
  cancel(requestId,reason="request cancelled"){
    const record=this.pending.get(requestId);if(!record)return false;
    this.pending.delete(requestId);clearTimeout(record.timer);if(record.abort)record.signal?.removeEventListener?.("abort",record.abort);this.persist();const outcome={decision:"deny",action:"deny",request_id:requestId,call_id:record.pending.call_id,capability_id:record.pending.capability_id,reason};this.emit("permission.resolved",record.pending.session_id,outcome);record.resolve(outcome);return true;
  }
  revoke(sessionId,grantId){const state=this.state(sessionId),before=state.grants.length;state.grants=state.grants.filter(g=>g.id!==grantId);if(before===state.grants.length)return false;this.persist();this.emit("permission.grant_revoked",sessionId,{grant_id:grantId});return true;}
  revokeAll(sessionId){const state=this.state(sessionId),count=state.grants.length;state.grants=[];this.persist();this.emit("permission.grants_revoked",sessionId,{count});return count;}
  removeSession(sessionId){const id=cleanId(sessionId);for(const [requestId,record] of this.pending)if(record.pending.session_id===id)this.cancel(requestId,"session ended");for(const [key,value] of this.interrupted)if(value.session_id===id)this.interrupted.delete(key);const removed=this.sessions.delete(id);if(removed)this.persist();return removed;}
  hasPending(sessionId){return [...this.pending.values()].some(r=>r.pending.session_id===cleanId(sessionId));}
  interruptedFor(sessionId,callId){return this.interrupted.get(`${cleanId(sessionId)}:${cleanId(callId)}`)??null;}
  snapshot(sessionId){const state=this.state(sessionId),pending=[...this.pending.values()].map(r=>r.pending).filter(p=>p.session_id===cleanId(sessionId));return {session_id:cleanId(sessionId),mode:state.mode,grants:state.grants,pending,workspace:this.publicWorkspace(state.workspaceRoot)};}
  emit(type,sessionId,data){try{this.onEvent(type,data,{sessionId});}catch{}}
}

export const sessionPermissions=new SessionPermissionStore();
