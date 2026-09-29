const ROOT_COMBINATORS=["anyOf","oneOf","allOf"];

function clone(value){
  if(Array.isArray(value))return value.map(clone);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clone(item)]));
  return value;
}

function objectSchema(schema){return schema&&typeof schema==="object"&&!Array.isArray(schema);}
function requiredNames(schema){return Array.isArray(schema?.required)?schema.required.filter(name=>typeof name==="string"):[];}
function commonRequired(branches){
  if(!branches.length)return [];
  const [first,...rest]=branches.map(requiredNames);
  return first.filter(name=>rest.every(names=>names.includes(name)));
}
function mergedProperties(schema,branches){
  const properties={};
  for(const branch of branches)if(objectSchema(branch?.properties))for(const [name,value] of Object.entries(branch.properties))if(!Object.hasOwn(properties,name))properties[name]=clone(value);
  if(objectSchema(schema.properties))for(const [name,value] of Object.entries(schema.properties))properties[name]=clone(value);
  return properties;
}

function describeExclusiveBranches(out,branches){
  const choices=branches.map(requiredNames).filter(names=>names.length);
  if(choices.length<2)return;
  const rendered=choices.map(names=>names.join(" + ")).join(" OR ");
  const note=`Choose exactly one argument group: ${rendered}. Do not combine fields from different groups.`;
  out.description=[out.description,note].filter(Boolean).join("\n");
  for(const name of new Set(choices.flat())){
    const property=out.properties?.[name];
    if(!objectSchema(property))continue;
    property.description=[property.description,`Exclusive selector; use only its argument group (${rendered}).`].filter(Boolean).join(" ");
  }
}

export function xaiCompatibleRootObjectSchema(input){
  const schema=objectSchema(input)?input:{};
  const combinator=ROOT_COMBINATORS.find(key=>Array.isArray(schema[key]));
  const branches=combinator?schema[combinator].filter(objectSchema):[];
  const out=clone(schema);
  for(const key of ROOT_COMBINATORS)delete out[key];
  out.type="object";
  out.properties=mergedProperties(schema,branches);
  if(combinator==="oneOf")describeExclusiveBranches(out,branches);
  const rootRequired=requiredNames(schema),branchRequired=combinator==="allOf"?[...new Set(branches.flatMap(requiredNames))]:commonRequired(branches);
  const required=[...new Set([...rootRequired,...branchRequired])].filter(name=>Object.hasOwn(out.properties,name));
  if(required.length)out.required=required;else delete out.required;
  if(!objectSchema(input)||(!objectSchema(schema.properties)&&!branches.length)){
    out.properties={value:clone(input??{})};
    out.required=["value"];
  }
  return out;
}

export function providerCompatibilityProfile({model=""}={}){
  return /^(?:grok|xai)(?:[-_.]|$)/i.test(String(model).trim())?"xai":"generic-openai";
}

function normalizedFunctionTool(tool,profile){
  const out=clone(tool);
  if(profile!=="xai"||out?.type!=="function")return out;
  if(objectSchema(out.function))out.function.parameters=xaiCompatibleRootObjectSchema(out.function.parameters);
  else out.parameters=xaiCompatibleRootObjectSchema(out.parameters);
  return out;
}

export function normalizeProviderRequestTools(profile,body){
  const out=clone(body);
  if(!Array.isArray(out?.tools))return out;
  out.tools=out.tools.map(tool=>normalizedFunctionTool(tool,profile));
  return out;
}
