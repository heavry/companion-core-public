import assert from "node:assert/strict";
import { computerUseToolSpecs } from "../src/computer-use-adapter.js";
import { normalizeProviderRequestTools,providerCompatibilityProfile } from "../src/provider-tool-schema.js";
import { validateToolArguments } from "../src/tool-compat.js";

const tools=computerUseToolSpecs(),strictRequest={model:"grok-4.6",tools},before=structuredClone(strictRequest);
const xai=normalizeProviderRequestTools(providerCompatibilityProfile({model:"grok-4.6"}),strictRequest);
const generic=normalizeProviderRequestTools(providerCompatibilityProfile({model:"deepseek-chat"}),strictRequest);
assert.deepEqual(strictRequest,before,"provider normalization never mutates Core strict schemas");
assert.deepEqual(generic,strictRequest,"generic OpenAI-compatible providers retain strict schemas");
for(const tool of xai.tools){const schema=tool.function.parameters;assert.equal(schema.type,"object",`${tool.function.name} has an object root`);for(const key of ["anyOf","oneOf","allOf"])assert.equal(key in schema,false,`${tool.function.name} omits root ${key}`);}

const strictClick=tools.find(tool=>tool.function.name==="computer_mouse_click"),xaiClick=xai.tools.find(tool=>tool.function.name==="computer_mouse_click");
assert.ok(strictClick.function.parameters.oneOf,"Core snapshot retains strict locator union semantics");
assert.equal(xaiClick.function.parameters.type,"object","xAI snapshot uses one object root");
for(const name of ["pid","element_token","element_index","snapshot_id","window_id","x","y","button","action","delivery_mode","session","target_description"])assert.ok(name in xaiClick.function.parameters.properties,`xAI click retains ${name}`);
assert.deepEqual(xaiClick.function.parameters.properties.button.enum,["left","right","middle"],"enums survive normalization");
assert.equal(xaiClick.function.parameters.properties.snapshot_id.pattern,"^s[0-9a-f]{8}$","nested string constraints survive normalization");
assert.equal(xaiClick.function.parameters.properties.target_description.description,strictClick.function.parameters.properties.target_description.description,"descriptions survive normalization");
assert.match(xaiClick.function.parameters.description,/Choose exactly one argument group/,"oneOf exclusivity survives as provider guidance");
assert.match(xaiClick.function.parameters.properties.element_token.description,/Exclusive selector/,"exclusive field guidance survives normalization");

const strictSchema=strictClick.function.parameters;
assert.deepEqual(validateToolArguments({pid:10,x:20,y:30},strictSchema),[],"coordinate locator passes strict validation");
assert.deepEqual(validateToolArguments({pid:10,element_token:"fresh-token"},strictSchema),[],"element token locator passes strict validation");
assert.deepEqual(validateToolArguments({pid:10,element_index:2,snapshot_id:"s1234abcd",window_id:9},strictSchema),[],"indexed locator passes strict validation");
assert.ok(validateToolArguments({pid:10},strictSchema).length,"missing locator fails strict validation");
assert.ok(validateToolArguments({pid:10,x:20,y:30,element_token:"also-present"},strictSchema).length,"multiple locators fail strict validation");
assert.ok(validateToolArguments({pid:"ten",x:20,y:30},strictSchema).length,"invalid types fail strict validation");
assert.ok(validateToolArguments({pid:10,x:20,y:30,unknown:true},strictSchema).length,"unknown fields fail strict validation");

const flatResponsesTool={type:"function",name:"root_union",description:"keep me",parameters:{oneOf:[{type:"object",properties:{left:{type:"string",description:"left value"}},required:["left"]},{type:"object",properties:{right:{type:"integer",minimum:1}},required:["right"]}]}};
const flat=normalizeProviderRequestTools("xai",{tools:[flatResponsesTool]}).tools[0];
assert.equal(flat.parameters.type,"object");assert.deepEqual(Object.keys(flat.parameters.properties),["left","right"]);assert.equal(flat.parameters.required,undefined);assert.equal(flat.description,"keep me");assert.equal(flat.parameters.properties.right.minimum,1);assert.match(flat.parameters.description,/left OR right/);

console.log("provider-tool-schema-test: ok");
