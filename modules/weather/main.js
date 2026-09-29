// Weather Awareness Module —— Provider Adapter 模式（默认 open-meteo，无需 API key）。
// 位置来自 moduleInfo.config.location {label,lat,lon}，由用户在设置中显式配置。
// 事件只报告"显著变化"：rain_soon / temperature_drop / heat / snow / strong_wind；
// 去重由 Core 的 Event 幂等 + 本模块 lastSignature 双保险。

let lastSignature = "";

function cfg() {
  return (moduleInfo && moduleInfo.config) || {};
}

function baseUrl() {
  return String(cfg().baseUrl || "https://api.open-meteo.com/v1");
}

function location() {
  return cfg().location || null;
}

async function getJSON(path) {
  const res = await companion.network.fetch(`${baseUrl()}${path}`);
  if (!res.ok) throw new Error(`weather upstream ${res.status}`);
  return JSON.parse(res.body);
}

function locationQuery() {
  const loc = location();
  if (!loc || typeof loc.lat !== "number" || typeof loc.lon !== "number") {
    const e = new Error("weather location not configured; ask the user to set it in Companion settings");
    e.code = "WEATHER_NO_LOCATION";
    throw e;
  }
  return `latitude=${loc.lat}&longitude=${loc.lon}`;
}

function label() {
  return (location() && location().label) || "当前地区";
}

function wmoToText(code) {
  const map = { 0: "晴", 1: "基本晴", 2: "多云", 3: "阴", 45: "雾", 51: "毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨", 71: "小雪", 73: "中雪", 75: "大雪", 80: "阵雨", 95: "雷阵雨" };
  return map[code] ?? `天气代码 ${code}`;
}

function detectAlerts(current, hourly) {
  const alerts = [];
  if (hourly && Array.isArray(hourly.time)) {
    for (let i = 0; i < Math.min(6, hourly.time.length); i++) {
      const code = hourly.weather_code?.[i] ?? 0;
      const pop = hourly.precipitation_probability_max?.[i] ?? hourly.precipitation_probability?.[i] ?? 0;
      if ((code >= 51 && code <= 86) || Number(pop) >= 60) { alerts.push({ kind: "rain_soon", detail: `${hourly.time[i]} 降水概率约 ${pop}%` }); break; }
    }
    const t0 = current?.temperature_2m;
    const later = hourly.temperature_2m?.[Math.min(11, hourly.temperature_2m.length - 1)];
    if (typeof t0 === "number" && typeof later === "number" && t0 - later >= 8) alerts.push({ kind: "temperature_drop", detail: `未来 12 小时降温约 ${Math.round(t0 - later)}°C` });
    for (let i = 0; i < Math.min(12, hourly.time.length); i++) {
      const code = hourly.weather_code?.[i] ?? 0;
      if (code >= 71 && code <= 77) { alerts.push({ kind: "snow", detail: hourly.time[i] }); break; }
    }
    const wind = Math.max(...(hourly.wind_speed_10m?.slice(0, 12) ?? [0]));
    if (wind >= 40) alerts.push({ kind: "strong_wind", detail: `最大风速 ${Math.round(wind)} km/h` });
  }
  if (typeof current?.temperature_2m === "number" && current.temperature_2m >= 35) alerts.push({ kind: "heat", detail: `${current.temperature_2m}°C 高温` });
  return alerts;
}

async function fetchCurrent() {
  return getJSON(`/current?${locationQuery()}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`);
}
async function fetchHourly() {
  return getJSON(`/forecast?${locationQuery()}&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m&forecast_hours=12&timezone=auto`);
}
async function fetchDaily() {
  return getJSON(`/forecast?${locationQuery()}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3&timezone=auto`);
}

async function currentWeather() {
  const d = await fetchCurrent(), c = d.current ?? {};
  return { location: label(), temperature_c: c.temperature_2m ?? null, feels_like_c: c.apparent_temperature ?? null, humidity: c.relative_humidity_2m ?? null, wind_kmh: c.wind_speed_10m ?? null, condition: wmoToText(c.weather_code) };
}

async function hourlyForecast() {
  const d = await fetchHourly(), h = d.hourly ?? {}, out = [];
  for (let i = 0; i < Math.min(12, h.time?.length ?? 0); i++) {
    out.push({ time: h.time[i], temp_c: h.temperature_2m?.[i] ?? null, pop_percent: h.precipitation_probability?.[i] ?? null, condition: wmoToText(h.weather_code?.[i]) });
  }
  return { location: label(), hours: out };
}

async function dailyForecast() {
  const d = await fetchDaily(), dd = d.daily ?? {}, out = [];
  for (let i = 0; i < Math.min(3, dd.time?.length ?? 0); i++) {
    out.push({ date: dd.time[i], min_c: dd.temperature_2m_min?.[i] ?? null, max_c: dd.temperature_2m_max?.[i] ?? null, pop_percent: dd.precipitation_probability_max?.[i] ?? null, condition: wmoToText(dd.weather_code?.[i]) });
  }
  return { location: label(), days: out };
}

async function checkAlerts() {
  let payload;
  try {
    const [cur, hr] = await Promise.all([fetchCurrent(), fetchHourly()]);
    payload = { current: cur.current ?? {}, hourly: hr.hourly ?? {} };
  } catch (e) {
    if (e.code === "WEATHER_NO_LOCATION") return { event: null, note: "location not configured" };
    return { event: null, note: `upstream unavailable: ${e.message}` };
  }
  const alerts = detectAlerts(payload.current, payload.hourly);
  if (!alerts.length) { lastSignature = ""; return { event: null }; }
  const signature = alerts.map(a => a.kind).sort().join("|") + ":" + new Date().toISOString().slice(0, 13);
  if (signature === lastSignature) return { event: null, note: "duplicate_suppressed_locally" };
  lastSignature = signature;
  return {
    event: {
      content: `[weather] ${alerts.map(a => a.kind).join(",")} — ${alerts.map(a => a.detail).join(";")}（${label()}）`,
      importance: 0.75
    },
    alerts
  };
}

module.exports = {
  tools: {
    get_current_weather: currentWeather,
    get_hourly_forecast: hourlyForecast,
    get_daily_forecast: dailyForecast
  },
  triggers: {
    check_alerts: checkAlerts,
    weather_watchdog: checkAlerts
  }
};
