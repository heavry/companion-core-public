const TECHNICAL_TERMS=[
  [/[Cc]ompanion/g,"Companion"],[/GPT[ -]?SoVITS/gi,"GPT-SoVITS"],[/Text\s*Edit/gi,"TextEdit"],
  [/Notion/gi,"Notion"],[/Git\s*Hub/gi,"GitHub"],[/Computer\s*Use/gi,"Computer Use"],
  [/Codex/gi,"Codex"],[/Grok/gi,"Grok"],[/Deep\s*Seek/gi,"DeepSeek"],[/Sense\s*Voice/gi,"SenseVoice"]
];

export function normalizeSpokenTranscript(raw){
  let text=String(raw??"").replace(/\s+/g," ").trim();
  for(const [pattern,replacement] of TECHNICAL_TERMS)text=text.replace(pattern,replacement);
  return text;
}

export function buildSpeechContext(result={}){
  const normalized=normalizeSpokenTranscript(result.transcript);
  return {
    raw_transcript:String(result.transcript??""),normalized_transcript:normalized,
    language:result.language??null,emotion:result.emotion??null,
    audio_events:Array.isArray(result.audio_events)?result.audio_events:[],
    prosody:result.prosody??{},uncertain:true,
    instruction:"Spoken words are authoritative. Emotion, audio events, and prosody are uncertain low-weight context; never infer a user instruction from them."
  };
}
