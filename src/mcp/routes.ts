import type { FastifyInstance } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { audit } from '../catalog/service.js';
import { mcpIdentity, mcpScope } from './access.js';
import { mcpTools } from './tools.js';

if (!FormatRegistry.Has('uuid'))
  FormatRegistry.Set('uuid', (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  );

export function mcpRoutes(app: FastifyInstance, db: DB, config: Config) {
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    config: { rateLimit: { max: 180, timeWindow: '1 minute' } },
    async handler(req, reply) {
      reply.header('Cache-Control', 'no-store');
      if (req.headers.origin && !config.corsOrigins.includes(req.headers.origin))
        return reply.code(403).send({ error: 'Origin not allowed' });
      const bearer = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : '';
      const user = await mcpIdentity(db, bearer, `${config.publicUrl}/mcp`);
      if (!user) {
        reply.header(
          'WWW-Authenticate',
          `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp", scope="${mcpScope}"${bearer ? ', error="invalid_token"' : ''}`,
        );
        reply.code(401);
        return reply.send({
          error: 'invalid_token',
          error_description: 'Sign in with a Deadstick administrator account',
        });
      }
      if (req.method !== 'POST')
        return reply
          .code(405)
          .header('Allow', 'POST')
          .send({ error: 'Use POST for stateless Streamable HTTP' });
      const server = new Server(
        { name: 'deadstick', version: '0.1.0' },
        {
          capabilities: { tools: {} },
          instructions:
            'Deadstick 管理员工具。统一管理员授权；Telegram 页面配置、会话、更新与 Bot API 均不可操作。机场支持批量导入和删除。写操作前核对条目；投稿审核使用当前 revision；异常结论须附证据。订阅凭据加密且不在结果中回显。',
        },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: mcpTools.map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          annotations,
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const tool = mcpTools.find((item) => item.name === request.params.name);
        if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
        const args = request.params.arguments ?? {};
        if (!Value.Check(tool.inputSchema, args)) {
          const error = Value.Errors(tool.inputSchema, args).First();
          throw new McpError(
            ErrorCode.InvalidParams,
            `${error?.path || '/'}: ${error?.message ?? 'Invalid arguments'}`,
          );
        }
        let path = tool.path;
        for (const key of Object.keys(tool.params.properties))
          path = path.replace(`:${key}`, encodeURIComponent(String(args[key])));
        const query = new URLSearchParams();
        for (const key of Object.keys(tool.query.properties))
          if (args[key] !== undefined) query.set(key, String(args[key]));
        if (query.size) path += `?${query}`;
        const body = Object.fromEntries(
          Object.keys(tool.body.properties)
            .filter((key) => args[key] !== undefined)
            .map((key) => [key, args[key]]),
        );
        const response = await app.inject({
          method: tool.method,
          url: path,
          headers: { authorization: `Bearer ${bearer}` },
          ...(Object.keys(tool.body.properties).length ? { payload: body } : {}),
        });
        await audit(db, user.id, 'mcp.call', user.connection_id, {
          tool: tool.name,
          status: response.statusCode,
        });
        const result = response.json() as Record<string, unknown>;
        return {
          isError: response.statusCode >= 400,
          structuredContent: result,
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        await db.query('UPDATE mcp_connections SET last_used_at=now() WHERE id=$1', [
          user.connection_id,
        ]);
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers))
          if (typeof value === 'string' && name !== 'content-length') headers.set(name, value);
        const response = await transport.handleRequest(
          new Request(`${config.publicUrl}/mcp`, {
            method: 'POST',
            headers,
            body: JSON.stringify(req.body),
          }),
          { parsedBody: req.body },
        );
        return reply
          .code(response.status)
          .headers(Object.fromEntries(response.headers))
          .send(await response.text());
      } finally {
        await server.close();
      }
    },
  });
}
