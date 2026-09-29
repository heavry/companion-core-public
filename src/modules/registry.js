import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { scanModuleDirectory } from "./loader.js";
import { buildBridge } from "./bridge.js";
import { instantiateModule,getHandler,callModuleHandler,callHook } from "./sandbox.js";
import { describePermissions } from "./permissions.js";
import { PROTECTED_TOOL_NAMES,serializeModuleToolResult } from "../tool-registry.js";
import { safeErrorMessage } from "../runtime.js";

// ModuleRegistry：模块生命周期、启用状态持久化、工具索引、错误隔离。
// 任何单个模块的失败都不得影响 Core 其他部分。

const stateDir=path.dirname(config.modulesStatePath);

function loadPersistedState(){
  try{return JSON.parse(fs.readFileSync(config.modulesStatePath,"utf8"));}
  catch{return {version:1,modules:{},triggers:{}};}
}

function persistStateNow(state){
  try{
    fs.mkdirSync(stateDir,{recursive:true});
    const tmp=`${config.modulesStatePath}.tmp`;
    fs.writeFileSync(tmp,JSON.stringify(state,null,2));
    fs.renameSync(tmp,config.modulesStatePath);
  }catch(e){console.error("[modules] state persist failed:",safeErrorMessage(e));}
}
function persistState(state){persistStateNow(state);}

class ModuleRegistry{
  constructor(){
    this.ready=false;
    this.globallyEnabled=config.modulesEnabled;
    this.state=loadPersistedState();
    this.modules=new Map();
    this.scanErrors=[];
    this.engine=null;
  }

  attachTriggerEngine(engine){this.engine=engine;}

  flushState(){persistStateNow(this.state);}

  getModule(id){return this.modules.get(id)??null;}

  isModuleToolAllowed(name){
    const entry=this.toolEntry(name);
    return Boolean(entry&&this.modules.get(entry.moduleId)?.enabled);
  }

  toolEntry(name){
    for(const mod of this.modules.values()){
      const entry=mod.toolIndex.get(name);
      if(entry)return {...entry,moduleId:mod.id};
    }
    return null;
  }

  enabledModuleTools(){
    const out=[];
    for(const mod of this.modules.values()){
      if(!mod.enabled||!mod.instance)continue;
      for(const [name,entry] of mod.toolIndex)out.push({name,description:entry.definition.description,parameters:entry.definition.parameters,sideEffect:entry.definition.sideEffect??"non_idempotent",source:"module",moduleId:mod.id});
    }
    return out.sort((a,b)=>a.name.localeCompare(b.name));
  }

  async executeModuleTool(name,args){
    const entry=this.toolEntry(name);
    if(!entry){const e=new Error(`module tool not found: ${name}`);e.code="MODULE_TOOL_NOT_FOUND";throw e;}
    const mod=this.modules.get(entry.moduleId);
    if(!mod?.enabled||!mod.instance){const e=new Error(`module ${entry.moduleId} owning tool ${name} is disabled`);e.code="MODULE_DISABLED";throw e;}
    let outcome;
    try{outcome=await entry.handler(args);}
    catch(e){outcome={ok:false,error:e};}
    if(!outcome.ok){
      this.recordError(mod,`tool "${name}" failed: ${safeErrorMessage(outcome.error)}`);
      const err=new Error(`module tool "${name}" failed: ${safeErrorMessage(outcome.error)}`);
      err.code=outcome.error?.code==="MODULE_TIMEOUT"?"MODULE_TIMEOUT":"MODULE_TOOL_FAILED";
      err.isError=true;
      throw err;
    }
    return serializeModuleToolResult(outcome.value,{maxChars:config.moduleToolResultMaxChars});
  }

  recordError(mod,message){
    mod.lastError=safeErrorMessage(message,1000);
    mod.lastErrorAt=new Date().toISOString();
  }

  async instantiate(mod){
    mod.instance=null;
    mod.toolIndex=new Map();
    mod.dynamicTools=new Map();
    try{
      const bridge=buildBridge(mod.manifest,{
        registerDynamicTool:(definition,handler)=>{
          if(!mod.instance)mod.pendingDynamic.push({definition,handler});
          else this.registerDynamicTool(mod,definition,handler);
        }
      });
      let moduleConfig=null;
      try{moduleConfig=JSON.parse(fs.readFileSync(path.join(path.dirname(config.modulesStatePath),"modules-config",`${mod.id}.json`),"utf8"));}catch{}
      const {exports:rawExports}=await instantiateModule({manifest:mod.manifest,source:mod.source,filename:mod.filename,bridge,moduleConfig});
      mod.instance={exports:rawExports};
      mod.pendingDynamic=[];
      for(const toolDef of mod.manifest.tools){
        const handler=getHandler(rawExports,"tools",toolDef.name);
        if(typeof handler!=="function")throw Object.assign(new Error(`manifest tool "${toolDef.name}" has no matching exported handler in main.js`),{code:"MODULE_LOAD_FAILED"});
        this.indexTool(mod,toolDef,async args=>callModuleHandler(handler,args));
      }
      for(const {definition,handler} of mod.pendingDynamic.splice(0))this.registerDynamicTool(mod,definition,handler);
      if(mod.manifest.hooks.includes("onLoad")){
        const hook=getHandler(rawExports,"hooks","onLoad");
        if(typeof hook==="function")await callHook(hook,{});
      }
    }catch(e){
      mod.lastError=safeErrorMessage(e,1000);
      mod.lastErrorAt=new Date().toISOString();
      mod.instance=null;
      mod.toolIndex=new Map();
      return false;
    }
    return true;
  }

