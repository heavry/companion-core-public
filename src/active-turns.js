import { uuid } from "./utils.js";

export const ACTIVE_TURN_STATUSES=Object.freeze(new Set([
  "queued","starting","streaming","tool_running","awaiting_approval","continuing"
]));
export const TERMINAL_TURN_STATUSES=Object.freeze(new Set([
  "completed","failed","cancelled","stopped","timed_out"
]));

function required(value,label){const text=String(value??"").trim();if(!text)throw new Error(`${label} required`);return text;}
function publicTurn(turn){return turn?structuredClone(turn):null;}

/**
 * Runtime-only source of truth for turns that can still consume queued guidance.
 * A restart intentionally restores no active turns; durable guidance remains in
 * GuidanceQueueStore and can be consumed by a later, genuinely active turn.
 */
export class ActiveTurnRegistry{
  constructor({now=()=>new Date(),id=uuid}={}){this.now=now;this.id=id;this.turns=new Map();}
  start(sessionId,{turnId=this.id(),status="starting",source="",model="",native=false}={}){
    const session=required(sessionId,"sessionId");if(!ACTIVE_TURN_STATUSES.has(status))throw new Error("invalid active turn status");
    const existing=this.turns.get(session);if(existing)throw Object.assign(new Error("session already has an active turn"),{code:"ACTIVE_TURN_EXISTS",statusCode:409,turn:publicTurn(existing)});
    const at=this.now().toISOString(),turn={turnId:String(turnId),sessionId:session,status,source:String(source??""),model:String(model??""),native:Boolean(native),startedAt:at,updatedAt:at};
    this.turns.set(session,turn);return publicTurn(turn);
  }
  update(sessionId,turnId,status){
    const session=required(sessionId,"sessionId"),turn=this.turns.get(session);if(!turn||turn.turnId!==String(turnId??""))return null;
    if(!ACTIVE_TURN_STATUSES.has(status))throw new Error("invalid active turn status");
    turn.status=status;turn.updatedAt=this.now().toISOString();return publicTurn(turn);
  }
  complete(sessionId,turnId,status="completed"){
    const session=required(sessionId,"sessionId"),turn=this.turns.get(session);if(!turn||turn.turnId!==String(turnId??""))return null;
    if(!TERMINAL_TURN_STATUSES.has(status))throw new Error("invalid terminal turn status");
    this.turns.delete(session);return {...publicTurn(turn),status,completedAt:this.now().toISOString()};
  }
  current(sessionId){return publicTurn(this.turns.get(String(sessionId??"").trim()));}
  isActive(sessionId){const turn=this.turns.get(String(sessionId??"").trim());return Boolean(turn&&ACTIVE_TURN_STATUSES.has(turn.status));}
  count(){return this.turns.size;}
}

export const activeTurns=new ActiveTurnRegistry();
