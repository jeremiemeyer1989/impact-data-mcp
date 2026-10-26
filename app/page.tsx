// Home page for someone opening the server in a browser.
// It says what the server is and where the MCP endpoint lives. There is no dashboard.

export default function HomePage() {
  return (
    <main>
      <h1>Impact Data</h1>
      <p>
        This server stores impact indicators, compares whether two definitions
        measure the same thing, and groups similar indicators together.
      </p>
      <p>
        The MCP endpoint is <code>/api/mcp</code>. Send the API key in the
        Authorization header as a Bearer token.
      </p>
    </main>
  );
}
