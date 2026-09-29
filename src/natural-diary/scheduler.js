import { config } from "../config.js";
import { companionTime } from "../time-service.js";
import { DEFAULT_HOUR, DEFAULT_MINUTE, enumerateLocalDates, isDiaryDue, shiftLocalDate, validLocalDate } from "./dates.js";
import { generateDiaryForDate } from "./generate.js";
import { duePendingDates, ensureDiaryOrigin, getDiaryEntry, getDiaryPending, touchDiaryTick } from "./store.js";

function maxAttempts(){return Math.max(1,Math.min(12,config.naturalDiaryMaxRetries));}

export class DiaryScheduler{
  constructor({
    enabled=config.naturalDiaryEnabled,
    now=()=>new Date(),
    tickMs=config.naturalDiaryTickMs,
    hour=config.naturalDiaryHour,
    minute=config.naturalDiaryMinute,
    catchupDays=config.naturalDiaryCatchupDays,
    generate=generateDiaryForDate,
    personaId=config.defaultPersonaId
  }={}){
    this.enabled=Boolean(enabled);
    this.now=now;
    this.tickMs=tickMs;
    this.hour=hour;
    this.minute=minute;
    this.catchupDays=catchupDays;
    this.generate=generate;
    this.personaId=personaId;
    this.timer=null;
    this.ticking=false;
    this.lastResult=null;
  }

  start(){
    if(!this.enabled||this.timer)return;
    // Offline tests set COMPANION_BLOCK_REAL_UPSTREAM=1. Do not race their mock
    // upstream with catch-up generation unless a test explicitly opts in.
    if(process.env.COMPANION_BLOCK_REAL_UPSTREAM==="1"&&process.env.COMPANION_NATURAL_DIARY_SCHEDULER!=="1")return;
    this.timer=setInterval(()=>this.tick().catch(error=>console.error("[diary]",error?.message??error)),this.tickMs);
    this.timer.unref?.();
    this.tick().catch(error=>console.error("[diary-startup]",error?.message??error));
  }

  stop(){
    if(this.timer)clearInterval(this.timer);
    this.timer=null;
  }

  dueDates(at=this.now()){
    const date=at instanceof Date?at:new Date(at);
    const today=companionTime.localDate(date);
    const meta=ensureDiaryOrigin(this.personaId,date);
    const origin=meta.origin_date_local;
    const lookback=shiftLocalDate(today,-(Math.max(1,Math.min(30,this.catchupDays))-1));
    const from=origin>lookback?origin:lookback;
    const todayDue=isDiaryDue(today,date,{hour:this.hour,minute:this.minute});
    const to=todayDue?today:shiftLocalDate(today,-1);
    if(from>to)return [];
    return enumerateLocalDates(from,to).filter(d=>!getDiaryEntry(d,this.personaId));
  }

  async tick(){
    if(!this.enabled||this.ticking)return this.lastResult;
    this.ticking=true;
    const at=this.now();
    try{
      touchDiaryTick(this.personaId,at);
      const missing=this.dueDates(at);
      const retry=duePendingDates(this.personaId,at)
        .filter(row=>validLocalDate(row.date_local)&&(row.attempts??0)<maxAttempts())
        .map(row=>row.date_local);
      const dates=[...new Set([...missing,...retry])].sort();
      const results=[];
      for(const dateLocal of dates){
        if(getDiaryEntry(dateLocal,this.personaId))continue;
        const pending=getDiaryPending(dateLocal,this.personaId);
        if(pending&&(pending.attempts??0)>=maxAttempts()){
          results.push({dateLocal,ok:false,reason:"max_retries"});
          continue;
        }
        const generated=await this.generate(dateLocal,{personaId:this.personaId,now:at});
        results.push({dateLocal,...generated});
      }
      this.lastResult={at:(at instanceof Date?at:new Date(at)).toISOString(),checked:dates,results};
      return this.lastResult;
    }finally{
      this.ticking=false;
    }
  }
}

export const diaryScheduler=new DiaryScheduler();
export function startDiaryScheduler(){diaryScheduler.start();}
export function stopDiaryScheduler(){diaryScheduler.stop();}
