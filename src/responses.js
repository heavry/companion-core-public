import { messageText } from "./utils.js";

function inputItems(input){
  if(typeof input==="string")return [{role:"user",content:input}];
  return Array.isArray(input)?input:[];
}

function responseToolCall(item){
  return {id:String(item.call_id??item.id??""),type:"function",function:{name:String(item.name??""),arguments:typeof item.arguments==="string"?item.arguments:JSON.stringify(item.arguments??{})}};
}

export function responsesInputToMessages(input){
  const messages=[];
  for(const item of inputItems(input)){
    if(!item||typeof item!=="object")continue;
    if(item.type==="function_call"){
      const previous=messages.at(-1);
      if(previous?.role==="assistant")previous.tool_calls=[...(previous.tool_calls??[]),responseToolCall(item)];
      else messages.push({role:"assistant",content:"",tool_calls:[responseToolCall(item)]});
      continue;
    }
    if(item.type==="function_call_output"){
      messages.push({role:"tool",tool_call_id:String(item.call_id??""),content:item.output??""});
      continue;
    }
    if(["system","developer","user","assistant"].includes(item.role))messages.push({role:item.role,content:item.content??""});
  }
  return messages;
}

export function messagesToResponsesInput(messages){
  const items=[];
  for(const message of messages??[]){
    if(!message||typeof message!=="object")continue;
    if(message.role==="tool"){
      items.push({type:"function_call_output",call_id:String(message.tool_call_id??""),output:message.content??""});
      continue;
    }
    if(["system","developer","user","assistant"].includes(message.role)&&messageText(message.content))items.push({role:message.role,content:message.content});
    if(message.role==="assistant"&&Array.isArray(message.tool_calls))for(const call of message.tool_calls){
      items.push({type:"function_call",call_id:String(call?.id??""),name:String(call?.function?.name??""),arguments:typeof call?.function?.arguments==="string"?call.function.arguments:JSON.stringify(call?.function?.arguments??{})});
    }
  }
  return items;
}

function outputText(item){
  if(item?.type!=="message"||!Array.isArray(item.content))return "";
  return item.content.filter(part=>part?.type==="output_text"||part?.type==="refusal").map(part=>String(part.text??part.refusal??"")).join("");
}

function reasoningText(item){
  if(item?.type!=="reasoning"||!Array.isArray(item.summary))return "";
  return item.summary.map(part=>String(part?.text??"")).filter(Boolean).join("\n");
}

export function responseAssistantMessage(response){
  const output=Array.isArray(response?.output)?response.output:[],text=output.map(outputText).filter(Boolean).join(""),reasoning=output.map(reasoningText).filter(Boolean).join("\n"),toolCalls=output.filter(item=>item?.type==="function_call").map(responseToolCall);
  if(!text&&!reasoning&&!toolCalls.length)return null;
  return {role:"assistant",content:text,reasoning_content:reasoning||undefined,tool_calls:toolCalls.length?toolCalls:undefined};
}

export function rewriteResponseModel(value,publicModel){
  if(!value||typeof value!=="object")return value;
  if(typeof value.model==="string")value.model=publicModel;
  if(value.response&&typeof value.response==="object"&&typeof value.response.model==="string")value.response.model=publicModel;
  return value;
}

export function responseStreamState(){return {text:"",reasoning:"",items:new Map(),terminal:false,completed:null,usage:null};}

export function observeResponseEvent(state,event){
  if(!event||typeof event!=="object")return;
  if(event.type==="response.output_text.delta"&&typeof event.delta==="string")state.text+=event.delta;
  if(event.type==="response.reasoning_summary_text.delta"&&typeof event.delta==="string")state.reasoning+=event.delta;
  if(event.type==="response.output_item.done"&&event.item)state.items.set(Number(event.output_index??state.items.size),event.item);
  if(["response.completed","response.failed","response.incomplete"].includes(event.type)){
    state.terminal=true;
    if(event.response){state.completed=event.response;state.usage=event.response.usage??state.usage;}
  }
  if(event.type==="error")state.terminal=true;
}

export function streamAssistantMessage(state){
  if(state.completed)return responseAssistantMessage(state.completed);
  const output=[...state.items.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1]),fromItems=responseAssistantMessage({output});
  if(fromItems)return fromItems;
  if(!state.text&&!state.reasoning)return null;
  return {role:"assistant",content:state.text,reasoning_content:state.reasoning||undefined};
}

export function normalizeResponsesInput(input){return inputItems(input);}

function normalizeChatContent(content){
  if(!Array.isArray(content))return content;
  const blocks=content.flatMap(part=>{
    if(!part||typeof part!=="object")return part==null?[]:[part];
    if((part.type==="input_text"||part.type==="text"||part.type==="output_text")&&typeof part.text==="string"){
      return part.text.trim()? [{...part,type:"text"}]:[];
    }
    return [part];
  });
  return blocks.length?blocks:undefined;
}

export function normalizeChatCompatibilityMessages(messages){
  return (messages??[]).map(message=>{
    if(!message||typeof message!=="object")return message;
    
    // 处理空字符串content
    if(typeof message.content==="string"&&message.content.trim()===""){
      // tool消息的空content可能需要特殊处理
      if(message.role==="tool"){
        // 保留tool消息，但设置一个占位符内容
        return {...message,content:"[empty]"};
      }
      // assistant消息的空content可以删除
      if(message.role==="assistant"){
        const copy={...message};delete copy.content;return copy;
      }
      // 其他角色的空content也删除
      const copy={...message};delete copy.content;return copy;
    }
    
    // 处理null或undefined content
    if(message.content===null||message.content===undefined){
      const copy={...message};delete copy.content;return copy;
    }
    
    // 处理数组content
    if(!Array.isArray(message.content))return message;
    const content=normalizeChatContent(message.content),copy={...message};
    if(content)copy.content=content;else delete copy.content;
    return copy;
  });
}
