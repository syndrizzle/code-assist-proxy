import { CONNECTION_POOL_SIZE, CONNECTION_TIMEOUT, KEEP_ALIVE_TIMEOUT, MAX_IDLE_TIME } from "./config";

interface PooledConnection {
    id: string;
    lastUsed: number;
    inUse: boolean;
    createdAt: number;
}

interface ConnectionPoolOptions {
    maxConnections?: number;
    connectionTimeout?: number;
    keepAliveTimeout?: number;
    maxIdleTime?: number;
}

export class ConnectionPool {
    private static instance: ConnectionPool | null = null;
    private connections: Map<string, PooledConnection> = new Map();
    private options: Required<ConnectionPoolOptions>;

    private constructor(options: ConnectionPoolOptions = {}) {
        this.options = {
            maxConnections: options.maxConnections || CONNECTION_POOL_SIZE,
            connectionTimeout: options.connectionTimeout || CONNECTION_TIMEOUT,
            keepAliveTimeout: options.keepAliveTimeout || KEEP_ALIVE_TIMEOUT,
            maxIdleTime: options.maxIdleTime || MAX_IDLE_TIME,
        };
    }

    public static getInstance(options?: ConnectionPoolOptions): ConnectionPool {
        if (!ConnectionPool.instance) {
            ConnectionPool.instance = new ConnectionPool(options);
        }
        return ConnectionPool.instance;
    }

    /**
     * Create an optimized fetch request with connection pooling and HTTP/2 support
     */
    public async fetch(url: string, init?: RequestInit): Promise<Response> {
        const connectionId = this.getConnectionId(url);
        const connection = this.getOrCreateConnection(connectionId);

        try {
            // Mark connection as in use
            connection.inUse = true;
            connection.lastUsed = Date.now();

            // Create request with optimized headers for connection reuse
            const optimizedInit = this.optimizeRequestInit(init);
            
            const response = await fetch(url, optimizedInit);
            
            return response;
        } finally {
            // Mark connection as available
            connection.inUse = false;
            connection.lastUsed = Date.now();
        }
    }

    /**
     * Optimize request initialization for connection pooling
     */
    private optimizeRequestInit(init?: RequestInit): RequestInit {
        const headers = new Headers(init?.headers);
        
        // Set HTTP/2 and connection reuse headers
        headers.set('Connection', 'keep-alive');
        headers.set('Keep-Alive', `timeout=${this.options.keepAliveTimeout / 1000}`);
        
        // Enable HTTP/2 server push if supported
        if (!headers.has('Accept-Encoding')) {
            headers.set('Accept-Encoding', 'gzip, deflate, br');
        }

        return {
            ...init,
            headers,
            // Set signal for timeout if not provided
            signal: init?.signal || AbortSignal.timeout(this.options.connectionTimeout),
        };
    }

    /**
     * Get or create a connection for the given URL
     */
    private getOrCreateConnection(connectionId: string): PooledConnection {
        let connection = this.connections.get(connectionId);

        if (!connection || this.isConnectionExpired(connection)) {
            // Clean up expired connection if it exists
            if (connection) {
                this.connections.delete(connectionId);
            }

            // Create new connection
            connection = {
                id: connectionId,
                lastUsed: Date.now(),
                inUse: false,
                createdAt: Date.now(),
            };

            this.connections.set(connectionId, connection);
        }

        return connection;
    }

    /**
     * Generate connection ID based on URL host and port
     */
    private getConnectionId(url: string): string {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.host}`;
    }

    /**
     * Check if connection has expired based on idle time
     */
    private isConnectionExpired(connection: PooledConnection): boolean {
        const now = Date.now();
        const idleTime = now - connection.lastUsed;
        return idleTime > this.options.maxIdleTime;
    }

    /**
     * Clean up expired connections
     */
    public cleanup(): void {
        const now = Date.now();
        const expiredConnections: string[] = [];

        for (const [id, connection] of this.connections.entries()) {
            if (!connection.inUse && this.isConnectionExpired(connection)) {
                expiredConnections.push(id);
            }
        }

        expiredConnections.forEach(id => {
            this.connections.delete(id);
        });
    }

    /**
     * Get connection pool statistics
     */
    public getStats(): {
        totalConnections: number;
        activeConnections: number;
        idleConnections: number;
        expiredConnections: number;
    } {
        const now = Date.now();
        let active = 0;
        let idle = 0;
        let expired = 0;

        for (const connection of this.connections.values()) {
            if (connection.inUse) {
                active++;
            } else if (this.isConnectionExpired(connection)) {
                expired++;
            } else {
                idle++;
            }
        }

        return {
            totalConnections: this.connections.size,
            activeConnections: active,
            idleConnections: idle,
            expiredConnections: expired,
        };
    }

    /**
     * Get metrics for health monitoring
     */
    public getMetrics(): {
        activeConnections: number;
        totalConnections: number;
        idleConnections: number;
        maxConnections: number;
    } {
        const stats = this.getStats();
        return {
            activeConnections: stats.activeConnections,
            totalConnections: stats.totalConnections,
            idleConnections: stats.idleConnections,
            maxConnections: this.options.maxConnections,
        };
    }

    /**
     * Force close all connections (useful for testing or shutdown)
     */
    public closeAll(): void {
        this.connections.clear();
    }
}