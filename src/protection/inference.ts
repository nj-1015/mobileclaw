/**
 * MobileClaw Layer 4: Inference Gateway (Hot-Reloadable)
 *
 * Transparent OpenAI-compatible API server on localhost.
 * Agent thinks it's calling the real API; gateway routes to local or cloud.
 * Tracks costs with daily budget enforcement.
 */
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';

import { type InferenceProtection } from '../blueprints/schema.js';
import { logger } from '../logger.js';

interface CostEntry {
  timestamp: string;
  route: 'local' | 'cloud';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

// Approximate pricing per 1M tokens (input/output)
const CLOUD_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
  default: { input: 3.0, output: 15.0 },
};

export class InferenceGateway {
  private config: InferenceProtection;
  private server: http.Server | null = null;
  private dailyCosts: CostEntry[] = [];
  private agentName: string;
  private logDir: string;
  private costLogDate: string = '';

  constructor(config: InferenceProtection, agentName: string, logDir: string) {
    this.config = config;
    this.agentName = agentName;
    this.logDir = logDir;
    fs.mkdirSync(logDir, { recursive: true });
    this.loadTodayCosts();
  }

  /** Hot-reload routing config without restart */
  reloadConfig(newConfig: InferenceProtection): void {
    this.config = newConfig;
    logger.info({ agentName: this.agentName }, 'Inference config reloaded');
  }

  /** Start the gateway server */
  async start(): Promise<number> {
    const port = this.config.gateway_port;

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server!.address() as net.AddressInfo;
        logger.info(
          { port: addr.port, agentName: this.agentName },
          'Inference gateway started',
        );
        resolve(addr.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.flushCostLog();
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Collect request body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let parsed: Record<string, unknown> = {};
    try {
      if (body) parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // Decide routing
    const route = this.decideRoute(parsed);
    const model = (parsed.model as string) || '';

    // Budget check for cloud requests
    if (route === 'cloud' && this.wouldExceedBudget()) {
      if (this.config.primary?.engine === 'llama_cpp') {
        // Fall back to local
        logger.info(
          { agentName: this.agentName },
          'Budget exceeded, falling back to local',
        );
        this.routeToLocal(req, res, body);
        return;
      }
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            type: 'rate_limit_error',
            message: `Daily cloud budget exceeded ($${this.getTodaySpend().toFixed(2)} / $${this.config.cost_tracking?.max_cloud_cost_per_day_usd ?? 'unlimited'})`,
          },
        }),
      );
      return;
    }

    if (route === 'local') {
      this.routeToLocal(req, res, body);
    } else {
      this.routeToCloud(req, res, body, model);
    }
  }

  private decideRoute(request: Record<string, unknown>): 'local' | 'cloud' {
    if (!this.config.routing) return 'cloud';
    if (!this.config.primary || this.config.primary.engine !== 'llama_cpp')
      return 'cloud';

    // Estimate complexity by message length
    const messages = request.messages as
      | Array<{ content?: string }>
      | undefined;
    const totalLength =
      messages?.reduce((sum, m) => sum + (m.content?.length || 0), 0) || 0;

    // Simple heuristic: short messages → local, long → cloud
    if (totalLength < 500 && this.config.routing.simple_tasks === 'local') {
      return 'local';
    }
    if (totalLength >= 500 && this.config.routing.complex_tasks === 'cloud') {
      return 'cloud';
    }

    return this.config.routing.simple_tasks === 'local' ? 'local' : 'cloud';
  }

  private routeToLocal(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    _body: string,
  ): void {
    // Placeholder: local inference via llama.cpp
    // TODO: Forward to llama.cpp server when available
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          type: 'server_error',
          message:
            'Local inference engine not yet configured. Install llama.cpp and set model_path.',
        },
      }),
    );
  }

  private routeToCloud(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
    model: string,
  ): void {
    // Forward to the real Anthropic API
    const apiBase =
      process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const url = new URL(req.url || '/', apiBase);

    const proxyReq = http.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: req.method,
        headers: {
          ...req.headers,
          host: url.host,
        },
      },
      (proxyRes) => {
        // Collect response to estimate token usage
        let responseBody = '';
        proxyRes.on('data', (chunk) => {
          responseBody += chunk;
          res.write(chunk);
        });
        proxyRes.on('end', () => {
          res.end();
          // Track cost from response usage data
          this.trackCost(model, responseBody);
        });
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      },
    );

    proxyReq.on('error', (err) => {
      logger.error({ err, agentName: this.agentName }, 'Cloud proxy error');
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { type: 'proxy_error', message: err.message },
        }),
      );
    });

    proxyReq.write(body);
    proxyReq.end();
  }

  private trackCost(model: string, responseBody: string): void {
    try {
      const parsed = JSON.parse(responseBody);
      const usage = parsed.usage as
        | { input_tokens?: number; output_tokens?: number }
        | undefined;
      if (!usage) return;

      const pricing = CLOUD_PRICING[model] || CLOUD_PRICING.default;
      const inputCost = ((usage.input_tokens || 0) / 1_000_000) * pricing.input;
      const outputCost =
        ((usage.output_tokens || 0) / 1_000_000) * pricing.output;

      const entry: CostEntry = {
        timestamp: new Date().toISOString(),
        route: 'cloud',
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        costUsd: inputCost + outputCost,
        model,
      };

      this.dailyCosts.push(entry);

      if (this.dailyCosts.length % 10 === 0) {
        this.flushCostLog();
      }
    } catch {
      /* non-JSON response, skip */
    }
  }

  private wouldExceedBudget(): boolean {
    const maxCost = this.config.cost_tracking?.max_cloud_cost_per_day_usd;
    if (!maxCost || !this.config.cost_tracking?.enabled) return false;
    return this.getTodaySpend() >= maxCost;
  }

  getTodaySpend(): number {
    const today = new Date().toISOString().split('T')[0];
    return this.dailyCosts
      .filter((e) => e.timestamp.startsWith(today))
      .reduce((sum, e) => sum + e.costUsd, 0);
  }

  private loadTodayCosts(): void {
    const today = new Date().toISOString().split('T')[0];
    this.costLogDate = today;
    const logFile = path.join(this.logDir, `costs-${today}.jsonl`);
    if (!fs.existsSync(logFile)) return;

    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        this.dailyCosts.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }

  private flushCostLog(): void {
    if (this.dailyCosts.length === 0) return;
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(this.logDir, `costs-${today}.jsonl`);
    const newEntries = this.dailyCosts.filter((e) =>
      e.timestamp.startsWith(today),
    );
    // Rewrite today's file
    const lines = newEntries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(logFile, lines);
  }

  /** Get stats for status display */
  getStats(): {
    todaySpend: number;
    totalRequests: number;
    localRequests: number;
    cloudRequests: number;
  } {
    const today = new Date().toISOString().split('T')[0];
    const todayEntries = this.dailyCosts.filter((e) =>
      e.timestamp.startsWith(today),
    );
    return {
      todaySpend: todayEntries.reduce((s, e) => s + e.costUsd, 0),
      totalRequests: todayEntries.length,
      localRequests: todayEntries.filter((e) => e.route === 'local').length,
      cloudRequests: todayEntries.filter((e) => e.route === 'cloud').length,
    };
  }
}
