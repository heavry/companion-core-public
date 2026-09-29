import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { publishEvent } from "./events-bus.js";
import { uuid } from "./utils.js";

function atomicWrite(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.${uuid()}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}
}
function requiredText(value,label,max){const text=String(value??"").trim();if(!text||text.length>max)throw new Error(`${label} must be 1-${max} characters`);return text;}
function publicItem(item){return structuredClone(item);}

export class GuidanceQueueStore{
  constructor({file=config.guidanceQueuePath,now=()=>new Date(),emit=publishEvent,maxEntries=2000}={}){
    this.file=file;this.now=now;this.emit=emit;this.maxEntries=maxEntries;this.state={version:1,items:[]};this.load();
  }
  load(){
    if(!fs.existsSync(this.file))return;
    const value=JSON.parse(fs.readFileSync(this.file,"utf8"));
    if(value?.version!==1||!Array.isArray(value.items))throw new Error("invalid guidance queue state");
    this.state=value;
  }
  save(){
    const terminal=this.state.items.filter(item=>item.status!=="queued").slice(-this.maxEntries);
    const queued=this.state.items.filter(item=>item.status==="queued");
    this.state.items=[...terminal,...queued].sort((a,b)=>a.sequence-b.sequence);atomicWrite(this.file,this.state);
  }
  snapshot(sessionId){
    const session=requiredText(sessionId,"sessionId",200);
    const data=this.state.items.filter(item=>item.sessionId===session).sort((a,b)=>a.sequence-b.sequence).map(publicItem);
    return {generatedAt:this.now().toISOString(),sessionId:session,clearRule:"Pending guidance remains queued after agent completion and is consumed FIFO at the next safe model boundary.",data};
  }
  enqueue(sessionId,content){
    const session=requiredText(sessionId,"sessionId",200),text=requiredText(content,"content",4000),createdAt=this.now().toISOString();
    const sequence=(this.state.items.at(-1)?.sequence??0)+1;
    const item={id:uuid(),sessionId:session,content:text,status:"queued",sequence,createdAt,consumedAt:null,cancelledAt:null};
    this.state.items.push(item);this.save();this.emit("guidance.queued",{queueId:item.id,status:item.status,contentPreview:text.slice(0,160),createdAt},{sessionId:session});return publicItem(item);
  }
  cancel(sessionId,id){
    const session=requiredText(sessionId,"sessionId",200),queueId=requiredText(id,"queueId",200);
    const item=this.state.items.find(entry=>entry.id===queueId&&entry.sessionId===session);if(!item)return null;
    if(item.status!=="queued")return {ok:false,item:publicItem(item)};
    item.status="cancelled";item.cancelledAt=this.now().toISOString();this.save();this.emit("guidance.cancelled",{queueId:item.id,status:item.status,cancelledAt:item.cancelledAt},{sessionId:session});return {ok:true,item:publicItem(item)};
  }
  consume(sessionId){
    const session=requiredText(sessionId,"sessionId",200),consumedAt=this.now().toISOString();
    const items=this.state.items.filter(item=>item.sessionId===session&&item.status==="queued").sort((a,b)=>a.sequence-b.sequence);
    if(!items.length)return [];
    for(const item of items){item.status="consumed";item.consumedAt=consumedAt;}
    this.save();
    for(const item of items)this.emit("guidance.consumed",{queueId:item.id,status:item.status,consumedAt},{sessionId:session});
    return items.map(publicItem);
  }
  pendingCount(sessionId){return this.state.items.filter(item=>item.sessionId===sessionId&&item.status==="queued").length;}
}

export const guidanceQueue=new GuidanceQueueStore();
