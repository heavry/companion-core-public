// Provider-native web search 预留位：
// 当前上游是 OpenAI-compatible 中转（非 xAI 官方 api.x.ai），无法可靠验证
// search_parameters 等原生联网参数是否被透传。在拿到官方上游前，
// native 一律如实报告"未验证"，绝不伪造联网能力。
export const nativeSearchSupported = () => false;
