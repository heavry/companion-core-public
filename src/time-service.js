export const COMPANION_TIME_ZONE="Asia/Shanghai";

const WEEKDAYS_ZH=["星期日","星期一","星期二","星期三","星期四","星期五","星期六"];
const formatterCache=new Map();

function formatter(timeZone){
  if(!formatterCache.has(timeZone))formatterCache.set(timeZone,new Intl.DateTimeFormat("en-CA",{
    timeZone,calendar:"gregory",numberingSystem:"latn",hourCycle:"h23",
    year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",weekday:"short"
  }));
  return formatterCache.get(timeZone);
}
function pad(value,length=2){return String(value).padStart(length,"0");}
function validDate(value){const date=value instanceof Date?new Date(value):new Date(value);if(Number.isNaN(date.getTime()))throw new Error("invalid date");return date;}
function normalizeLocalParts(value){
  const year=Number(value.year),month=Number(value.month),day=Number(value.day),hour=Number(value.hour??0),minute=Number(value.minute??0),second=Number(value.second??0),millisecond=Number(value.millisecond??0);
  if(![year,month,day,hour,minute,second,millisecond].every(Number.isInteger)||month<1||month>12||day<1||day>31||hour<0||hour>23||minute<0||minute>59||second<0||second>59||millisecond<0||millisecond>999)throw new Error("invalid local date-time");
  return {year,month,day,hour,minute,second,millisecond};
}
function weekdayIndex(value){return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(value);}

export class CompanionTimeService{
  constructor({clock=()=>new Date(),timeZone=COMPANION_TIME_ZONE}={}){
    formatter(timeZone).format(new Date());
    this.clock=clock;this.timeZone=timeZone;
  }
  now(){return validDate(this.clock());}
  nowUTC(){return this.now().toISOString();}
  nowLocal(){return this.localISO(this.now());}
  parts(value=this.now()){
    const date=validDate(value),raw=Object.fromEntries(formatter(this.timeZone).formatToParts(date).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
    return {year:Number(raw.year),month:Number(raw.month),day:Number(raw.day),hour:Number(raw.hour),minute:Number(raw.minute),second:Number(raw.second),weekday:weekdayIndex(raw.weekday),weekdayName:WEEKDAYS_ZH[weekdayIndex(raw.weekday)]};
  }
  localDate(value=this.now()){const p=this.parts(value);return `${pad(p.year,4)}-${pad(p.month)}-${pad(p.day)}`;}
  localMonth(value=this.now()){const p=this.parts(value);return `${pad(p.year,4)}-${pad(p.month)}`;}
  localTime(value=this.now(),{seconds=false}={}){const p=this.parts(value);return `${pad(p.hour)}:${pad(p.minute)}${seconds?`:${pad(p.second)}`:""}`;}
  weekday(value=this.now()){return this.parts(value).weekdayName;}
  dayPart(value=this.now()){
    const hour=this.parts(value).hour;
    if(hour<6)return "凌晨";if(hour<12)return "上午";if(hour<14)return "中午";if(hour<18)return "下午";return "晚上";
  }
  offsetMilliseconds(value=this.now()){
    const date=validDate(value),p=this.parts(date);
    return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(date.getTime()/1000)*1000;
  }
  localISO(value=this.now()){
    const date=validDate(value),p=this.parts(date),offset=this.offsetMilliseconds(date),sign=offset<0?"-":"+",minutes=Math.abs(Math.round(offset/60000));
    return `${pad(p.year,4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(minutes/60))}:${pad(minutes%60)}`;
  }
  toLocal(value){const date=validDate(value);return {timeZone:this.timeZone,iso:this.localISO(date),date:this.localDate(date),time:this.localTime(date),weekday:this.weekday(date),dayPart:this.dayPart(date),parts:this.parts(date)};}
  fromLocalParts(value){
    const p=normalizeLocalParts(value),wall=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second,p.millisecond);
    let candidate=new Date(wall-this.offsetMilliseconds(new Date(wall)));
    candidate=new Date(wall-this.offsetMilliseconds(candidate));
    const roundTrip=this.parts(candidate);
    if(roundTrip.year!==p.year||roundTrip.month!==p.month||roundTrip.day!==p.day||roundTrip.hour!==p.hour||roundTrip.minute!==p.minute||roundTrip.second!==p.second)throw new Error("local date-time does not exist in time zone");
    return candidate;
  }
  parseLocalDateTime(value){
    const match=String(value??"").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/);
    if(!match)throw new Error("invalid local date-time");
    return this.fromLocalParts({year:Number(match[1]),month:Number(match[2]),day:Number(match[3]),hour:Number(match[4]??0),minute:Number(match[5]??0),second:Number(match[6]??0),millisecond:Number(String(match[7]??"0").padEnd(3,"0"))});
  }
  localDayBoundsToUTC(localDate=this.localDate()){
    const match=String(localDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!match)throw new Error("invalid local date");
    const startParts={year:Number(match[1]),month:Number(match[2]),day:Number(match[3])},nextWall=new Date(Date.UTC(startParts.year,startParts.month-1,startParts.day+1));
    const start=this.fromLocalParts(startParts),end=this.fromLocalParts({year:nextWall.getUTCFullYear(),month:nextWall.getUTCMonth()+1,day:nextWall.getUTCDate()});
    return {start:start.toISOString(),end:end.toISOString()};
  }
  localMonthBoundsToUTC(localMonth=this.localMonth()){
    const match=String(localMonth).match(/^(\d{4})-(\d{2})$/);if(!match)throw new Error("invalid local month");
    const year=Number(match[1]),month=Number(match[2]);if(month<1||month>12)throw new Error("invalid local month");
    const nextWall=new Date(Date.UTC(year,month,1)),start=this.fromLocalParts({year,month,day:1}),end=this.fromLocalParts({year:nextWall.getUTCFullYear(),month:nextWall.getUTCMonth()+1,day:1});
    return {start:start.toISOString(),end:end.toISOString()};
  }
  formatDuration(milliseconds){
    const seconds=Math.max(0,Math.floor(Number(milliseconds)/1000));
    if(seconds<60)return `${seconds} 秒`;
    const minutes=Math.floor(seconds/60);if(minutes<60)return `${minutes} 分钟`;
    const hours=Math.floor(minutes/60),remainingMinutes=minutes%60;if(hours<24)return remainingMinutes?`${hours} 小时 ${remainingMinutes} 分钟`:`${hours} 小时`;
    const days=Math.floor(hours/24),remainingHours=hours%24;return remainingHours?`${days} 天 ${remainingHours} 小时`:`${days} 天`;
  }
}

export const companionTime=new CompanionTimeService();
