import pkg from 'pg';
import type { Pool as PoolType, PoolClient as PoolClientType, PoolConfig, QueryResultRow } from 'pg';
const { Pool } = pkg;

// Connection pool cache to reuse connections within a Durable Object instance context
const poolCache = new Map<string, PoolType>();

interface ConnectionOptions {
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeout?: number;
  queryTimeout?: number;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

interface ExtendedQueryConfig {
  text: string;
  values?: unknown[];
  timeout?: number;
  rowMode?: string;
}

export class DatabaseConnection {
  private pool: PoolType | null = null;
  private client: PoolClientType | null = null;
  private currentConnectionString: string = '';
  private lastError: Error | null = null;
  private connectionOptions: ConnectionOptions = {};

  public async connect(connectionString: string, options: ConnectionOptions = {}): Promise<void> {
    if (!connectionString) {
      throw new Error('No connection string provided.');
    }

    try {
      if (this.pool && this.currentConnectionString === connectionString) {
        if (!this.client || this.client.ended) {
            this.client = await this.pool.connect();
        }
        return;
      }

      if (this.pool) {
        await this.disconnect();
      }

      this.currentConnectionString = connectionString;
      this.connectionOptions = options;

      if (poolCache.has(connectionString)) {
        this.pool = poolCache.get(connectionString)!;
      } else {
        const config: PoolConfig = {
          connectionString: connectionString,
          max: options.maxConnections || 10,
          idleTimeoutMillis: options.idleTimeoutMillis || 10000,
          connectionTimeoutMillis: options.connectionTimeoutMillis || 5000,
          allowExitOnIdle: true,
          ssl: options.ssl
        };
        this.pool = new Pool(config);
        this.pool.on('error', (err: Error, clientRef: PoolClientType) => {
          console.error(`[DB Pool Error] Unexpected error on idle client for ${this.currentConnectionString}`, err, clientRef);
          this.lastError = err;
          if (err.message.includes('terminating connection due to administrator command') || 
              err.message.includes('SSL connection has been closed unexpectedly')) {
            poolCache.delete(this.currentConnectionString);
            if (this.pool) {
                this.pool.end().catch(e => console.error("[DB Pool Error] Failed to end pool on error", e));
                this.pool = null; 
            }
          }
        });
        poolCache.set(connectionString, this.pool);
      }

      this.client = await this.pool.connect();

      if (options.statementTimeout) {
        await this.client.query(`SET statement_timeout = ${options.statementTimeout}`);
      }
      await this.client.query('SELECT 1');
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      if (this.client) {
        this.client.release();
        this.client = null;
      }
      if (this.pool && !poolCache.has(this.currentConnectionString)) {
          poolCache.delete(this.currentConnectionString);
          await this.pool.end().catch(e => console.error("[DB Pool Error] Failed to end new pool on connect error", e));
          this.pool = null;
      }
      throw new Error(`Failed to connect to database (${this.currentConnectionString}): ${this.lastError.message}`);
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      this.client.release();
      this.client = null;
    }
    this.currentConnectionString = '';
  }

  public async query<T extends QueryResultRow = Record<string, unknown>>(
    text: string, 
    values: unknown[] = [],
    options: { timeout?: number } = {}
  ): Promise<T[]> {
    if (!this.client) {
      if (!this.pool || !this.currentConnectionString) {
        throw new Error('Not connected to database. Call connect() first.');
      }
      console.warn("[DB Query Warn] Client was null, attempting to get a new client from pool for", this.currentConnectionString);
      try {
          this.client = await this.pool.connect();
          if (this.connectionOptions.statementTimeout) {
              await this.client.query(`SET statement_timeout = ${this.connectionOptions.statementTimeout}`);
          }
      } catch (err) {
          this.lastError = err instanceof Error ? err : new Error(String(err));
          throw new Error(`Failed to re-establish client for query (${this.currentConnectionString}): ${this.lastError.message}`);
      }
    }

    try {
      const queryConfig: ExtendedQueryConfig = { text, values };
      if (options.timeout || this.connectionOptions.queryTimeout) {
        queryConfig.timeout = options.timeout || this.connectionOptions.queryTimeout;
      }
      const result = await this.client.query<T>(queryConfig);
      return result.rows;
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      if (error.message.includes('Connection terminated') || error.message.includes('connection closed')) {
          if (this.client) {
              this.client.release();
              this.client = null;
          }
      }
      throw new Error(`Query failed (${this.currentConnectionString}): ${this.lastError.message}`);
    }
  }

  public async queryOne<T extends QueryResultRow = Record<string, unknown>>(
    text: string, 
    values: unknown[] = [],
    options: { timeout?: number } = {}
  ): Promise<T | null> {
    const rows = await this.query<T>(text, values, options);
    return rows.length > 0 ? rows[0] : null;
  }

  public async queryValue<T>(
    text: string, 
    values: unknown[] = [],
    options: { timeout?: number } = {}
  ): Promise<T | null> {
    const rows = await this.query<Record<string, unknown>>(text, values, options);
    if (rows.length > 0) {
      const firstRow = rows[0];
      const firstValue = Object.values(firstRow)[0];
      return firstValue as T;
    }
    return null;
  }

  public async transaction<T>(callback: (client: PoolClientType) => Promise<T>): Promise<T> {
    if (!this.client) {
        if (!this.pool || !this.currentConnectionString) {
          throw new Error('Not connected to database for transaction. Call connect() first.');
        }
        console.warn("[DB Transaction Warn] Client was null, attempting to get a new client from pool for", this.currentConnectionString);
        try {
            this.client = await this.pool.connect();
            if (this.connectionOptions.statementTimeout) {
                await this.client.query(`SET statement_timeout = ${this.connectionOptions.statementTimeout}`);
            }
        } catch (err) {
            this.lastError = err instanceof Error ? err : new Error(String(err));
            throw new Error(`Failed to re-establish client for transaction (${this.currentConnectionString}): ${this.lastError.message}`);
        }
    }

    const dedicatedClient = this.client;
    try {
      await dedicatedClient.query('BEGIN');
      const result = await callback(dedicatedClient);
      await dedicatedClient.query('COMMIT');
      return result;
    } catch (error) {
      await dedicatedClient.query('ROLLBACK');
      this.lastError = error instanceof Error ? error : new Error(String(error));
      if (error.message.includes('Connection terminated') || error.message.includes('connection closed')) {
          if (this.client === dedicatedClient) {
              this.client.release();
              this.client = null;
          }
      }
      throw new Error(`Transaction failed (${this.currentConnectionString}): ${this.lastError.message}`);
    }
  }

  public getPool(): PoolType | null {
    return this.pool;
  }

  public getClient(): PoolClientType | null {
    return this.client;
  }

  public getLastError(): Error | null {
    return this.lastError;
  }

  public isConnected(): boolean {
    return !!this.client && !!this.pool && !this.client.ended;
  }

  public getConnectionInfo(): string {
    return this.currentConnectionString ? `Connected to ${this.currentConnectionString}` : 'Not connected';
  }

  public static async cleanupPools(): Promise<void> {
    console.log("[DB Pool Cleanup] Cleaning up all cached pools.");
    for (const [connString, pool] of poolCache.entries()) {
      try {
        await pool.end();
        poolCache.delete(connString);
        console.log(`[DB Pool Cleanup] Ended pool for ${connString}`);
      } catch (err) {
        console.error(`[DB Pool Cleanup] Error ending pool for ${connString}:`, err);
      }
    }
  }
} 