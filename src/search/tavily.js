export async function searchTavily({ query, maxResults, freshness, signal, tavilyKey, tavilyBaseUrl }) {
  const base = String(tavilyBaseUrl ?? "https://api.tavily.com").replace(/\/+$/, "");
  const body = { api_key: tavilyKey, query, max_results: maxResults, search_depth: "basic", include_answer: false, include_raw_content: false };
  const response = await fetch(`${base}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    let detail="";try{detail=(await response.text()).slice(0,500);}catch{}
    throw Object.assign(new Error(`tavily ${response.status}${detail?`: ${detail}`:""}`),{statusCode:response.status,retryAfter:response.headers.get("retry-after")});
  }
  const data = await response.json();
  return Array.isArray(data?.results) ? data.results : [];
}
