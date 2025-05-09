import app from "./app";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { PostgresMcpAgent } from "./PostgresMcpAgent";

// Export the OAuth handler as the default
export default new OAuthProvider({
	apiRoute: "/sse",
	// TODO: fix these types
	// @ts-ignore
	apiHandler: PostgresMcpAgent.mount("/sse"),
	// @ts-ignore
	defaultHandler: app,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});

// This export makes PostgresMcpAgent available as a Durable Object.
// The name 'PostgresMcpAgent' must match the 'class_name' in wrangler.jsonc.
export { PostgresMcpAgent };
