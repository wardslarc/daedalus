"use client";

import { useState, useEffect, useCallback } from "react";

export type FolderEntry = {
  name: string;
  path: string;
  isGitRepo: boolean;
};

export type FolderRoot = {
  label: string;
  path: string;
  kind: "wsl" | "drive";
};

export type BrowseResult = {
  currentPath: string;
  parentPath: string | null;
  isGitRepo: boolean;
  roots: FolderRoot[];
  entries: FolderEntry[];
};

export type FolderExplorerProps = {
  initialPath?: string;
  onSelectFolder: (path: string, folderName: string) => void;
  onClose: () => void;
};

function baseName(p: string): string {
  const cleaned = p.replace(/\/+$/, "");
  const idx = cleaned.lastIndexOf("/");
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

export function FolderExplorer({ initialPath, onSelectFolder, onClose }: FolderExplorerProps) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [targetPath, setTargetPath] = useState<string | undefined>(() => {
    const trimmed = (initialPath ?? "").trim();
    if (!trimmed || /^https?:\/\/|^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(trimmed)) {
      return undefined;
    }
    return trimmed;
  });

  const loadFolder = useCallback(async (pathToLoad: string | undefined, hidden: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (pathToLoad) params.set("path", pathToLoad);
      if (hidden) params.set("hidden", "1");
      const qs = params.toString();
      const res = await fetch(`/api/fs/folders${qs ? `?${qs}` : ""}`, { credentials: "same-origin" });
      const body = (await res.json().catch(() => ({}))) as BrowseResult & { error?: string };
      if (!res.ok) {
        // If initialPath didn't exist, fall back to home folder
        if (pathToLoad !== undefined) {
          setTargetPath(undefined);
          return;
        }
        setError(body.error ?? "Failed to load folders.");
        return;
      }
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load folders.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFolder(targetPath, showHidden);
  }, [targetPath, showHidden, loadFolder]);

  return (
    <div className="folder-explorer" role="region" aria-label="Folder explorer">
      {/* Quick-jump roots: WSL Home, Work, Projects, and Windows drives */}
      {data && data.roots.length > 0 && (
        <div className="folder-explorer-roots" aria-label="Locations">
          {data.roots.map((root) => {
            const active = data.currentPath === root.path;
            return (
              <button
                key={root.path}
                type="button"
                className={`folder-root-pill ${active ? "active" : ""}`}
                onClick={() => setTargetPath(root.path)}
              >
                {root.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Current path bar with Up and Use current folder actions */}
      <div className="folder-explorer-bar">
        <button
          type="button"
          className="btn-secondary-sm"
          disabled={!data?.parentPath || loading}
          onClick={() => {
            if (data?.parentPath) setTargetPath(data.parentPath);
          }}
          aria-label="Parent folder"
        >
          ↑ Up
        </button>
        <code className="folder-explorer-path" title={data?.currentPath ?? ""}>
          {data?.currentPath ?? "Loading…"}
        </code>
        {data && (
          <button
            type="button"
            className={data.isGitRepo ? "btn-primary-sm" : "btn-secondary-sm"}
            onClick={() => onSelectFolder(data.currentPath, baseName(data.currentPath))}
          >
            {data.isGitRepo ? "Use this repo" : "Use current folder"}
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="form-error">
          {error}
        </div>
      )}

      {/* Directory listing */}
      <div className="folder-explorer-list" role="list" aria-label="Subfolders">
        {loading && !data ? (
          <div className="folder-explorer-empty">Loading folders…</div>
        ) : data && data.entries.length === 0 ? (
          <div className="folder-explorer-empty">No subfolders inside this directory.</div>
        ) : (
          data?.entries.map((entry) => (
            <div key={entry.path} className="folder-explorer-row" role="listitem">
              <button
                type="button"
                className="folder-explorer-open"
                onClick={() => setTargetPath(entry.path)}
                title={`Open ${entry.path}`}
              >
                <span className="folder-explorer-name">{entry.name}</span>
                {entry.isGitRepo && <span className="folder-git-badge">Git repo</span>}
              </button>
              <button
                type="button"
                className={entry.isGitRepo ? "btn-primary-sm" : "btn-secondary-sm"}
                onClick={() => onSelectFolder(entry.path, entry.name)}
                aria-label={`Select ${entry.name}`}
              >
                Select
              </button>
            </div>
          ))
        )}
      </div>

      {/* Footer: show hidden toggle + close explorer */}
      <div className="folder-explorer-footer">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          Show hidden folders
        </label>
        <button type="button" className="btn-secondary-sm" onClick={onClose}>
          Hide browser
        </button>
      </div>
    </div>
  );
}
