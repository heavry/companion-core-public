export async function searchSearXNG({ query, maxResults, freshness, signal, searxngBase }) {
  const base = String(searxngBase ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("searxng base url missing");
  const params = new URLSearchParams({ q: query, format: "json" });
  const response = await fetch(`${base}/search?${params.toString()}`, { headers: { accept: "application/json" }, signal });
  if (!response.ok) {
    let detail="";try{detail=(await response.text()).slice(0,500);}catch{}
    throw Object.assign(new Error(`searxng ${response.status}${detail?`: ${detail}`:""}`),{statusCode:response.status,retryAfter:response.headers.get("retry-after")});
  }
  const data = await response.json();
  return Array.isArray(data?.results) ? data.results : [];
}
