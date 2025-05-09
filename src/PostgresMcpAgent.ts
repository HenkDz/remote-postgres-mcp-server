import { McpAgent } from 'agents/mcp';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeDatabaseLogic, AnalyzeDatabaseInputSchema } from './tools/analyze';
import type { AnalysisResult } from './tools/analyze';

// Define the structure of your Durable Object's state
export interface PostgresMcpAgentState {
  isConfigured: boolean;
  dbConnectionString?: string;
}

// Define your worker's environment type (bindings from wrangler.jsonc)
// This 'Env' should align with 'worker-configuration.d.ts'
// For now, using a placeholder if Env is not globally resolved.
// Make sure tsconfig.json and wrangler setup correctly generate/include worker-configuration.d.ts
type Env = any; // Placeholder

export class PostgresMcpAgent extends McpAgent<Env, PostgresMcpAgentState, Record<string, never>> {
  public server: McpServer;
  private durableObjectId: string; // To store the ID from constructor

  constructor(state: DurableObjectState, env: Env) { 
    super(state, env);
    this.durableObjectId = state.id.toString(); // Store the ID
    this.server = new McpServer({
      name: "postgres-mcp-cloudflare-worker",
      version: "0.1.0",
    });
  }

  initialState: PostgresMcpAgentState = {
    isConfigured: false,
  };

  async init() {
    console.log(`PostgresMcpAgent Durable Object initialized. ID: ${this.durableObjectId}`);
    if (!this.server) {
      console.error("CRITICAL: this.server is NOT initialized in PostgresMcpAgent!");
      return;
    }

    this.registerConfigurePostgresTool();
    this.registerAnalyzeDatabaseTool();

    console.log("PostgresMcpAgent tools registered.");
  }

  private registerConfigurePostgresTool() {
    if (!this.server) return;
    const configShape = z.object({
      connectionString: z.string().min(1, { message: "Connection string cannot be empty." }),
    });

    this.server.tool(
      "configure_postgres_connection",
      "Configures the PostgreSQL connection string for the current session. This must be called before other database tools.",
      configShape.shape,
      async (input) => {
        // Input is already validated by the SDK against configShape
        await this.setState({
          ...this.state, // Persist existing state
          isConfigured: true,
          dbConnectionString: input.connectionString,
        });
        console.log(`PostgreSQL connection string configured for session ID: ${this.durableObjectId}`);
        return {
          content: [
            { type: "text", text: "PostgreSQL connection configured successfully for this session." },
          ],
        };
      }
    );
  }

  private registerAnalyzeDatabaseTool() {
    if (!this.server) return;

    this.server.tool(
      "pg_analyze_database",
      "Analyzes PostgreSQL database configuration, performance, and security. Reports on version, settings, metrics, and provides recommendations.",
      AnalyzeDatabaseInputSchema.shape,
      async (input: z.infer<typeof AnalyzeDatabaseInputSchema>) => {
        if (!this.state.isConfigured || !this.state.dbConnectionString) {
          return {
            content: [
              {
                type: "text",
                text: "Error: PostgreSQL connection is not configured. Please call 'configure_postgres_connection' first with a valid connection string.",
              },
            ],
            _meta: { isError: true },
          };
        }

        try {
          const result: AnalysisResult = await analyzeDatabaseLogic(
            this.state.dbConnectionString,
            input.analysisType
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
              {
                type: "text",
                text: `Database Analysis Result:\nVersion: ${result.version}\nSettings Sample: ${Object.entries(result.settings).slice(0,2).map(([k,v]) => `${k}: ${v}`).join(', ')}...\nMetrics Sample: Connections: ${result.metrics.connections}, Active Queries: ${result.metrics.activeQueries}, Cache Hit: ${(result.metrics.cacheHitRatio * 100).toFixed(2)}%\nRecommendations:\n- ${result.recommendations.join('\n- ')}`
              }
            ],
          };
        } catch (e: any) {
          console.error("[pg_analyze_database tool] Error:", e);
          return {
            content: [
              {
                type: "text",
                text: `Error during database analysis: ${e.message}`,
              },
            ],
            _meta: { isError: true },
          };
        }
      }
    );
  }
} 