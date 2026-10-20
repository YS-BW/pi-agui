/**
 * Suggestion pills shown in the chat UI. Each suggestion triggers a specific
 * demo feature when clicked.
 *
 * Ordered from most constrained (fixed UI) to most open (freeform UI).
 *
 * These prompts exercise the Pi adapter itself: coding tools, frontend tools,
 * human-in-the-loop, controlled generative UI, and shared state.
 */
import { useConfigureSuggestions } from "@copilotkit/react-core/v2";

export const useExampleSuggestions = () => {
  useConfigureSuggestions({
    suggestions: [
      {
        title: "Inspect the Adapter",
        message:
          "Use the bash or read tool to inspect src/thread.ts and briefly explain how createAgentSession is wrapped for AG-UI.",
      },
      {
        title: "List Project Files",
        message:
          "Use the bash tool to show the top-level project files and then summarize the repository structure in a few bullets.",
      },
      {
        title: "Pie Chart (Frontend Tool)",
        message:
          "Render a pie chart with the pieChart tool. Use these values: read 40, bash 30, edit 20, other 10.",
      },
      {
        title: "Schedule a Meeting (HITL)",
        message:
          "Use the scheduleTime tool to let me pick a 30-minute meeting time for a Pi adapter review.",
      },
      {
        title: "Shared Todo State",
        message:
          "Enable app mode and use ag_ui_update_state to add three pending todos: verify Pi tools, test frontend handoff, and inspect the AG-UI transcript.",
      },
      {
        title: "Toggle Theme (Frontend Tool)",
        message: "Toggle the app theme using the toggleTheme tool.",
      },
    ],
    available: "always",
  });
};
