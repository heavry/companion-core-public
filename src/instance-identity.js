import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const ROLE_PATTERN=/^(local-primary|cloud-primary|cloud-test|development-test)$/;

function writeJsonAtomic(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(tmp,file);
}

function pidAlive(pid){
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(error){return error?.code==="EPERM";}
}

export class PrimaryInstanceLease{
  constructor({identityPath,lockPath,deploymentRole="local-primary",instanceId=null,now=()=>new Date(),hostname=()=>os.hostname(),pid=process.pid}={}){
    if(!ROLE_PATTERN.test(deploymentRole))throw new Error(`invalid COMPANION_DEPLOYMENT_ROLE: ${deploymentRole}`);
    this.identityPath=path.resolve(identityPath);
    this.lockPath=path.resolve(lockPath);
    this.deploymentRole=deploymentRole;
    this.instanceId=instanceId||null;
    this.now=now;
    this.hostname=hostname;
    this.pid=pid;
    this.bootId=crypto.randomUUID();
    this.acquired=false;
  }

  loadOrCreateIdentity(){
    if(this.instanceId)return this.instanceId;
    try{
      const parsed=JSON.parse(fs.readFileSync(this.identityPath,"utf8"));
      if(typeof parsed.instance_id==="string"&&parsed.instance_id.trim())return parsed.instance_id.trim();
    }catch{}
    const instanceId=crypto.randomUUID();
    writeJsonAtomic(this.identityPath,{schema_version:1,instance_id:instanceId,created_at:this.now().toISOString()});
    return instanceId;
  }

  metadata(){
    return {
      instance_id:this.instanceId,
      deployment_role:this.deploymentRole,
      boot_id:this.bootId
    };
  }

  acquire(){
    if(this.acquired)return this.metadata();
    this.instanceId=this.loadOrCreateIdentity();
    const record={schema_version:1,...this.metadata(),pid:this.pid,hostname:this.hostname(),started_at:this.now().toISOString()};
    fs.mkdirSync(path.dirname(this.lockPath),{recursive:true});
    for(let attempt=0;attempt<2;attempt++){
      try{
        const fd=fs.openSync(this.lockPath,"wx",0o600);
        fs.writeFileSync(fd,JSON.stringify(record,null,2));
        fs.closeSync(fd);
        this.acquired=true;
        return this.metadata();
      }catch(error){
        if(error?.code!=="EEXIST")throw error;
        let existing=null;
        try{existing=JSON.parse(fs.readFileSync(this.lockPath,"utf8"));}catch{}
        const sameHost=existing?.hostname===this.hostname();
        if(sameHost&&pidAlive(Number(existing?.pid))){
          const conflict=new Error(`primary instance conflict: ${existing?.deployment_role??"unknown"} pid=${existing?.pid??"unknown"}`);
          conflict.code="COMPANION_PRIMARY_CONFLICT";
          conflict.existing=existing;
          throw conflict;
        }
        const knownDeadLocalOwner=sameHost&&Number.isInteger(Number(existing?.pid))&&Number(existing.pid)>0;
        if(attempt===0&&knownDeadLocalOwner){
          const stale=`${this.lockPath}.stale-${Date.now()}`;
          try{fs.renameSync(this.lockPath,stale);}catch(renameError){
            const conflict=new Error(`cannot quarantine stale primary lock: ${renameError?.message??renameError}`);
            conflict.code="COMPANION_PRIMARY_LOCK_UNSAFE";
            throw conflict;
          }
          continue;
        }
        const unsafe=new Error(`primary lock cannot be proven stale: ${this.lockPath}`);
        unsafe.code="COMPANION_PRIMARY_LOCK_UNSAFE";
        unsafe.existing=existing;
        throw unsafe;
      }
    }
    throw new Error("unable to acquire primary instance lease");
  }

  release(){
    if(!this.acquired)return;
    try{
      const existing=JSON.parse(fs.readFileSync(this.lockPath,"utf8"));
      if(existing.boot_id===this.bootId&&Number(existing.pid)===this.pid)fs.unlinkSync(this.lockPath);
    }catch{}
    this.acquired=false;
  }
}

let singleton=null;
export function acquireConfiguredPrimaryLease(config){
  if(singleton)return singleton;
  singleton=new PrimaryInstanceLease({
    identityPath:config.instanceIdentityPath,
    lockPath:config.primaryLockPath,
    deploymentRole:config.deploymentRole,
    instanceId:config.instanceId||null
  });
  singleton.acquire();
  return singleton;
}
