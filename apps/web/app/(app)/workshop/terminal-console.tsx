"use client";

import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalInfo } from "../../../src/ws/protocol";

export type TerminalConsoleProps = {
  terminal: TerminalInfo;
  outputChunks: string[];
  exitCode?: number | null;
  onInput: (terminalId: string, data: string) => void;
  onResize: (terminalId: string, cols: number, rows: number) => void;
  onAttach: (terminalId: string, since?: number) => void;
  onClose: (terminalId: string) => void;
};

export function TerminalConsole({
  terminal,
  outputChunks,
  exitCode,
  onInput,
  onResize,
  onAttach,
  onClose,
}: TerminalConsoleProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const renderedChunksRef = useRef<number>(0);

  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;

    async function init() {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (disposed || !containerRef.current) return;

      term = new Terminal({
        fontFamily: 'var(--font-mono), "JetBrains Mono", monospace',
        fontSize: 13,
        lineHeight: 1.7,
        theme: {
          background: "#070B16",
          foreground: "#E8EDF7",
          cursor: "#E8EDF7",
        },
        cursorBlink: true,
        disableStdin: false,
        convertEol: true,
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      try {
        fitAddon.fit();
      } catch (err) {
        void err;
      }

      const ro = new ResizeObserver(() => {
        try {
          fitAddon.fit();
        } catch (err) {
          void err;
        }
      });
      if (containerRef.current) ro.observe(containerRef.current);

      term.onData((data: string) => {
        onInput(terminal.id, data);
      });

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        onResize(terminal.id, cols, rows);
      });

      termRef.current = term;

      onResize(terminal.id, term.cols, term.rows);
      onAttach(terminal.id);

      term.focus();

      while (renderedChunksRef.current < outputChunks.length) {
        const chunk = outputChunks[renderedChunksRef.current];
        if (chunk !== undefined) term.write(chunk);
        renderedChunksRef.current++;
      }
    }

    init();

    return () => {
      disposed = true;
      term?.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!termRef.current) return;
    while (renderedChunksRef.current < outputChunks.length) {
      const chunk = outputChunks[renderedChunksRef.current];
      if (chunk !== undefined) termRef.current.write(chunk);
      renderedChunksRef.current++;
    }
  }, [outputChunks]);

  useEffect(() => {
    if (exitCode !== undefined && termRef.current) {
      termRef.current.writeln(`\r\n\x1b[38;2;151;163;188m[Terminal exited with code ${exitCode ?? 0}]\x1b[0m`);
    }
  }, [exitCode]);

  return (
    <section
      className="workshop-console console-terminal"
      aria-label={`Terminal on ${terminal.projectName}`}
    >
      <div className="console-header">
        <div className="console-header-left">
          <span className="console-project-name">
            Terminal · {terminal.projectName} · you type, no agent
          </span>
        </div>
        <div className="console-header-right">
          <button
            type="button"
            className="btn-secondary-sm"
            onClick={() => onClose(terminal.id)}
          >
            Close
          </button>
        </div>
      </div>

      <div
        className="console-output"
        ref={containerRef}
        onClick={() => termRef.current?.focus()}
      />
    </section>
  );
}
