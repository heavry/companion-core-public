import { companionTime } from "../time-service.js";

const DATE_RE=/^(\d{4})-(\d{2})-(\d{2})$/;

export const GENERATION_VERSION="natural-diary-v1";
export const DEFAULT_HOUR=23;
export const DEFAULT_MINUTE=30;

export function validLocalDate(value){
  const text=String(value??"").trim();
  const m=text.match(DATE_RE);
  if(!m)return false;
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
  if(month<1||month>12||day<1||day>31)return false;
  try{
    const parsed=companionTime.fromLocalParts({year,month,day,hour:12,minute:0,second:0});
    return companionTime.localDate(parsed)===text;
  }catch{return false;}
}

export function shiftLocalDate(dateLocal,days,time=companionTime){
  if(!validLocalDate(dateLocal))throw new Error("invalid local date");
  const noon=time.parseLocalDateTime(`${dateLocal}T12:00:00`);
  return time.localDate(new Date(noon.getTime()+Number(days)*86_400_000));
}

export function diaryDueAt(dateLocal,hour=DEFAULT_HOUR,minute=DEFAULT_MINUTE,time=companionTime){
  if(!validLocalDate(dateLocal))throw new Error("invalid local date");
  return time.parseLocalDateTime(`${dateLocal}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00`);
}

export function isDiaryDue(dateLocal,now=new Date(),{hour=DEFAULT_HOUR,minute=DEFAULT_MINUTE,time=companionTime}={}){
  return (now instanceof Date?now:new Date(now)).getTime()>=diaryDueAt(dateLocal,hour,minute,time).getTime();
}

export function localDayBounds(dateLocal,time=companionTime){
  return time.localDayBoundsToUTC(dateLocal);
}

export function enumerateLocalDates(fromDate,toDate){
  if(!validLocalDate(fromDate)||!validLocalDate(toDate))throw new Error("invalid local date range");
  if(fromDate>toDate)return [];
  const out=[];
  let cursor=fromDate;
  for(let i=0;i<400;i++){
    out.push(cursor);
    if(cursor===toDate)break;
    cursor=shiftLocalDate(cursor,1);
  }
  return out;
}
