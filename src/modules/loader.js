import fs from "node:fs";
import path from "node:path";
import { validateManifest } from "./validator.js";

// ModuleLoader：扫描 modules/ 目录，读取并校验 manifest 与 main.js。
// 单个目录的失败只影响该模块，不会中断整体扫描。

export function scanModuleDirectory(dir){
  const found=[],errors=[];
  let entries=[];
  try{entries=fs.readdirSync(dir,{withFileTypes:true});}
  catch(e){
    if(e?.code==="ENOENT")return {found,errors};
    errors.push({id:"<modules-dir>",error:`cannot read modules directory: ${e.message}`});
    return {found,errors};
  }
  for(const entry of entries){
    if(!entry.isDirectory())continue;
    const dirName=entry.name;
    const moduleDir=path.join(dir,dirName);
    try{
      const manifestPath=path.join(moduleDir,"module.json");
      if(!fs.existsSync(manifestPath)){errors.push({id:dirName,error:"missing module.json"});continue;}
      let rawManifest;
      try{rawManifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));}
      catch(e){errors.push({id:dirName,error:`module.json is not valid JSON: ${e.message}`});continue;}
      const manifest=validateManifest(rawManifest,{dirName});
      const mainPath=path.join(moduleDir,"main.js");
      if(!fs.existsSync(mainPath)){errors.push({id:dirName,error:"missing main.js"});continue;}
      const source=fs.readFileSync(mainPath,"utf8");
      if(source.length>1024*1024){errors.push({id:dirName,error:"main.js exceeds 1MB"});continue;}
      found.push({manifest,moduleDir,filename:mainPath,source});
    }catch(e){
      errors.push({id:dirName,error:e.message??String(e)});
    }
  }
  return {found,errors};
}
