export async function captureExplicitScreenContext({explicit=false,observe=null}={}){
  if(explicit!==true){
    throw Object.assign(new Error("Ask Current Screen requires an explicit user action"),{code:"SCREEN_CONTEXT_NOT_EXPLICIT",statusCode:400});
  }
  const raw=typeof observe==="function"?await observe():{unavailable:true};
  const windows=Array.isArray(raw?.windows)?raw.windows.slice(0,8).map(window=>({
    app:String(window.app??window.bundle_id??"app").slice(0,80),
    title:String(window.title??"").slice(0,80),
    role:String(window.role??"").slice(0,40)
  })): [];
  return {
    ephemeral:true,
    persist:false,
    memory:false,
    screenshot:false,
    captured_at:new Date().toISOString(),
    frontmost:raw?.frontmost?String(raw.frontmost).slice(0,80):windows[0]?.app??null,
    windows,
    summary:windows.length?windows.map(window=>window.app+(window.title?` · ${window.title}`:"")).join("；").slice(0,400):"当前没有可用的只读屏幕摘要。",
    unavailable:raw?.unavailable===true
  };
}
