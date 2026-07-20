export const metadata = {
  title: "ponylink-kb-mcp",
  description: "포니링크 지식베이스 MCP 서버",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
