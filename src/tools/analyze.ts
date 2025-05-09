import { DatabaseConnection } from '../utils/connection';
import { z } from 'zod';

// --- Types ---

export interface AnalysisResult {
  version: string;
  settings: Record<string, string>;
  metrics: {
    connections: number;
    activeQueries: number;
    cacheHitRatio: number;
    tableSizes: Record<string, string>;
  };
  recommendations: string[];
}

// --- Input Schema ---

export const AnalyzeDatabaseInputSchema = z.object({
  analysisType: z
    .enum(['configuration', 'performance', 'security'])
    .optional()
    .describe(
      'Type of analysis to perform (defaults to "configuration" if not specified)'
    ),
});

// --- Main Logic ---

export async function analyzeDatabaseLogic(
  connectionString: string,
  analysisTypeInput?: 'configuration' | 'performance' | 'security'
): Promise<AnalysisResult> {
  const typeToAnalyze: 'configuration' | 'performance' | 'security' =
    analysisTypeInput && ['configuration', 'performance', 'security'].includes(analysisTypeInput)
      ? analysisTypeInput
      : 'configuration';

  const db = new DatabaseConnection();
  await db.connect(connectionString);

  try {
    const version = await getVersion(db);
    const settings = await getSettings(db);
    const metrics = await getMetrics(db);
    const recommendations = await generateRecommendations(db, typeToAnalyze, settings, metrics);

    return {
      version,
      settings,
      metrics,
      recommendations,
    };
  } finally {
    await db.disconnect();
  }
}

// --- Helpers ---

async function getVersion(db: DatabaseConnection): Promise<string> {
  const result = await db.query<{ version: string }>('SELECT version()');
  return result[0]?.version ?? 'Unknown';
}

async function getSettings(db: DatabaseConnection): Promise<Record<string, string>> {
  const result = await db.query<{ name: string; setting: string; unit: string | null }>(
    'SELECT name, setting, unit FROM pg_settings WHERE name IN ($1, $2, $3, $4, $5)',
    [
      'max_connections',
      'shared_buffers',
      'work_mem',
      'maintenance_work_mem',
      'effective_cache_size',
    ]
  );
  return result.reduce((acc: Record<string, string>, row) => {
    acc[row.name] = row.unit ? `${row.setting}${row.unit}` : row.setting;
    return acc;
  }, {});
}

async function getMetrics(db: DatabaseConnection): Promise<AnalysisResult['metrics']> {
  const connections = await db.query<{ count: string }>('SELECT count(*) FROM pg_stat_activity');
  const activeQueries = await db.query<{ count: string }>(
    "SELECT count(*) FROM pg_stat_activity WHERE state = 'active'"
  );

  const cacheHit = await db.query<{ ratio: number }>(`
    WITH stats AS (
      SELECT
        COALESCE(blks_hit, 0) as hits,
        COALESCE(blks_read, 0) as reads
      FROM pg_stat_database
      WHERE datname = current_database()
    )
    SELECT
      CASE
        WHEN (hits + reads) = 0 THEN 0
        ELSE ROUND((COALESCE(hits,0)::float / (GREATEST(hits,0) + GREATEST(reads,0))::float)::numeric, 4) 
      END as ratio
    FROM stats
  `);
  const ratio = cacheHit[0]?.ratio ?? 0;

  const tableSizesResult = await db.query<{ tablename: string; size: string }>(`
    SELECT 
      tablename,
      pg_size_pretty(pg_table_size(quote_ident(schemaname) || '.' || quote_ident(tablename))) as size
    FROM pg_tables 
    WHERE schemaname = 'public' AND pg_table_size(quote_ident(schemaname) || '.' || quote_ident(tablename)) > 0
    ORDER BY pg_table_size(quote_ident(schemaname) || '.' || quote_ident(tablename)) DESC
    LIMIT 20
  `);

  const tableSizes = tableSizesResult.reduce((acc: Record<string, string>, row) => {
    acc[row.tablename] = row.size;
    return acc;
  }, {});

  return {
    connections: Number(connections[0]?.count || '0'),
    activeQueries: Number(activeQueries[0]?.count || '0'),
    cacheHitRatio: Number(ratio),
    tableSizes,
  };
}

async function generateRecommendations(
  db: DatabaseConnection,
  type: 'configuration' | 'performance' | 'security',
  settings: Record<string, string>,
  metrics: AnalysisResult['metrics']
): Promise<string[]> {
  const recommendations: string[] = [];

  if (type === 'configuration' || type === 'performance') {
    if (metrics.cacheHitRatio < 0.99 && metrics.cacheHitRatio > 0) {
      recommendations.push(
        `Low cache hit ratio (${(metrics.cacheHitRatio * 100).toFixed(
          2
        )}%). Consider increasing shared_buffers (currently ${settings.shared_buffers || 'N/A'}).`
      );
    }
    const maxConnectionsNum = Number.parseInt(settings.max_connections, 10);
    if (!Number.isNaN(maxConnectionsNum) && metrics.connections > maxConnectionsNum * 0.8) {
      recommendations.push(
        `High connection usage (${metrics.connections}/${maxConnectionsNum}). Consider increasing max_connections or implementing connection pooling.`
      );
    }
  }

  if (type === 'security') {
    const superusers = await db.query<{ usesuper: boolean; usename: string }>(
      'SELECT usesuper, usename FROM pg_user WHERE usesuper = true'
    );
    if (superusers.length > 1) {
      const superuserNames = superusers.map((u) => u.usename).join(', ');
      recommendations.push(
        `Multiple superuser accounts detected (${superuserNames}). Review and reduce if possible, adhering to the principle of least privilege.`
      );
    } else if (superusers.length === 0) {
      recommendations.push(
        'No superuser accounts found. This might be an issue if administrative tasks are needed.'
      );
    }

    // Try/catch in case ssl_is_used() is not available
    try {
      const ssl = await db.query<{ ssl_is_used: boolean }>('SELECT ssl_is_used() as ssl_is_used');
      if (!ssl[0]?.ssl_is_used) {
        recommendations.push(
          'SSL is not currently active for this connection. Ensure SSL is configured and enforced on the server for secure connections.'
        );
      }
    } catch {
      recommendations.push(
        'Could not determine SSL status (ssl_is_used() not available). Please verify SSL configuration manually.'
      );
    }
  }

  if (recommendations.length === 0) {
    recommendations.push(
      'No specific recommendations for the selected analysis type based on current metrics.'
    );
  }

  return recommendations;
}