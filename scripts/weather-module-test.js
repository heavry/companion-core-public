import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const root=path.resolve(import.meta.dirname,".."),tmp=fs.mkdtempSync(path.join(os.tmpdir(),"companion-weather-"));
const modulesDir=path.join(tmp,"modules"),configDir=path.join(tmp,"modules-config");
process.env.COMPANION_API_KEY="weather-test-key-long-random";
process.env.DATABASE_PATH=path.join(tmp,"companion.db");
process.env.PERSONA_SYNC_ON_START="true";
process.env.EMBEDDING_ENABLED="false";
process.env.SUMMARY_EVERY_MESSAGES="9999";
process.env.COMPANION_MODULES_DIR=modulesDir;
process.env.COMPANION_MODULES_STATE_PATH=path.join(tmp,"modules-state.json");
process.env.COMPANION_MODULE_EXECUTION_LEDGER_PATH=path.join(tmp,"ledger.json");
process.env.COMPANION_MODULES_CONFIG_DIR=configDir;
process.env.UPSTREAM_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_API_KEY="";
process.env.UPSTREAM_CHAT_MODEL="x";process.env.UPSTREAM_AGENT_MODEL="x";
process.env.UPSTREAM_SECONDARY_BASE_URL="";process.env.UPSTREAM_SECONDARY_API_KEY="";process.env.UPSTREAM_SECONDARY_MODEL="";
process.env.UPSTREAM_PRIMARY_BASE_URL="";process.env.UPSTREAM_PRIMARY_API_KEY="";
process.env.UPSTREAM_AGENT_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_AGENT_API_KEY="";
process.env.UPSTREAM_CHAT_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_CHAT_API_KEY="";
process.env.UPSTREAM_SUMMARY_BASE_URL="http://127.0.0.1:9/v1";process.env.UPSTREAM_SUMMARY_API_KEY="";
process.env.COMPANION_BLOCK_REAL_UPSTREAM="1";

const assert=(v,m)=>{if(!v)throw new Error(`ASSERT: ${m}`);};

// Mock open-meteo 形状的上游
let RAINY=false,UP=true;
const weatherMock=http.createServer((req,res)=>{
  const u=new URL(req.url,`http://x`);
  const pathname=u.pathname.replace(/^\/v1/,""); // 兼容模块 baseUrl 以 /v1 结尾
  if(pathname==="/current"){
    if(!UP){res.writeHead(503);return res.end();}
    return res.end(JSON.stringify({current:{temperature_2m:RAINY?12:28,apparent_temperature:11,relative_humidity_2m:80,weather_code:RAINY?63:1,wind_speed_10m:9}}));
  }
  if(pathname==="/forecast"){
    const hours={},days={};
    hours.time=[];hours.temperature_2m=[];hours.precipitation_probability=[];hours.weather_code=[];hours.wind_speed_10m=[];
    for(let i=0;i<12;i++){hours.time.push(`2026-08-25T${String(i).padStart(2,"0")}:00`);hours.temperature_2m.push(RAINY?12-i*0.5:26+i*0.2);hours.precipitation_probability.push(RAINY?80:5);hours.weather_code.push(RAINY?63:1);hours.wind_speed_10m.push(RAINY?45:8);}
    days.time=["2026-08-25","2026-08-26","2026-08-27"];days.temperature_2m_max=[29,30,31];days.temperature_2m_min=[20,21,22];days.precipitation_probability_max=[10,10,10];days.weather_code=[1,2,1];
    return res.end(JSON.stringify({hourly:hours,daily:days}));
  }
  res.writeHead(404);res.end();
});

