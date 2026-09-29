import path from "node:path";
import { cleanKey,sha256,uuid } from "./utils.js";

const projectHeaders=["x-companion-project","x-companion-project-path","x-companion-workspace","x-project-path","x-workspace","x-repository-path","x-repository-name","x-cwd","x-project-id","x-opencode-project","x-harness-project","x-session-id"];
const projectKeys=["project_path","projectPath","workspace","workspace_path","workspacePath","repository_path","repositoryPath","repository_name","repositoryName","cwd","project_id","projectId","repo","repository"];

function header(req,name){const v=req.headers[name];return Array.isArray(v)?v[0]:v;}
function scalar(v){return typeof v==="string"&&v.trim()?v.trim():typeof v==="number"?String(v):"";}
function fromObject(o){if(!o||typeof o!=="object"||Array.isArray(o))return "";for(const key of projectKeys){const value=scalar(o[key]);if(value)return value;}return "";}
function projectIdentity(req,body){
  for(const name of projectHeaders){const value=scalar(header(req,name));if(value)return {value,via:`header:${name}`};}
  for(const container of [body,body?.metadata,body?.project,body?.context,body?.client]){const value=fromObject(container);if(value)return {value,via:"body:project"};}
  const user=scalar(body?.user);return user?{value:user,via:"body:user"}:null;
}
function authorizedWorkspaceRoot(identity){
  const value=scalar(identity?.value);if(!value||!path.isAbsolute(value))return null;
  return path.resolve(value);
}
function slugFor(value){
  const normalized=value.replace(/\\/g,"/").replace(/\/+$/,"");
  const base=(path.posix.basename(normalized)||"project").replace(/\.git$/i,"").toLowerCase();
  return base.replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,48)||"project";
}
export function stableProjectSession(value){
  const normalized=String(value).trim().replace(/\\/g,"/").replace(/\/+$/,"");
  return `project-${slugFor(normalized)}-${sha256(normalized).slice(0,12)}`;
}

export function resolveSession(req,body,source){
  const project=projectIdentity(req,body),workspaceRoot=authorizedWorkspaceRoot(project);
  const explicitHeader=scalar(header(req,"x-companion-session"));
  if(explicitHeader)return {sessionKey:cleanKey(explicitHeader,"",200),strategy:"explicit_header",workspaceRoot};
  const explicitBody=scalar(body?.companion_session);
  if(explicitBody)return {sessionKey:cleanKey(explicitBody,"",200),strategy:"explicit_body",workspaceRoot};
  if(source.toLowerCase()==="kelivo")return {sessionKey:"daily-main",strategy:"kelivo_default",workspaceRoot};
  if(/opencode|harness|agent|code/i.test(source)){
    if(project)return {sessionKey:stableProjectSession(project.value),strategy:"project",projectVia:project.via,workspaceRoot};
    return {sessionKey:`safe-${cleanKey(source,"agent",40)}-${uuid()}`,strategy:"safe_ephemeral"};
  }
  const user=scalar(body?.user);
  return {sessionKey:user?cleanKey(user,`${source}:default`,200):`${source}:default`,strategy:user?"body_user":"source_default",workspaceRoot};
}
