// MCP wiring: example of registering Model Context Protocol servers with an
// Anthropic SDK / Agent SDK client so the agent can read from operational systems.
//
// In Claude Code, MCP servers are configured in settings.json and the agent talks
// to them transparently. This file documents the pattern for embedding MCP usage
// in a custom Agent SDK pipeline outside of Claude Code.

// Example MCP server definitions Andy uses in production. None are loaded here -
// this file is a reference for the shape of configuration. Adapt to the
// @modelcontextprotocol/sdk client you choose.

export const MCP_SERVERS_EXAMPLE = {
  airtable: {
    type: 'http',
    url: 'https://mcp.airtable.com/sse',
    description: 'Read/write Airtable bases for legal-contract tracking, vendor records.',
  },
  gmail: {
    type: 'http',
    url: 'https://mcp.claude.ai/gmail/sse',
    description: 'Read messages, search threads, label, snooze, draft replies.',
  },
  drive: {
    type: 'http',
    url: 'https://mcp.claude.ai/drive/sse',
    description: 'Read Drive files, search, fetch metadata.',
  },
  monday: {
    type: 'http',
    url: 'https://mcp.monday.com/sse',
    description: 'GraphQL queries + mutations against monday.com boards.',
  },
};

// In Claude Code, settings.json carries the full server list with auth tokens.
// In a custom SDK pipeline, you instantiate an MCP client per server and expose
// its tools to the model via the Anthropic SDK's `tools` array on each call.
//
// The pattern that matters: do not hand-roll integrations to operational systems.
// Use MCP servers so the agent gets first-class tool definitions and the auth
// boundary stays clean.
