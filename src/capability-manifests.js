const INSTALL_TYPES=new Set(["preset","mcp","native"]);
const TRANSPORTS=new Set(["stdio","http","native"]);
const RISK_CLASSES=new Set(["low","medium","high"]);

export const CUA_UPSTREAM=Object.freeze({
  repository:"https://github.com/trycua/cua",
  commit:"d114f35fec05ecd37bf529e5587be86852205b64",
  tag:"cua-driver-rs-v0.22.2",
  version:"0.22.2",
  license:"MIT",
  artifact:Object.freeze({
    url:"https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.22.2/cua-driver-rs-0.22.2-darwin-universal-binary.tar.gz",
    sha256:"0bc95dab9543eec416b1c840754eea8bc8a53a7ffcae93dfef7f1825a7938b84",
    maxBytes:50*1024*1024,
    files:Object.freeze(["cua-driver","cua-cursor-theme","libcua_driver_sdk.dylib","cua_driver_node_runtime.node","cua_driver_abi.h"])
  })
});

export const COMPUTER_USE_MANIFEST=Object.freeze({
  schemaVersion:1,
  id:"computer.use",
  displayName:"Computer Use",
  type:"preset",
  adapterType:"native",
  source:"known_github_descriptor",
  sourceUrl:CUA_UPSTREAM.repository,
  version:CUA_UPSTREAM.version,
  upstreamCommit:CUA_UPSTREAM.commit,
  license:CUA_UPSTREAM.license,
  entrypoint:"runtime/cua-driver",
  transport:"stdio",
  permissions:Object.freeze(["screen.read","mouse.control","keyboard.control","app.launch","window.control","file_ui_interaction"]),
  macOSPermissions:Object.freeze(["accessibility","screen_recording"]),
  riskClass:"medium",
  installSteps:Object.freeze(["compatibility","download","verify","extract","register","health_check"]),
  healthCheck:Object.freeze({kind:"cua_driver_cli",args:Object.freeze(["--version"]),expectedVersion:CUA_UPSTREAM.version}),
  uninstall:Object.freeze({kind:"remove_owned_install"}),
  configSchema:Object.freeze({type:"object",additionalProperties:false,properties:{}}),
  artifact:CUA_UPSTREAM.artifact,
  provenance:Object.freeze({publisher:"Cua AI, Inc.",publisherTeam:"YCK386LBJ7",trust:"companion_builtin_preset",descriptorVersion:1})
});

const MANIFESTS=new Map([[COMPUTER_USE_MANIFEST.id,COMPUTER_USE_MANIFEST]]);
export function knownCapabilityManifest(id){return MANIFESTS.get(String(id??""))??null;}
export function listKnownCapabilityManifests(){return [...MANIFESTS.values()];}

export function validateCapabilityManifest(value){
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("capability manifest must be an object");
  if(value.schemaVersion!==1)throw new Error("unsupported capability manifest schema");
  if(!/^[a-z][a-z0-9_.-]{2,79}$/.test(String(value.id??"")))throw new Error("invalid capability manifest id");
  if(!String(value.displayName??"").trim())throw new Error("capability displayName is required");
  if(!INSTALL_TYPES.has(value.type))throw new Error("invalid capability manifest type");
  if(!TRANSPORTS.has(value.transport))throw new Error("invalid capability manifest transport");
  if(!RISK_CLASSES.has(value.riskClass))throw new Error("invalid capability manifest risk class");
  if(!Array.isArray(value.permissions)||value.permissions.some(item=>typeof item!=="string"||!item.trim()))throw new Error("invalid capability permissions");
  if(!Array.isArray(value.installSteps)||value.installSteps.some(step=>!["compatibility","download","verify","extract","register","health_check","configure"].includes(step)))throw new Error("invalid or unbounded install step");
  if(value.type==="preset"){
    const artifact=value.artifact;
    if(!artifact||!/^https:\/\/github\.com\//.test(String(artifact.url??"")))throw new Error("preset artifact must be a pinned GitHub HTTPS URL");
    if(!/^[a-f0-9]{64}$/.test(String(artifact.sha256??"")))throw new Error("preset artifact checksum is required");
    if(!Number.isInteger(artifact.maxBytes)||artifact.maxBytes<=0||artifact.maxBytes>200*1024*1024)throw new Error("invalid artifact size bound");
    if(!Array.isArray(artifact.files)||!artifact.files.length||artifact.files.some(file=>!isSafeRelativePath(file)))throw new Error("invalid artifact allowlist");
  }
  if(value.type==="mcp"&&(!String(value.entrypoint??"").trim()||!value.sourceUrl))throw new Error("MCP manifest requires a controlled entrypoint and source URL");
  if(value.type==="native"&&value.provenance?.trust!=="approved_local_adapter")throw new Error("native adapters must use an approved local descriptor");
  if(/(?:curl|wget|\||;|&&|install\.sh|sh\s+-c)/i.test(JSON.stringify(value.installSteps)))throw new Error("shell installer steps are forbidden");
  return value;
}

export function isSafeRelativePath(value){
  const text=String(value??"");
  return Boolean(text)&&!text.startsWith("/")&&!text.includes("\\")&&!text.split("/").includes("..")&&!text.includes("\u0000");
}

validateCapabilityManifest(COMPUTER_USE_MANIFEST);
