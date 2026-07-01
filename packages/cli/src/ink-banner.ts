import React from "react";
import { Box, Text, render } from "ink";

function Banner({ line }: { line: string }) {
  return React.createElement(
    Box,
    { flexDirection: "column", borderStyle: "single", paddingX: 1 },
    React.createElement(Text, { bold: true }, "Machiai"),
    React.createElement(Text, null, line),
  );
}

export function renderInkBanner(line: string): void {
  if (!process.stdout.isTTY || process.env.MACHIAI_DISABLE_INK === "1") {
    console.log(`Machiai: ${line}`);
    return;
  }
  const app = render(React.createElement(Banner, { line }));
  setTimeout(() => app.unmount(), 800);
}
