import express from "express";
import fetch from "node-fetch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

// -----------------------------
// Utilities
// -----------------------------

const getRandomWord = () =>
  ["apple", "banana", "cherry"][Math.floor(Math.random() * 3)];

function logger(message: string) {
  const time = Date.now();
  console.log(`${time} - ${message}`);
}

// -----------------------------
// MCP Server Setup
// -----------------------------

function createMcpServer(sessionId: string) {
  const server = new McpServer(
    {
      name: "MCP SSE Server",
      version: "1.0.0",
    },
    { capabilities: { logging: {} } },
  );

  logger(`[MCP] [${sessionId}] MCP Server created.`);

  // --- Add Tool: add ---
  server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => {
    logger(`[MCP] [${sessionId}] [tool:add] Invoked with a=${a}, b=${b}`);
    return { content: [{ type: "text", text: String(a + b) }] };
  });

  // --- Add Tool: stream_numbers ---
  server.tool(
    "stream_numbers",
    { count: z.number() },
    async ({ count }, extra) => {
      logger(
        `[MCP] [${sessionId}] [tool:stream_numbers] Start streaming up to ${count}`,
      );

      let accumulator = "";
      for (let i = 1; i <= count; i++) {
        logger(
          `[MCP] [${sessionId}] [tool:stream_numbers] sending notification of count: ${i}`,
        );
        const value = i * 2;

        // Fire-and-forget → do NOT await
        // method: "notifications/progress",
        // params: {
        //   progressToken: "stream_numbers",
        //   progress: i,
        //   total: count,
        //   content: [{ type: "text", text: `${i}\n` }],
        extra
          .sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: { type: "text", text: `${value} ` },
            },
          })
          .catch((err) => {
            logger(
              `[MCP] [${sessionId}] [tool:stream_numbers] ERROR sending notification for ${i}: ${err}`,
            );
          });

        logger(
          `[MCP] [${sessionId}] [tool:stream_numbers] Streamed number ${i}`,
        );
        accumulator += `${value} `;

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      return { content: [{ type: "text", text: accumulator }] };
    },
  );

  // --- Add Tool: get_current_weather ---
  server.tool("get_current_weather", { city: z.string() }, async ({ city }) => {
    logger(`[MCP] [${sessionId}] [tool:get_current_weather] City=${city}`);
    const response = await fetch(`https://wttr.in/${city}`);
    const text = await response.text();
    return { content: [{ type: "text", text }] };
  });

  // --- Add Tool: get_secret_word ---
  server.tool("get_secret_word", {}, async () => {
    const word = getRandomWord();
    logger(`[MCP] [${sessionId}] [tool:get_secret_word] Word=${word}`);
    return { content: [{ type: "text", text: word }] };
  });

  return server;
}

// -----------------------------
// SSE Server Setup
// -----------------------------

const app = express();
app.use(express.json());

const transports: Record<string, SSEServerTransport> = {};
const servers: Record<string, McpServer> = {};

app.get("/sse", (req, res) => {
  const transport = new SSEServerTransport("/sse", res);
  const sessionId = transport.sessionId;

  transports[sessionId] = transport;

  logger(`[MCP] [${sessionId}] Client connected to /sse.`);

  res.on("close", () => {
    logger(`[MCP] [${sessionId}] Client disconnected from /sse.`);
    transport.close();
    delete transports[sessionId];

    const server = servers[sessionId];
    if (server) {
      server.close();
      delete servers[sessionId];
    }
  });

  const server = createMcpServer(sessionId);
  servers[sessionId] = server;

  // Fire and forget → do not block express route
  server.connect(transport).catch((err) => {
    console.error(`[MCP] [${sessionId}] MCP server error`, err);
  });
});

// Legacy POST (Python legacy support)
app.post("/sse", async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  const transport = sessionId && transports[sessionId];

  if (!transport) {
    logger(
      `[MCP] [unknown] Invalid legacy POST, missing sessionId=${sessionId}`,
    );
    res.status(400).send("Invalid or missing sessionId");
    return;
  }

  logger(`[MCP] [${sessionId}] Incoming legacy tool call on /sse.`);
  await transport.handlePostMessage(req, res, req.body);
});

// Modern POST (optional)
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  const transport = sessionId && transports[sessionId];

  if (!transport) {
    logger(
      `[MCP] [unknown] Invalid messages POST, missing sessionId=${sessionId}`,
    );
    res.status(400).send("Invalid or missing sessionId");
    return;
  }

  logger(`[MCP] [${sessionId}] Incoming tool call on /messages.`);
  await transport.handlePostMessage(req, res, req.body);
});

// -----------------------------
// Start server
// -----------------------------

app.listen(3000, () => {
  logger("\n✅ MCP SSE Server running:");
  logger("    SSE Notifications → http://localhost:3000/sse");
  logger(
    "    Legacy Tool Calls (POST) → http://localhost:3000/sse?sessionId=<id>",
  );
  logger(
    "    Modern Tool Calls (POST) → http://localhost:3000/messages?sessionId=<id>",
  );
});
