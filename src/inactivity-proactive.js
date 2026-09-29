const HOUR_MS=60*60_000;

// Inactivity is a cognition wake opportunity, never a message reason.
export const INACTIVITY_WAKE_HOURS=Object.freeze([6,12,20,30,40]);
export const INACTIVITY_BANDS=Object.freeze(INACTIVITY_WAKE_HOURS.map(hours=>({
  id:`${hours}h`,minHours:hours,triggerReason:`cognition_wake_${hours}h`
})));

function finiteDate(value){const parsed=Date.parse(value??"");return Number.isFinite(parsed)?parsed:null;}

/**
 * Pure wake eligibility. Each inactivity milestone grants one cognition tick
 * for this period of silence. Callers must persist the returned opportunityKey
 * after considering it; this function never implies that a message should be
 * generated or delivered.
 */
export function evaluateInactivityEligibility({state={},at=new Date(),hasSuitableContext=true}={}){
  const atDate=at instanceof Date?at:new Date(at),nowMs=atDate.getTime();
  const lastMs=finiteDate(state.lastUserInteractionAt);
  if(!Number.isFinite(nowMs))throw new Error("invalid inactivity evaluation time");
  if(lastMs===null)return {eligible:false,reason:"missing_last_user_interaction",inactivityMs:null,inactivityHours:null,band:null,probability:0,opportunityKey:null,triggerAt:null,sendAllowed:false};

  const inactivityMs=Math.max(0,nowMs-lastMs),inactivityHours=inactivityMs/HOUR_MS;
  const threshold=INACTIVITY_WAKE_HOURS.filter(hours=>inactivityHours>=hours).at(-1)??null;
  if(threshold===null)return {eligible:false,reason:"before_first_cognition_wake",inactivityMs,inactivityHours,band:null,probability:0,opportunityKey:null,triggerAt:null,sendAllowed:false};

  const opportunityKey=`${new Date(lastMs).toISOString()}:${threshold}h`;
  const consumed=state.proactiveCognition?.lastWakeOpportunityKey===opportunityKey
    ||state.inactivity?.lastCognitionWakeKey===opportunityKey;
  const eligible=Boolean(hasSuitableContext&&!consumed);
  return {
    eligible,
    reason:!hasSuitableContext?"no_suitable_context":(consumed?"cognition_wake_already_used":`cognition_wake_${threshold}h`),
    inactivityMs,inactivityHours,band:`${threshold}h`,probability:eligible?1:0,
    opportunityKey,triggerAt:new Date(lastMs+threshold*HOUR_MS).toISOString(),sendAllowed:false
  };
}

export const evaluateInactivityCognitionWake=evaluateInactivityEligibility;
