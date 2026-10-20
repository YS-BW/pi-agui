"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { ModeToggle } from "./mode-toggle";
import { useFrontendTool } from "@copilotkit/react-core/v2";

interface ExampleLayoutProps {
  chatContent: ReactNode;
  appContent: ReactNode;
}

export function ExampleLayout({ chatContent, appContent }: ExampleLayoutProps) {
  const [mode, setMode] = useState<"chat" | "app">("chat");

  useFrontendTool({
    name: "enableAppMode",
    description:
      "Enable app mode, make sure its open when interacting with todos.",
    handler: async () => {
      setMode("app");
    },
  });

  useFrontendTool({
    name: "enableChatMode",
    description: "Enable chat mode",
    handler: async () => {
      setMode("chat");
    },
  });

  return (
    <div className="h-full flex flex-row pb-6">
      <ModeToggle mode={mode} onModeChange={setMode} />

      {/* Chat Content */}
      <div
        className={`max-h-full flex flex-col dark:bg-stone-950 ${
          mode === "app"
            ? "w-1/2 px-6 max-lg:hidden" // Half/half with the canvas; hidden on mobile in app mode
            : "flex-1 max-lg:px-4"
        }`}
      >
        <div className="shrink-0 pt-[23px] pl-6 pb-2 max-lg:pl-4 max-lg:pb-4 flex gap-1.5 items-center align-center">
          <span className="font-extrabold text-2xl">Pi × CopilotKit</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">{chatContent}</div>
      </div>

      {/* State Panel */}
      <div
        className={`h-full overflow-hidden ${
          mode === "app"
            ? "w-1/2 max-lg:w-full border-l border-[var(--border)] max-lg:border-l-0" // Half/half with the chat; full width on mobile
            : "w-0 border-l-0"
        }`}
      >
        <div className="w-full h-full">{appContent}</div>
      </div>
    </div>
  );
}
