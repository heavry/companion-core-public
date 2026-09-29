export class NativeAgentPermissionError extends Error{
  constructor(message,{code="NATIVE_AGENT_PERMISSION_DENIED",decision="deny",capabilityId=""}={}){super(message);this.name="NativeAgentPermissionError";this.code=code;this.decision=decision;this.capabilityId=capabilityId;this.statusCode=decision==="ask"?409:403;}
}

export function baselineCapabilityDecision({capability,authorizedHighRisk=false}={}){
  if(!capability)return {kind:"deny",reason:"capability is not in the selected registry",failureCategory:"scope_denied"};
  if(capability.enabled===false)return {kind:"deny",reason:"capability is disabled",failureCategory:"capability_disabled"};
  if(![undefined,null,"available"].includes(capability.availability))return {kind:"deny",reason:"capability is unavailable or not configured",failureCategory:"not_configured"};
  if(capability.riskLevel==="high"&&!capability.requiresConfirmation&&!authorizedHighRisk)return {kind:"deny",reason:"high-risk action has no matching explicit action intent",failureCategory:"scope_denied"};
  return {kind:"allow"};
}

export async function assertCapabilityInvocation({lifecycle,capability,args,authorizedHighRisk=false,sessionId="",callId="",permissionStore=null,signal=null}={}){
  const baseline=baselineCapabilityDecision({capability,authorizedHighRisk});
  const outcome=await lifecycle.decide("PreToolUse",{sessionId,callId,capability:Object.freeze({...capability}),args:Object.freeze({...args}),baseline});
  const hookDecision=outcome.decision;
  if(capability?.requiresConfirmation&&!permissionStore)throw new NativeAgentPermissionError("explicit approval is required",{code:"NATIVE_AGENT_PERMISSION_REQUIRED",decision:"ask"});
  const policy=baseline.kind==="allow"&&permissionStore?permissionStore.policyDecision(sessionId,capability):baseline;
  const decision=baseline.kind==="deny"?baseline:hookDecision.kind==="deny"?hookDecision:policy.kind==="ask"?policy:hookDecision;
  if(decision.kind==="allow"){await lifecycle.dispatch("PermissionResolved",{sessionId,callId,capabilityId:capability?.capabilityId??capability?.id??"",decision:"allow"});return outcome;}
  const ask=decision.kind==="ask";
  if(ask&&permissionStore){
    await lifecycle.dispatch("PermissionRequest",{sessionId,callId,capabilityId:capability?.capabilityId??capability?.id??"",reason:decision.reason??"permission required"});
    const approval=await permissionStore.request({sessionId,callId,capability,args,reason:decision.reason,signal});
    await lifecycle.dispatch("PermissionResolved",{sessionId,callId,capabilityId:capability?.capabilityId??capability?.id??"",decision:approval.decision,action:approval.action,requestId:approval.request_id});
    return {...outcome,decision:approval.decision,approval,failureCategory:approval.decision==="deny"?"approval_denied":null};
  }
  if(ask)await lifecycle.dispatch("PermissionRequest",{sessionId,callId,capabilityId:capability?.capabilityId??capability?.id??"",reason:decision.reason??"permission required"});
  await lifecycle.dispatch("PermissionResolved",{sessionId,callId,capabilityId:capability?.capabilityId??capability?.id??"",decision:decision.kind});
  if(permissionStore)return {...outcome,decision:"deny",failureCategory:decision.failureCategory??"scope_denied",reason:decision.reason};
  throw new NativeAgentPermissionError(decision.reason??(ask?"permission required":"permission denied"),{code:ask?"NATIVE_AGENT_PERMISSION_REQUIRED":"NATIVE_AGENT_PERMISSION_DENIED",decision:decision.kind,capabilityId:capability?.capabilityId??capability?.id??""});
}
