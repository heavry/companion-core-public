import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-cognition-wake-"));
process.env.COMPANION_STATE_PATH=path.join(tmp,"state.json");
process.env.DATABASE_PATH=path.join(tmp,"companion.db");
process.env.EMBEDDING_ENABLED="false";
process.env.COMPANION_AUTONOMOUS_LIFE_STATE_PATH=path.join(tmp,"autonomous.json");

const assert=(value,message)=>{if(!value)throw new Error(`ASSERT: ${message}`);};
try{
  const {evaluateInactivityEligibility,INACTIVITY_WAKE_HOURS}=await import("../src/inactivity-proactive.js");
  assert(JSON.stringify(INACTIVITY_WAKE_HOURS)==="[6,12,20,30,40]","configured wake milestones are 6/12/20/30/40h");
  for(const hours of INACTIVITY_WAKE_HOURS){
    const state={lastUserInteractionAt:new Date("2026-09-01T00:00:00.000Z").toISOString()};
    const at=new Date(Date.parse(state.lastUserInteractionAt)+hours*3600_000);
    const wake=evaluateInactivityEligibility({state,at,hasSuitableContext:true});
    assert(wake.eligible,`${hours}h grants a cognition wake`);
    assert(wake.sendAllowed===false,`${hours}h wake does not authorize a message`);
    assert(wake.band===`${hours}h`,`${hours}h is the active wake milestone`);
    state.inactivity={lastCognitionWakeKey:wake.opportunityKey};
    const consumed=evaluateInactivityEligibility({state,at,hasSuitableContext:true});
    assert(consumed.eligible===false&&consumed.reason==="cognition_wake_already_used",`${hours}h opportunity is one-shot`);
  }
  const before=evaluateInactivityEligibility({state:{lastUserInteractionAt:"2026-09-01T00:00:00.000Z"},at:new Date("2026-09-01T05:59:00.000Z")});
  assert(before.eligible===false&&before.sendAllowed===false,"before six hours there is no wake or send");
  const noContext=evaluateInactivityEligibility({state:{lastUserInteractionAt:"2026-09-01T00:00:00.000Z"},at:new Date("2026-09-01T12:00:00.000Z"),hasSuitableContext:false});
  assert(noContext.eligible===false&&noContext.reason==="no_suitable_context","missing context does not create a wake");
  console.log("PASS Inactivity cognition wake: 6/12/20/30/40h milestones, one-shot opportunities, no direct send eligibility");
}finally{
  fs.rmSync(tmp,{recursive:true,force:true});
}
