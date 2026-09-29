function mergeTool(map,tc){
  const index=Number(tc?.index??0),current=map.get(index)??{id:tc?.id,type:tc?.type??"function",function:{name:"",arguments:""}};
  if(tc?.id)current.id=tc.id;if(tc?.type)current.type=tc.type;
  if(tc?.function?.name)current.function.name+=String(tc.function.name);
  if(tc?.function?.arguments!==undefined)current.function.arguments+=typeof tc.function.arguments==="string"?tc.function.arguments:JSON.stringify(tc.function.arguments);
  map.set(index,current);
}

export async function consumeChatCompletionSse(response,{onChunk=async()=>{},signal}={}){
  const reader=response.body?.getReader();if(!reader)throw new Error("upstream stream body unavailable");
  const decoder=new TextDecoder(),tools=new Map();let buffer="",content="",reasoning="",usage=null,base={},finishReason=null,sawDone=false,sawTerminal=false;
  const abort=()=>{try{reader.cancel();}catch{}};signal?.addEventListener("abort",abort,{once:true});
  const frame=async raw=>{
    if(!raw.trim())return;
    const data=raw.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim()).join("\n");
    if(!data)return;if(data==="[DONE]"){sawDone=true;return;}
    let value;try{value=JSON.parse(data);}catch{throw new Error("upstream returned malformed SSE JSON");}
    if(value?.error)throw Object.assign(new Error(value.error.message??"upstream stream error"),{statusCode:502});
    base={...base,...Object.fromEntries(["id","object","created","model","system_fingerprint"].filter(key=>value[key]!==undefined).map(key=>[key,value[key]]))};
    const choice=value?.choices?.[0],delta=choice?.delta??{};
    if(typeof delta.content==="string")content+=delta.content;
    if(typeof delta.reasoning_content==="string")reasoning+=delta.reasoning_content;
    if(typeof delta.reasoning==="string")reasoning+=delta.reasoning;
    if(Array.isArray(delta.tool_calls))for(const call of delta.tool_calls)mergeTool(tools,call);
    if(choice?.finish_reason!==undefined&&choice.finish_reason!==null){finishReason=choice.finish_reason;sawTerminal=true;}
    if(value?.usage)usage=value.usage;
    await onChunk(value);
  };
  try{
    while(true){
      if(signal?.aborted)throw Object.assign(new Error("client cancelled"),{name:"AbortError"});
      const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let match;
      while((match=buffer.match(/\r?\n\r?\n/))){const end=match.index;await frame(buffer.slice(0,end));buffer=buffer.slice(end+match[0].length);}
    }
    buffer+=decoder.decode();if(buffer.trim())await frame(buffer);
  }finally{signal?.removeEventListener("abort",abort);}
  if(signal?.aborted)throw Object.assign(new Error("client cancelled"),{name:"AbortError"});
  if(!sawDone&&!sawTerminal)throw new Error("upstream SSE ended before terminal frame");
  const toolCalls=[...tools.entries()].sort((a,b)=>a[0]-b[0]).map(entry=>entry[1]);
  return {...base,choices:[{index:0,message:{role:"assistant",content,...(reasoning?{reasoning_content:reasoning}:{}),...(toolCalls.length?{tool_calls:toolCalls}:{})},finish_reason:finishReason??(toolCalls.length?"tool_calls":"stop")}],...(usage?{usage}: {})};
}
