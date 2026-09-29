const OBSERVATIONS=new Set(['take_screenshot','computer_screen_screenshot','computer_window_observe']);
export const isComputerAction=name=>/^computer_(?:mouse_|keyboard_|scroll$|window_focus$|app_launch$|app_activate$|file_open$)/.test(name);
const hasImage=result=>Array.isArray(result?.modelContent)&&result.modelContent.some(p=>p.type==='image_url');
export class ComputerUseLoop{
 constructor(){this.observedStep=-1;this.observedAt=0;}
 before(name,step){
  if(isComputerAction(name)&&(this.observedStep<0||this.observedStep>=step||Date.now()-this.observedAt>60000))throw Object.assign(new Error('Observe a fresh screenshot, reason about it in the next model turn, then act.'),{code:'COMPUTER_OBSERVATION_REQUIRED'});
 }
 async after(name,result,step,{screenshot}={}){
  if(OBSERVATIONS.has(name)&&result?.ok!==false&&hasImage(result)){this.observedStep=step;this.observedAt=Date.now();}
  if(!isComputerAction(name))return result;
  this.observedStep=-1;this.observedAt=0;
  if(result?.ok===false)return result;
  const verification=await screenshot();
  if(verification?.ok===false||!hasImage(verification))return {...result,ok:false,modelContent:JSON.stringify({action_completed:true,verified:false,error:'COMPUTER_VERIFICATION_REQUIRED',instruction:'Action may have happened. Do not replay blindly; obtain a new screenshot.'}),durableContent:'操作已执行，但截图验证失败；需要重新观察。'};
  // The next model turn sees the changed screen before it can choose another action.
  this.observedStep=step;this.observedAt=Date.now();
  return {...result,modelContent:[{type:'text',text:JSON.stringify({action_completed:true,verification:'Inspect the following fresh screenshot before claiming success or choosing another action.'})},...verification.modelContent],durableContent:'操作已执行，已重新截图供验证。'};
 }
}
