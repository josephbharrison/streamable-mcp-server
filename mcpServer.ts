// mcpServer.ts

import express from "express";
import { randomUUID } from "crypto";
import fetch from "node-fetch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Utilities
const getRandomWord = () =>
  ["apple", "banana", "cherry"][Math.floor(Math.random() * 3)];

// -----------------------------
// MCP Server Setup
// -----------------------------
function createMcpServer() {
  const server = new McpServer({
    name: "MCP Streamable HTTP Server",
    version: "1.0.0",
  });

  // --- Add Tool: add ---
  server.tool(
    "add",
    {
      a: z.number(),
      b: z.number(),
    },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }),
  );

  server.tool(
    "stream_numbers",
    { count: z.number() },
    async ({ count }, extra) => {
      for (let i = 1; i <= count; i++) {
        // Send stream content
        await extra.sendNotification({
          method: "notifications/message",
          params: {
            level: "info",
            content: [{ type: "text", text: `${i}\n` }],
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Final response (MUST be returned)
      return {
        content: [{ type: "text", text: "Done!" }],
      };
    },
  );

  // --- Add Tool: get_current_weather ---
  server.tool(
    "get_current_weather",
    {
      city: z.string(),
    },
    async ({ city }) => {
      const response = await fetch(`https://wttr.in/${city}`);
      const text = await response.text();
      return {
        content: [{ type: "text", text }],
      };
    },
  );

  // --- Add Tool: get_secret_word ---
  server.tool("get_secret_word", {}, async () => ({
    content: [{ type: "text", text: getRandomWord() }],
  }));

  return server;
}

// -----------------------------
// HTTP + Streamable HTTP transport setup
// -----------------------------
const app = express();
app.use(express.json());

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        transports[sessionId] = transport;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

const handleSessionRequest = async (
  req: express.Request,
  res: express.Response,
) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

app.listen(3000, () => {
  console.log("MCP Server listening on http://localhost:3000/mcp");
});
