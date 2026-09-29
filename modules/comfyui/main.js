// ComfyUI Image Generation Module。
// 模型只给高级参数；workflow template 在此维护，绝不把节点图暴露给 LLM。
// 流程：POST /prompt → 轮询 /history/{id} → /view 拉图 → companion.media.save → mediaId。

let sequence = 0;
const jobs = new Map();

function cfg() {
  return (moduleInfo && moduleInfo.config) || {};
}
function baseUrl() {
  return String(cfg().baseUrl || "http://127.0.0.1:8188");
}

const SIZES = { "1:1": [768, 768], "3:4": [680, 904], "4:3": [904, 680], "16:9": [1024, 576] };
const STYLE_PROMPTS = {
  casual: "",
  anime: ", anime style, clean lineart",
  photo: ", photorealistic, natural lighting",
  illustration: ", digital illustration, soft colors"
};

function buildWorkflow({ prompt, negative_prompt = "", style = "casual", aspect_ratio = "1:1" }) {
  const [width, height] = SIZES[aspect_ratio] ?? SIZES["1:1"];
  const positive = String(prompt).slice(0, 800) + (STYLE_PROMPTS[style] ?? "");
  // 标准 txt2img 模板（CheckpointLoader → CLIPTextEncode ×2 → KSampler → VAEDecode → SaveImage）
  return {
    "3": { class_type: "KSampler", inputs: { seed: Math.floor(Math.random() * 1e9), steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: String(cfg().checkpoint || "v1-5-pruned-emaonly.safetensors") } },
    "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: String(negative_prompt || "").slice(0, 400), clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: `companion_${Date.now()}`, images: ["8", 0] } }
  };
}

async function submitJob(args) {
  const body = JSON.stringify({ prompt: buildWorkflow(args), client_id: `companion-${++sequence}` });
  const res = await companion.network.fetch(`${baseUrl().replace(/\/+$/, "")}/prompt`, {});
  // network.fetch 只支持 GET；提交用 POST 的能力通过 GET 化的本地代理不可行 ——
  // 因此这里使用 Core 提供的受控 POST 通道：
  const post = await companion.network.post(`${baseUrl().replace(/\/+$/, "")}/prompt`, { contentType: "application/json", body });
  if (!post.ok) throw new Error(`comfyui /prompt ${post.status}: ${String(post.body).slice(0, 200)}`);
  const parsed = JSON.parse(post.body);
  const jobId = parsed.prompt_id;
  jobs.set(jobId, { status: "queued", submittedAt: Date.now(), args });
  return { jobId, status: "queued" };
}

async function waitForJob(jobId) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const st = await getGenerationStatus({ jobId });
    if (st.status === "completed") return st;
    if (st.status === "failed") throw new Error(st.error || "generation failed");
  }
  throw new Error("comfyui generation timeout");
}

async function getGenerationStatus(args) {
  const jobId = String(args?.jobId ?? "");
  const job = jobs.get(jobId);
  if (!job) return { jobId, status: "unknown" };
  const hist = await companion.network.fetch(`${baseUrl().replace(/\/+$/, "")}/history/${jobId}`);
  if (!hist.ok) return { jobId, status: job.status };
  let history;
  try { history = JSON.parse(hist.body); } catch { return { jobId, status: job.status }; }
  const entry = history && history[jobId];
  if (!entry) return { jobId, status: job.status === "queued" ? "running" : job.status };
  const outputs = entry.outputs ?? {};
  for (const nodeId of Object.keys(outputs)) {
    const images = outputs[nodeId].images;
    if (Array.isArray(images) && images.length) {
      const img = images[0];
      const view = await companion.network.fetch(`${baseUrl().replace(/\/+$/, "")}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${encodeURIComponent(img.type || "output")}&binary=1`, { binary: true });
      if (!view.ok) throw new Error(`/view ${view.status}`);
      const saved = companion.media.save({ base64: view.body_base64, mime: (view.content_type || "image/png") });
      jobs.set(jobId, { ...job, status: "completed", mediaId: saved.mediaId });
      return { jobId, status: "completed", mediaId: saved.mediaId, mime: saved.mime };
    }
  }
  if (entry.status && entry.status.completed) { jobs.set(jobId, { ...job, status: "failed" }); return { jobId, status: "failed", error: "no outputs" }; }
  return { jobId, status: "running" };
}

async function generateImage(args) {
  if (!args?.prompt || !String(args.prompt).trim()) throw new Error("prompt is required");
  const submitted = await submitJob(args);
  const done = await waitForJob(submitted.jobId);
  return { jobId: done.jobId, status: done.status, mediaId: done.mediaId, mime: done.mime };
}

module.exports = {
  tools: {
    generate_image: generateImage,
    get_generation_status: getGenerationStatus
  }
};
