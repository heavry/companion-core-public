import crypto from "node:crypto";

// 通用远程 MCP OAuth provider：协议发现、DCR/静态 client id、PKCE、token
// refresh 均交给官方 MCP SDK。这里仅负责把 provider 状态持久化到 Integration
// 的 0600 secret store，并把授权 URL 交给 CompanionMac 打开。
export class IntegrationOAuthProvider {
  constructor({ integrationId, redirectUrl, configuredClientId = null, load, save }) {
    this.integrationId = integrationId;
    this._redirectUrl = redirectUrl;
    this.configuredClientId = configuredClientId;
    this.load = load;
    this.save = save;
    this.authorizationUrl = null;
  }

  get redirectUrl() { return this._redirectUrl; }
  get clientMetadata() {
    return {
      client_name: "Companion",
      redirect_uris: [String(this._redirectUrl)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  }

  async state() {
    const state = crypto.randomBytes(32).toString("base64url");
    this.save({ ...this.load(), state });
    return state;
  }

  clientInformation() {
    return this.load().clientInformation ?? (this.configuredClientId ? { client_id: this.configuredClientId } : undefined);
  }
  saveClientInformation(clientInformation) { this.save({ ...this.load(), clientInformation }); }

  tokens() { return this.load().tokens; }
  saveTokens(tokens) {
    const current = this.load();
    const previous = current.tokens ?? {};
    this.save({ ...current, tokens: { ...tokens, refresh_token: tokens.refresh_token ?? previous.refresh_token } });
  }

  redirectToAuthorization(url) { this.authorizationUrl = String(url); }
  saveCodeVerifier(codeVerifier) { this.save({ ...this.load(), codeVerifier }); }
  codeVerifier() {
    const verifier = this.load().codeVerifier;
    if (!verifier) throw new Error("OAuth PKCE verifier is missing");
    return verifier;
  }

  saveDiscoveryState(discoveryState) { this.save({ ...this.load(), discoveryState }); }
  discoveryState() { return this.load().discoveryState; }

  invalidateCredentials(scope) {
    const current = { ...this.load() };
    if (scope === "all" || scope === "client") delete current.clientInformation;
    if (scope === "all" || scope === "tokens") delete current.tokens;
    if (scope === "all" || scope === "verifier") delete current.codeVerifier;
    if (scope === "all" || scope === "discovery") delete current.discoveryState;
    if (scope === "all") delete current.state;
    this.save(current);
  }

  callbackState() { return this.load().state; }
  hasTokens() { return Boolean(this.load().tokens?.access_token); }
  clearPending() {
    const current = { ...this.load() };
    delete current.state;
    delete current.codeVerifier;
    this.save(current);
    this.authorizationUrl = null;
  }
}

export function oauthSecretValues(value) {
  const out = [];
  const walk = item => {
    if (typeof item === "string") { if (item.length >= 4) out.push(item); return; }
    if (Array.isArray(item)) { for (const child of item) walk(child); return; }
    if (item && typeof item === "object") for (const child of Object.values(item)) walk(child);
  };
  walk(value);
  return out;
}
