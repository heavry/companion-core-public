// Module permission namespaces.
// enforced=true : v0.2.6 真正实现，bridge 会提供对应能力。
// enforced=false: 仅保留定义，默认拒绝；不向 module 暴露任何对应 API。
export const PERMISSIONS=Object.freeze([
  {name:"network.fetch",enforced:true},
  {name:"memory.read",enforced:true},
  {name:"memory.write",enforced:false},
  {name:"events.read",enforced:true},
  {name:"events.write",enforced:false},
  {name:"filesystem.project.read",enforced:false},
  {name:"filesystem.project.write",enforced:false},
  {name:"tool.register",enforced:true},
  {name:"media.write",enforced:true},
  {name:"system_prompt.inject",enforced:false},
  {name:"notification.send",enforced:false}
]);

export const PERMISSION_NAMES=new Set(PERMISSIONS.map(p=>p.name));
export const ENFORCED_PERMISSIONS=new Set(PERMISSIONS.filter(p=>p.enforced).map(p=>p.name));

export function hasPermission(manifest,name){
  return Array.isArray(manifest?.permissions)&&manifest.permissions.includes(name);
}

export function assertPermission(manifest,name){
  if(!hasPermission(manifest,name)){
    const e=new Error(`permission denied: ${name} (module did not declare it)`);
    e.code="PERMISSION_DENIED";e.permission=name;
    throw e;
  }
  if(!ENFORCED_PERMISSIONS.has(name)){
    const e=new Error(`permission denied: ${name} is defined but not enabled in this Core version`);
    e.code="PERMISSION_DENIED";e.permission=name;
    throw e;
  }
}

export function describePermissions(manifest){
  return PERMISSIONS.map(p=>({name:p.name,enforced:p.enforced,granted:hasPermission(manifest,p.name)}));
}
