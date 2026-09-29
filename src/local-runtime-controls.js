import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const DEFAULTS=Object.freeze({terminal:true,filesystem:true,self_maintenance:true,package_manager:true});
const KEYS=Object.freeze(Object.keys(DEFAULTS));

function atomicJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});
  fs.renameSync(temp,file);
}

export class LocalRuntimeControls{
  constructor({filePath=config.localRuntimeControlsPath}={}){this.filePath=path.resolve(filePath);this.state=this.load();this.listeners=new Set();}
  load(){
    try{
      const parsed=JSON.parse(fs.readFileSync(this.filePath,"utf8")),enabled={...DEFAULTS};
      for(const key of KEYS)if(typeof parsed?.enabled?.[key]==="boolean")enabled[key]=parsed.enabled[key];
      return {version:1,enabled,updated_at:parsed?.updated_at??null};
    }catch{return {version:1,enabled:{...DEFAULTS},updated_at:null};}
  }
  snapshot(){return {version:1,enabled:{...this.state.enabled},hard_safety_boundary:"active",updated_at:this.state.updated_at};}
  enabled(family){return this.state.enabled[String(family)]!==false;}
  onChange(listener){this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  update(patch={}){
    const source=patch?.enabled&&typeof patch.enabled==="object"?patch.enabled:patch,next={...this.state.enabled};
    for(const [key,value] of Object.entries(source??{})){
      if(!KEYS.includes(key))throw Object.assign(new Error(`unknown local runtime control: ${key}`),{code:"LOCAL_RUNTIME_CONTROL_UNKNOWN",statusCode:400});
      if(typeof value!=="boolean")throw Object.assign(new Error(`local runtime control ${key} must be boolean`),{code:"LOCAL_RUNTIME_CONTROL_INVALID",statusCode:400});
      next[key]=value;
    }
    this.state={version:1,enabled:next,updated_at:new Date().toISOString()};atomicJson(this.filePath,this.state);const snapshot=this.snapshot();for(const listener of this.listeners)try{listener(snapshot);}catch{}return snapshot;
  }
  assertEnabled(family){if(!this.enabled(family))throw Object.assign(new Error(`${family} was disabled in Agent Autonomy settings`),{code:"LOCAL_RUNTIME_DISABLED",statusCode:409,family});}
}

export const localRuntimeControls=new LocalRuntimeControls();
