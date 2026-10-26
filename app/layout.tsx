// Page shell for the short public home page.
// The MCP server itself lives at /api/mcp. This layout only sets the title.

import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Impact Data MCP",
  description: "MCP server for searching, comparing, and clustering impact indicators.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
