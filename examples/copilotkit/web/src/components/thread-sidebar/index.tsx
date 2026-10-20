"use client";

import { useEffect, useRef, useState } from "react";
import {
  useAgent,
  useCopilotChatConfiguration,
  useThreads,
  UseAgentUpdate,
  type Thread,
} from "@copilotkit/react-core/v2";
import {
  Check,
  LoaderCircle,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const AGENT_ID = "default";
const MAX_TITLE_LENGTH = 44;

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function firstUserMessage(messages: readonly unknown[]): string | undefined {
  for (const message of messages) {
    if (
      message &&
      typeof message === "object" &&
      "role" in message &&
      message.role === "user" &&
      "content" in message
    ) {
      const text = contentToText(message.content)
        .replace(/\s+/gu, " ")
        .trim();
      if (text) {
        return text.length > MAX_TITLE_LENGTH
          ? `${text.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
          : text;
      }
    }
  }
  return undefined;
}

function threadLabel(thread: Thread, preview?: string): string {
  return thread.name?.trim() || preview || "Untitled session";
}

function shortThreadId(threadId: string): string {
  return threadId.slice(0, 8);
}

export function ThreadSidebar() {
  const configuration = useCopilotChatConfiguration();
  const activeThreadId = configuration?.threadId;
  const { agent } = useAgent({
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
  });
  const {
    threads,
    isLoading,
    listError,
    isMutating,
    refetchThreads,
    startNewThread,
    renameThread,
    deleteThread,
  } = useThreads({
    agentId: configuration?.agentId ?? AGENT_ID,
  });

  const [collapsed, setCollapsed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const wasRunning = useRef(false);
  const autoNamedThreads = useRef(new Set<string>());
  const currentPreview = firstUserMessage(agent.messages);
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const isRunning = Boolean(agent.isRunning);

  useEffect(() => {
    const completedRun = wasRunning.current && !isRunning;
    wasRunning.current = isRunning;
    if (!completedRun) return;

    const timer = window.setTimeout(() => refetchThreads(), 250);
    return () => window.clearTimeout(timer);
  }, [isRunning, refetchThreads]);

  useEffect(() => {
    if (
      isRunning ||
      !activeThread ||
      activeThread.name?.trim() ||
      !currentPreview ||
      autoNamedThreads.current.has(activeThread.id)
    ) {
      return;
    }

    autoNamedThreads.current.add(activeThread.id);
    void renameThread(activeThread.id, currentPreview).catch((error) => {
      autoNamedThreads.current.delete(activeThread.id);
      setActionError(
        error instanceof Error ? error.message : "Could not name the session.",
      );
    });
  }, [activeThread, currentPreview, isRunning, renameThread]);

  async function handleRename(threadId: string) {
    const name = draftName.trim();
    if (!name) return;

    setActionError(null);
    try {
      await renameThread(threadId, name);
      setEditingId(null);
      setDraftName("");
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not rename the session.",
      );
    }
  }

  function handleNewThread() {
    startNewThread();
    configuration?.startNewThread();
    setEditingId(null);
    setPendingDeleteId(null);
    setActionError(null);
  }

  function handleSelectThread(threadId: string) {
    if (threadId === activeThreadId) return;
    configuration?.setActiveThreadId(threadId, { explicit: true });
    setEditingId(null);
    setPendingDeleteId(null);
    setActionError(null);
  }

  async function handleDelete(threadId: string) {
    const deletingActiveThread = threadId === activeThreadId;
    setActionError(null);
    try {
      await deleteThread(threadId);
      setPendingDeleteId(null);
      if (deletingActiveThread) {
        startNewThread();
        configuration?.startNewThread();
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not delete the session.",
      );
    }
  }

  function beginEditing(thread: Thread) {
    setEditingId(thread.id);
    setDraftName(threadLabel(thread));
    setPendingDeleteId(null);
    setActionError(null);
  }

  return (
    <aside
      aria-label="Conversation sessions"
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[color-mix(in_srgb,var(--secondary)_42%,var(--background))] transition-[width] duration-200",
        collapsed ? "w-[68px]" : "w-[282px]",
      )}
    >
      <div className="flex h-[66px] shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5",
            collapsed && "justify-center",
          )}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--primary)] text-[var(--primary-foreground)] shadow-sm">
            <MessageSquare className="h-4.5 w-4.5" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">Sessions</div>
              <div className="truncate text-[11px] text-[var(--muted-foreground)]">
                Local Pi conversations
              </div>
            </div>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? "Expand sessions" : "Collapse sessions"}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </Button>
      </div>

      <div className="shrink-0 p-3">
        <Button
          type="button"
          className={cn(
            "w-full",
            collapsed ? "px-0" : "justify-start",
          )}
          onClick={handleNewThread}
          disabled={isRunning}
          aria-label="New session"
          title={collapsed ? "New session" : undefined}
        >
          <Plus className="h-4 w-4" />
          {!collapsed && "New session"}
        </Button>
      </div>

      {!collapsed && actionError && (
        <div
          role="alert"
          className="mx-3 mb-2 rounded-lg border border-[var(--destructive)]/30 bg-[var(--destructive)]/8 px-3 py-2 text-xs text-[var(--destructive)]"
        >
          {actionError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!collapsed && (
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
              Recent
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => refetchThreads()}
              disabled={isLoading}
              aria-label="Refresh sessions"
              title="Refresh sessions"
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", isLoading && "animate-spin")}
              />
            </Button>
          </div>
        )}

        {isLoading && threads.length === 0 && (
          <div
            className={cn(
              "flex items-center gap-2 px-2 py-3 text-xs text-[var(--muted-foreground)]",
              collapsed && "justify-center",
            )}
          >
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {!collapsed && "Loading sessions…"}
          </div>
        )}

        {!isLoading && listError && threads.length === 0 && (
          <button
            type="button"
            className={cn(
              "w-full rounded-lg px-2 py-3 text-left text-xs text-[var(--destructive)] hover:bg-[var(--secondary)]",
              collapsed && "text-center",
            )}
            onClick={() => refetchThreads()}
            title={listError.message}
          >
            {collapsed ? "!" : "Could not load sessions. Retry."}
          </button>
        )}

        {!isLoading && !listError && threads.length === 0 && (
          <div
            className={cn(
              "rounded-xl border border-dashed border-[var(--border)] px-3 py-5 text-center text-xs text-[var(--muted-foreground)]",
              collapsed && "border-0 px-0",
            )}
          >
            {collapsed ? "—" : "Send a message to create your first session."}
          </div>
        )}

        <div className="space-y-1">
          {threads.map((thread) => {
            const isActive = thread.id === activeThreadId;
            const label = threadLabel(
              thread,
              isActive ? currentPreview : undefined,
            );
            const isEditing = editingId === thread.id;
            const isConfirmingDelete = pendingDeleteId === thread.id;

            return (
              <div
                key={thread.id}
                className={cn(
                  "group relative rounded-xl border transition-colors",
                  isActive
                    ? "border-[var(--ring)]/70 bg-[var(--card)] shadow-sm"
                    : "border-transparent hover:border-[var(--border)] hover:bg-[var(--card)]/70",
                )}
              >
                {isEditing ? (
                  <form
                    className="space-y-2 p-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleRename(thread.id);
                    }}
                  >
                    <Input
                      autoFocus
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setEditingId(null);
                          setDraftName("");
                        }
                      }}
                      maxLength={80}
                      aria-label="Session name"
                    />
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => {
                          setEditingId(null);
                          setDraftName("");
                        }}
                        aria-label="Cancel rename"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="submit"
                        size="icon"
                        className="h-7 w-7"
                        disabled={!draftName.trim() || isMutating}
                        aria-label="Save session name"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </form>
                ) : isConfirmingDelete ? (
                  <div
                    role="alertdialog"
                    aria-label={`Delete ${label}`}
                    className="space-y-2 p-2"
                  >
                    <div className="text-xs font-medium">Delete this session?</div>
                    <div className="text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                      This cannot be undone.
                    </div>
                    <div className="flex justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setPendingDeleteId(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={isMutating}
                        onClick={() => void handleDelete(thread.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex min-w-0 items-start gap-1 p-1">
                    <button
                      type="button"
                      className={cn(
                        "flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-2 text-left",
                        collapsed && "justify-center px-0",
                        isRunning &&
                          !isActive &&
                          "cursor-not-allowed opacity-50",
                      )}
                      onClick={() => handleSelectThread(thread.id)}
                      disabled={isRunning && !isActive}
                      aria-current={isActive ? "page" : undefined}
                      title={collapsed ? label : undefined}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                          isActive
                            ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                            : "bg-[var(--secondary)] text-[var(--muted-foreground)]",
                        )}
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                      </span>
                      {!collapsed && (
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium leading-5">
                            {label}
                          </span>
                          <span className="flex items-center gap-1.5 truncate text-[10px] text-[var(--muted-foreground)]">
                            {isActive && isRunning ? (
                              <>
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--cpk-mint-800)]" />
                                Running
                              </>
                            ) : isActive ? (
                              "Active"
                            ) : (
                              `Session ${shortThreadId(thread.id)}`
                            )}
                          </span>
                        </span>
                      )}
                    </button>

                    {!collapsed && (
                      <div
                        className={cn(
                          "flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
                          isActive && "opacity-100",
                        )}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => beginEditing(thread)}
                          disabled={isRunning}
                          aria-label={`Rename ${label}`}
                          title="Rename session"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                          onClick={() => {
                            setPendingDeleteId(thread.id);
                            setEditingId(null);
                          }}
                          disabled={isRunning}
                          aria-label={`Delete ${label}`}
                          title="Delete session"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {!collapsed && (
        <div className="shrink-0 border-t border-[var(--border)] px-3 py-3 text-[10px] leading-relaxed text-[var(--muted-foreground)]">
          Stored in the current Web process. History clears when the frontend
          restarts.
        </div>
      )}
    </aside>
  );
}
