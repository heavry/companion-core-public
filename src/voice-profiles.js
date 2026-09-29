import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

// Voice reference profiles for GPT-SoVITS. Default is neutral, never happy.
// Priority: timbre consistency > clean speech > emotion fit.

const PROFILES_DIR_DEFAULT=config.voiceProfilesDir;

export const VOICE_PROFILES=Object.freeze({
  neutral:{
    id:"neutral",
    reference_wav:"1_1_0092_speech.wav",
    prompt_text:"我没有说你的意思。",
    prompt_lang:"zh",
    notes:"默认。干净 speech，音色稳定，不带强制高兴。"
  },
  happy:{
    id:"happy",
    reference_wav:"1_9_0032_speech.wav",
    prompt_text:"我希望你时时刻刻都能够开心。",
    prompt_lang:"zh",
    notes:"高兴/兴奋；原1_9系列，配合输出端静音清理。"
  },
  low_energy:{
    id:"low_energy",
    reference_wav:"早晨起来的腻歪_0071_speech.wav",
    prompt_text:"啊，好啦，我累了。",
    prompt_lang:"zh",
    notes:"低能量/慵懒；需确认 speech 干净。"
  },
  annoyed:{
    id:"annoyed",
    reference_wav:"1_3_0097_speech.wav",
    prompt_text:"哼，不用见我，谁知道害人害己啊。",
    prompt_lang:"zh",
    notes:"轻度不耐烦；避免异常气声。"
  },
  angry:{
    id:"angry",
    reference_wav:"1_2_0081_speech.wav",
    prompt_text:"你现在说说我哪里不爱你了？",
    prompt_lang:"zh",
    notes:"明显生气；仅在 irritation/mood 真的达到时。"
  }
});

export function profileReference(profileId="neutral",dir=PROFILES_DIR_DEFAULT){
  const profile=VOICE_PROFILES[profileId]??VOICE_PROFILES.neutral;
  const file=path.join(dir,profile.reference_wav);
  if(!fs.existsSync(file)){
    const fallback=VOICE_PROFILES.neutral;
    const fallbackFile=path.join(dir,fallback.reference_wav);
    if(fs.existsSync(fallbackFile))return {style:fallback.id,ref_audio_path:fallbackFile,prompt_text:fallback.prompt_text,fallback:true,requested:profileId};
    return {style:profile.id,ref_audio_path:file,prompt_text:profile.prompt_text,fallback:false,requested:profileId};
  }
  return {style:profile.id,ref_audio_path:file,prompt_text:profile.prompt_text,fallback:false,requested:profileId};
}

function clamp(v,a,b){return Math.max(a,Math.min(b,Number(v)||0));}

/**
 * Presence → voice style with hysteresis so slight numeric noise does not
 * flip happy↔angry between bubbles.
 */
export function selectVoiceStyle({presence=null,previousStyle="neutral",bubbleIndex=0,text=""}={}){
  const src=presence&&typeof presence==="object"?presence:{};
  const dims=src.dimensions??src;
  const cur=key=>Number(dims?.[key]?.current??dims?.[key]??0);
  const mood=cur("mood"),energy=cur("energy"),irritation=cur("irritation");
  const playfulness=cur("playfulness"),social=cur("social_drive"),closeness=cur("closeness");
  const len=String(text??"").length;

  let target="neutral";
  let reason="default_neutral";
  if(irritation>=0.68||mood<=-0.55){target="angry";reason="high_irritation_or_low_mood";}
  else if(irritation>=0.38||mood<=-0.25){target="annoyed";reason="mid_irritation_or_low_mood";}
  else if(energy<=0.32){target="low_energy";reason="low_energy";}
  else if(mood>=0.35&&energy>=0.62){target="happy";reason="high_mood_energy";}
  else if(playfulness>=0.72&&mood>=0.2){target="happy";reason="playful_high";}
  else if(closeness>=0.85&&social>=0.8&&mood>=0.15){target="happy";reason="warm_close_social";}

  // hysteresis: keep previous style unless target is clearly stronger
  if(previousStyle&&previousStyle!==target&&bubbleIndex>0){
    const strength={neutral:0,happy:1,low_energy:1,annoyed:2,angry:3};
    const prev=strength[previousStyle]??0,next=strength[target]??0;
    if(Math.abs(next-prev)<=1&&!(target==="angry"&&(irritation>=0.75||mood<=-0.6))){
      return {style:previousStyle,reason:`hysteresis_keep_${previousStyle}`,target,metrics:{mood,energy,irritation,playfulness,social,closeness,len}};
    }
  }
  if(previousStyle&&previousStyle===target)reason=`stable_${target}`;
  // very short neutral-ish lines stay neutral unless strongly colored
  if(len<=2&&target==="happy"&&previousStyle!=="happy"&&bubbleIndex===0&&mood<0.55){
    target="neutral";reason="short_line_neutral";
  }
  return {style:target,reason,target:null,metrics:{mood,energy,irritation,playfulness,social,closeness,len}};
}

export function styleLogEntry({style,reason,presence,reference,fallback=false,ttsOk=null,text=""}){
  return {
    id:`vs_${crypto.randomBytes(6).toString("hex")}`,
    at:new Date().toISOString(),
    selectedStyle:style,
    reason,
    reference_wav:reference?.ref_audio_path??null,
    prompt_text:reference?.prompt_text??null,
    fallback_occurred:Boolean(fallback),
    tts_success:ttsOk,
    preview:String(text??"").slice(0,80),
    presence:{
      mood:presence?.dimensions?.mood?.current??null,
      energy:presence?.dimensions?.energy?.current??null,
      irritation:presence?.dimensions?.irritation?.current??null,
      playfulness:presence?.dimensions?.playfulness?.current??null,
      social_drive:presence?.dimensions?.social_drive?.current??null,
      closeness:presence?.dimensions?.closeness?.current??null
    }
  };
}

export function appendStyleLog(entry,file=path.join(config.voiceDir,"voice-style-log.jsonl")){
  try{
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.appendFileSync(file,JSON.stringify(entry)+"\n",{mode:0o600});
  }catch{}
}

export function clampPresenceValue(v){return clamp(v,0,1);}