try{
  await new Promise(r=>weatherMock.listen(0,"127.0.0.1",r));
  const mockPort=weatherMock.address().port;
  // 本地 LLM 桩：heartbeat 的 event 候选通过门后会调用一次措辞模型
  let llmCalls=0;
  var llmMock=http.createServer((req,res)=>{
    llmCalls++;
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({choices:[{message:{role:"assistant",content:"外面下雨了，记得带伞～"}}]}));
  });
  await new Promise(r=>llmMock.listen(0,"127.0.0.1",r));
  const llmPort=llmMock.address().port;
  process.env.UPSTREAM_BASE_URL=`http://127.0.0.1:${llmPort}/v1`;
  process.env.UPSTREAM_CHAT_BASE_URL=process.env.UPSTREAM_BASE_URL;
  process.env.UPSTREAM_AGENT_BASE_URL=process.env.UPSTREAM_BASE_URL;
  process.env.UPSTREAM_SUMMARY_BASE_URL=process.env.UPSTREAM_BASE_URL;

  // 安装真实 weather 模块 + 配置指向 mock
  fs.cpSync(path.join(root,"modules/weather"),path.join(modulesDir,"weather"),{recursive:true});
  const testManifestPath=path.join(modulesDir,"weather/module.json");
  const testManifest=JSON.parse(fs.readFileSync(testManifestPath,"utf8"));
  testManifest.network_allowlist=[...testManifest.network_allowlist,"127.0.0.1"];
  fs.writeFileSync(testManifestPath,JSON.stringify(testManifest,null,2));
  fs.mkdirSync(configDir,{recursive:true});
  const writeCfg=cfg=>fs.writeFileSync(path.join(configDir,"weather.json"),JSON.stringify(cfg,null,2));
  writeCfg({baseUrl:`http://127.0.0.1:${mockPort}/v1`,location:{label:"测试城",lat:31.2,lon:121.4}});

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const {ensureDefaultPersona}=await import("../src/persona.js");
const {updateBehavior}=await import("../src/companion-state.js");
const te=await import("../src/modules/triggers.js");
  ensureDefaultPersona();
  const {moduleRegistry}=await import("../src/modules/registry.js");
  te.triggerEngine.attach(moduleRegistry);
  moduleRegistry.attachTriggerEngine(te.triggerEngine);
  await moduleRegistry.loadAll();

  const w=moduleRegistry.getModule("weather");
  assert(Boolean(w?.instance)===true&&w.toolIndex.has("get_current_weather"),"weather module loads with tools");

  // 当前天气
  {
    const raw=await moduleRegistry.executeModuleTool("get_current_weather",{});
    const parsed=JSON.parse(raw);
    assert(parsed.location==="测试城"&&parsed.condition.includes("中雨")===false,"current weather parses (sunny baseline)");
    assert(typeof parsed.temperature_c==="number","temperature numeric");
  }

  // 预报
  {
    const daily=JSON.parse(await moduleRegistry.executeModuleTool("get_daily_forecast",{}));
    assert(daily.days.length===3,"3-day forecast");
    const hourly=JSON.parse(await moduleRegistry.executeModuleTool("get_hourly_forecast",{}));
    assert(hourly.hours.length===12,"12-hour forecast");
  }

  // rain alert 触发 + 去重
  {
    RAINY=true;
    const handler=(()=>{const h=w.instance.exports.triggers.check_alerts;return async args=>{const {callModuleHandler}=await import("../src/modules/sandbox.js");return callModuleHandler(h,args);};})();
    const first=(await handler({})).value;
    assert(first?.event?.content?.includes("[weather] rain_soon"),"rain_soon alert generated");
    // 通过 Core 事件管线写入（含去重）
    const {insertEvent}=await import("../src/db.js");
    const ins1=insertEvent({personaId:"yuna",sessionId:null,source:"module:weather",content:first.event.content,importance:first.event.importance});
    assert(ins1===true,"weather event inserted");
    const second=(await handler({})).value;
    assert(second.event===null,"duplicate alert suppressed locally within the hour");
    const ins2=insertEvent({personaId:"yuna",sessionId:null,source:"module:weather",content:first.event.content,importance:first.event.importance});
    assert(ins2===false,"identical weather event deduped by core event pipeline");
  }

  // 上游不可达 → 工具失败但受控
  {
    UP=false;
    let failed=false;
    try{await moduleRegistry.executeModuleTool("get_current_weather",{});}catch(e){failed=/MODULE_TOOL_FAILED|upstream/.test(String(e.message));}
    assert(failed,"upstream outage surfaces controlled tool failure");
    UP=true;
  }

  // 位置未配置 → 明确错误而不是猜测位置
  {
    writeCfg({baseUrl:`http://127.0.0.1:${mockPort}/v1`}); // 无 location
    await moduleRegistry.loadAll({rescan:true});
    let denied=false;
    try{await moduleRegistry.executeModuleTool("get_current_weather",{});}catch(e){denied=/not configured/i.test(String(e.message));}
    assert(denied,"missing location yields explicit configuration error");
    writeCfg({baseUrl:`http://127.0.0.1:${mockPort}/v1`,location:{label:"测试城",lat:31.2,lon:121.4}});
    await moduleRegistry.loadAll({rescan:true});
    const ok=await moduleRegistry.executeModuleTool("get_current_weather",{});
    assert(ok.includes("测试城"),"reload after config restore works");
  }

  // ---------- RC2: Behavior Heartbeat 驱动的 Weather Watchdog ----------
  {
    RAINY=true;
    updateBehavior({weatherAwareness:true,weatherWatchdogEnabled:true,weatherWatchdogMinutes:45});
    const proactive=await import("../src/proactive.js");
    const state=await import("../src/companion-state.js");
    const {DatabaseSync}=await import("node:sqlite");
    const countEvents=()=>{const db=new DatabaseSync(process.env.DATABASE_PATH,{readOnly:true});try{return Number(db.prepare("SELECT COUNT(*) c FROM events WHERE content LIKE '[weather]%'").get().c);}finally{db.close();}};
    {const wdb=new DatabaseSync(process.env.DATABASE_PATH);try{wdb.exec("DELETE FROM events WHERE content LIKE '[weather]%'");}finally{wdb.close();}}
    const before=countEvents();assert(before===0,"clean slate for watchdog assertion");
    // 第一次 heartbeat：watchdog 到期 → 触发 check_alerts → rain_soon event 入库
    await proactive.runHeartbeat();
    await sleep(600);
    assert(countEvents()===before+1,"watchdog produced weather event via heartbeat");
    assert(state.getState().lastWeatherWatchdogAt,"watchdog timestamp persisted");
    // 立即再次 heartbeat：间隔未到 → 不重复
    state.getState().lastProactiveAt=null;state.saveState();
    const mid=countEvents();
    await proactive.runHeartbeat();
    await sleep(200);
    assert(countEvents()===mid,"watchdog cooldown prevents duplicate checks");
    // 关闭开关 → 即使时间到期也不检查
    state.getState().lastWeatherWatchdogAt=null;state.saveState();
    updateBehavior({weatherAwareness:false});
    await proactive.runHeartbeat();
    await sleep(200);
    assert(state.getState().lastWeatherWatchdogAt===null,"disabled watchdog skips entirely");
    updateBehavior({weatherAwareness:true});
  }

  console.log("\nPASS Weather Module: adapter config injection, current/hourly/daily tools, rain alert generation with local+core dedupe, upstream outage handling, explicit location requirement");
}catch(e){throw e;}finally{
  llmMock.close();
  weatherMock.close();
  fs.rmSync(tmp,{recursive:true,force:true});
}
