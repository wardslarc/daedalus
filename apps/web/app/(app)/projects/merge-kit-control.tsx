"use client";

import { useState } from "react";
import { postJson } from "../../csrf-fetch";

type Props = {
  projectId: number;
  localPath: string;
  defaultBranch: string;
  onMerged: () => void | Promise<void>;
};

/**
 * "Merge kit" on a project card (T2.9). Two steps: the first click only says what will
 * happen; the merge runs on the second. The server refuses anything unsafe (uncommitted
 * changes, conflicts) and its reason is shown as is.
 */
export function MergeKitControl({ projectId, localPath, defaultBranch, onMerged }: Props) {
  const [step, setStep] = useState<"idle" | "confirm" | "busy">("idle");
  const [error, setError] = useState("");

  async function merge() {
    setStep("busy");
    setError("");
    try {
      const res = await postJson(`/api/projects/${projectId}/merge-kit`);
      if (res.ok) {
        await onMerged();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "The merge failed.");
      setStep("idle");
    } catch {
      setError("Couldn't reach the Daedalus server.");
      setStep("idle");
    }
  }

  return (
    <div className="merge-kit">
      {step === "confirm" || step === "busy" ? (
        <>
          <p className="merge-kit-question">
            Merge daedalus/kit into {defaultBranch} in {localPath}?
          </p>
          <p className="merge-kit-note">
            Refused if {defaultBranch} has uncommitted changes. Conflicts are cancelled, never forced.
          </p>
          <div className="merge-kit-actions">
            <button type="button" className="btn-primary-sm" onClick={merge} disabled={step === "busy"}>
              {step === "busy" ? "Merging…" : "Merge"}
            </button>
            <button type="button" className="btn-secondary-sm" onClick={() => setStep("idle")} disabled={step === "busy"}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="btn-secondary-sm" onClick={() => setStep("confirm")}>
          Merge kit
        </button>
      )}
      {error && (
        <p className="merge-kit-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