  indexTool(mod,definition,handler){
    const name=definition.name;
    if(PROTECTED_TOOL_NAMES.has(name))throw Object.assign(new Error(`tool name "${name}" is protected by Companion Core`),{code:"TOOL_NAME_PROTECTED"});
    if(this.toolEntry(name)||mod.toolIndex.has(name))throw Object.assign(new Error(`duplicate tool name across modules: ${name}`),{code:"MODULE_TOOL_DUPLICATE"});
    mod.toolIndex.set(name,{definition:{name,description:definition.description??"",parameters:definition.parameters??{type:"object",properties:{}}},handler});
  }

  registerDynamicTool(mod,definition,handler){
    try{
      this.indexTool(mod,definition,async args=>callModuleHandler(handler,args));
      mod.dynamicTools.set(definition.name,definition);
      return {ok:true,name:definition.name};
    }catch(e){
      return {ok:false,error:safeErrorMessage(e),code:e.code};
    }
  }

  async loadAll({rescan=false}={}){
    if(rescan)this.stopAll();
    const {found,errors}=scanModuleDirectory(config.modulesDir);
    this.scanErrors=errors.map(x=>({...x,error:safeErrorMessage(x.error)}));
    const knownIds=new Set(found.map(f=>f.manifest.id));
    for(const [id,mod] of [...this.modules]){
      if(rescan&&!knownIds.has(id)){if(mod.enabled&&mod.instance)this.unloadInstance(mod);this.modules.delete(id);}
    }
    found.sort((a,b)=>a.manifest.id.localeCompare(b.manifest.id));
    for(const item of found){
      const existing=this.modules.get(item.manifest.id);
      const enabled=this.state.modules?.[item.manifest.id]?.enabled!==false;
      const mod=existing??{
        id:item.manifest.id,
        enabled,
        instance:null,
        toolIndex:new Map(),
        dynamicTools:new Map(),
        pendingDynamic:[],
        lastError:null,
        lastErrorAt:null,
        logs:[],
        loadedAt:null
      };
      Object.assign(mod,{manifest:item.manifest,source:item.source,filename:item.filename,moduleDir:item.moduleDir});
      mod.enabled=enabled;
      this.modules.set(mod.id,mod);
      if(enabled&&!mod.instance){
        const ok=await this.instantiate(mod);
        if(ok){mod.loadedAt=new Date().toISOString();mod.lastError=null;}
      }else if(!enabled){mod.instance=null;mod.toolIndex=new Map();}
    }
    this.ready=true;
    this.engine?.syncFromRegistry(this);
    return this.listStatus();
  }

  unloadInstance(mod){
    if(!mod.instance)return;
    try{
      if(mod.manifest.hooks.includes("onUnload")){
        const hook=getHandler(mod.instance.exports,"hooks","onUnload");
        if(typeof hook==="function")callHook(hook,{}).catch(()=>{});
      }
    }catch{}
    mod.instance=null;
    mod.toolIndex=new Map();
  }

  stopAll(){for(const mod of this.modules.values())if(mod.enabled)this.unloadInstance(mod);}

  setEnabled(id,enabled){
    const mod=this.modules.get(id);
    if(!mod)return null;
    mod.enabled=Boolean(enabled);
    if(!this.state.modules[id])this.state.modules[id]={};
    this.state.modules[id].enabled=mod.enabled;
    persistState(this.state);
    if(mod.enabled&&!mod.instance){
      return this.instantiate(mod).then(ok=>{
        if(ok){mod.loadedAt=new Date().toISOString();mod.lastError=null;}
        this.engine?.syncFromRegistry(this);
        return this.describe(mod);
      });
    }
    if(!mod.enabled){this.unloadInstance(mod);this.engine?.syncFromRegistry(this);}
    return Promise.resolve(this.describe(mod));
  }

  describe(mod){
    return {
      id:mod.id,
      name:mod.manifest.name,
      version:mod.manifest.version,
      type:mod.manifest.type,
      description:mod.manifest.description,
      enabled:mod.enabled,
      loaded:Boolean(mod.instance),
      permissions:describePermissions(mod.manifest),
      tools:[...mod.toolIndex.keys()].sort().map(name=>{const e=mod.toolIndex.get(name);return {name,description:e.definition.description,dynamic:mod.dynamicTools.has(name)};}),
      hooks:mod.manifest.hooks,
      triggers:this.engine?this.engine.describeTriggers(mod):mod.manifest.triggers.map(t=>({...t,enabled:false,lastRunAt:null,nextRunAt:null})),
      last_error:mod.lastError,
      last_error_at:mod.lastErrorAt,
      loaded_at:mod.loadedAt
    };
  }

  listStatus(){
    return {
      modules_enabled:this.globallyEnabled,
      modules_dir:path.basename(config.modulesDir),
      modules:[
        ...[...this.modules.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(m=>this.describe(m))
      ],
      scan_errors:this.scanErrors
    };
  }
}

export const moduleRegistry=new ModuleRegistry();
