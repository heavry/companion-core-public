import { knownCapabilityManifest } from "./capability-manifests.js";

const COMPUTER_TARGET=/(?:Computer\s*Use|computer\.use|Finder|访达|微信|WeChat|系统设置|System Settings|原生\s*(?:应用|App)|桌面|屏幕|窗口|鼠标|键盘|(?:这个|该)?(?:软件|应用|App)|file picker|文件选择器)/i;
const COMPUTER_ACTION=/(?:帮我|请|操作|控制|打开|启动|激活|切换|看看|查看|观察|截取|截图|点击|双击|移动|拖动|输入|键入|按下|快捷键|滚动|聚焦|选择|填写|完成)/i;
const BROWSER_INTENT=/(?:网页|网站|浏览器|Safari|Chrome|URL|https?:\/\/|Playwright)/i;
const NATIVE_OVERRIDE=/(?:Finder|访达|微信|WeChat|系统设置|System Settings|原生|桌面|file picker|文件选择器)/i;

export function taskNeedsComputerUse(messages){
  const list=Array.isArray(messages)?messages:[];
  const message=[...list].reverse().find(item=>item?.role==="user");
  const text=typeof message?.content==="string"?message.content:JSON.stringify(message?.content??"");
  if(!COMPUTER_TARGET.test(text)||!COMPUTER_ACTION.test(text))return {needed:false,reason:"no actionable native desktop intent"};
  if(BROWSER_INTENT.test(text)&&!NATIVE_OVERRIDE.test(text))return {needed:false,reason:"browser DOM capability is preferred"};
  return {needed:true,reason:"任务需要操作 macOS 原生应用、窗口或系统级界面；网页 DOM 之外应使用 computer.use。"};
}

export function discoverMissingCapabilities(messages,{installer=null}={}){
  const requirement=taskNeedsComputerUse(messages);
  if(!requirement.needed)return [];
  const state=installer?.status?.("computer.use")??{installed:false,enabled:false,health:"not_installed"};
  const installed=state.installed===true;
  return [{
    capability:"computer.use",
    status:installed?(state.enabled===false?"disabled":state.health==="ready"?"available":"installed"):"missing",
    reason:requirement.reason,
    installed,
    enabled:state.enabled===true,
    installable:Boolean(knownCapabilityManifest("computer.use")),
    installer:knownCapabilityManifest("computer.use")?"companion_builtin_preset":null,
    health:state.health??"not_installed"
  }];
}

export function discoverCapability(capability,{reason="当前任务需要此能力",installer=null,manifestLookup=knownCapabilityManifest}={}){
  const id=String(capability??""),manifest=manifestLookup(id),state=installer?.status?.(id)??{installed:false,enabled:false,health:"not_installed"};
  return {capability:id,status:state.installed?(state.enabled===false?"disabled":state.health==="ready"?"available":"installed"):"missing",reason:String(reason).slice(0,500),installed:state.installed===true,enabled:state.enabled===true,installable:Boolean(manifest),installer:manifest?"companion_builtin_preset":null,health:state.health??"not_installed"};
}
