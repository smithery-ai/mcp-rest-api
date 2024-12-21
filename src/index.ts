#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosRequestConfig, Method } from 'axios';

if (!process.env.REST_BASE_URL) {
  throw new Error('REST_BASE_URL environment variable is required');
}
const AUTH_BASIC_USERNAME = process.env.AUTH_BASIC_USERNAME;
const AUTH_BASIC_PASSWORD = process.env.AUTH_BASIC_PASSWORD;
const AUTH_BEARER = process.env.AUTH_BEARER;
const AUTH_APIKEY_HEADER_NAME = process.env.AUTH_APIKEY_HEADER_NAME;
const AUTH_APIKEY_VALUE = process.env.AUTH_APIKEY_VALUE;

interface EndpointArgs {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  endpoint: string;
  body?: any;
  headers?: Record<string, string>;
}

const isValidEndpointArgs = (args: any): args is EndpointArgs => {
  if (typeof args !== 'object' || args === null) return false;
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(args.method)) return false;
  if (typeof args.endpoint !== 'string') return false;
  if (args.headers !== undefined && typeof args.headers !== 'object') return false;
  return true;
};

const hasBasicAuth = () => AUTH_BASIC_USERNAME && AUTH_BASIC_PASSWORD;
const hasBearerAuth = () => !!AUTH_BEARER;
const hasApiKeyAuth = () => AUTH_APIKEY_HEADER_NAME && AUTH_APIKEY_VALUE;

class RestTester {
  private server: Server;
  private axiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'rest-tester',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: process.env.REST_BASE_URL,
      validateStatus: () => true, // Allow any status code
    });

    this.setupToolHandlers();
    
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'endpoint',
          description: `Test a REST API endpoint and get detailed response information. 

Base URL: ${process.env.REST_BASE_URL}

Authentication: ${
  hasBasicAuth() ? 
    `Basic Auth with username: ${AUTH_BASIC_USERNAME}` :
  hasBearerAuth() ? 
    'Bearer token authentication configured' :
  hasApiKeyAuth() ? 
    `API Key using header: ${AUTH_APIKEY_HEADER_NAME}` :
    'No authentication configured'
}

The tool automatically:
- Normalizes endpoints (adds leading slash, removes trailing slashes)
- Handles authentication header injection
- Accepts any HTTP status code as valid
- Returns detailed response information including:
  * Full URL called
  * Status code and text
  * Response headers
  * Response body
  * Request details (method, headers, body)
  * Response timing
  * Validation messages

Error Handling:
- Network errors are caught and returned with descriptive messages
- Invalid status codes are still returned with full response details
- Authentication errors include the attempted auth method
`,
          inputSchema: {
            type: 'object',
            properties: {
              method: {
                type: 'string',
                enum: ['GET', 'POST', 'PUT', 'DELETE'],
                description: 'HTTP method to use',
              },
              endpoint: {
                type: 'string',
                description: 'Endpoint path (e.g. "/users"). Will be appended to base URL.',
              },
              body: {
                type: 'object',
                description: 'Optional request body for POST/PUT requests',
              },
              headers: {
                type: 'object',
                description: 'Optional request headers',
                additionalProperties: {
                  type: 'string',
                },
              },
            },
            required: ['method', 'endpoint'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'endpoint') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      if (!isValidEndpointArgs(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid test endpoint arguments'
        );
      }

      // Ensure endpoint starts with / and remove any trailing slashes
      const normalizedEndpoint = `/${request.params.arguments.endpoint.replace(/^\/+|\/+$/g, '')}`;
      
      // Initialize request config
      const config: AxiosRequestConfig = {
          method: request.params.arguments.method as Method,
          url: normalizedEndpoint,
          headers: request.params.arguments.headers || {},
        };

      // Add request body for POST/PUT
      if (['POST', 'PUT'].includes(request.params.arguments.method) && request.params.arguments.body) {
        config.data = request.params.arguments.body;
      }

      // Handle authentication based on environment variables
      if (hasBasicAuth()) {
        const base64Credentials = Buffer.from(`${AUTH_BASIC_USERNAME}:${AUTH_BASIC_PASSWORD}`).toString('base64');
        config.headers = {
          ...config.headers,
          'Authorization': `Basic ${base64Credentials}`
        };
      } else if (hasBearerAuth()) {
        config.headers = {
          ...config.headers,
          'Authorization': `Bearer ${AUTH_BEARER}`
        };
      } else if (hasApiKeyAuth()) {
        config.headers = {
          ...config.headers,
          [AUTH_APIKEY_HEADER_NAME as string]: AUTH_APIKEY_VALUE
        };
      }

      try {
        const startTime = Date.now();
        const response = await this.axiosInstance.request(config);
        const endTime = Date.now();
        const fullUrl = `${process.env.REST_BASE_URL}${normalizedEndpoint}`;

        // Determine auth method used
        let authMethod = 'none';
        if (hasBasicAuth()) authMethod = 'basic';
        else if (hasBearerAuth()) authMethod = 'bearer';
        else if (hasApiKeyAuth()) authMethod = 'apikey';

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                request: {
                  url: fullUrl,
                  method: config.method,
                  headers: config.headers,
                  body: config.data,
                  authMethod
                },
                response: {
                  statusCode: response.status,
                  statusText: response.statusText,
                  timing: `${endTime - startTime}ms`,
                  headers: response.headers,
                  body: response.data,
                },
                validation: {
                  isError: response.status >= 400,
                  messages: response.status >= 400 ? 
                    [`Request failed with status ${response.status}`] : 
                    ['Request completed successfully']
                }
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [
              {
                type: 'text',
              text: JSON.stringify({
                error: {
                  message: error.message,
                  code: error.code,
                  request: {
                    url: `${process.env.REST_BASE_URL}${normalizedEndpoint}`,
                    method: config.method,
                    headers: config.headers,
                    body: config.data
                  }
                }
              }, null, 2),
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('REST API Tester MCP server running on stdio');
  }
}

const server = new RestTester();
server.run().catch(console.error);
