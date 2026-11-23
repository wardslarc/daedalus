import { eq } from "drizzle-orm";
import type { DaedalusDb } from "@daedalus/db";
import { tasks } from "@daedalus/db";
import { isKitTemplateDoc, readShapingDoc, SHAPING_DOCS } from "./shaping.js";

export type PipelineTaskStatus = "queued" | "running" | "check-failed" | "in-review" | "done";

export type ParsedPlanTask = {
  code: string; // e.g. "T1.1"
  title: string; // e.g. "Core implementation"
  tag: "claude" | "gemini" | "you" | null;
  description: string;
  checkCommand: string | null;
  linkedSpecSections: string[]; // e.g. ["Overview", "Verify"] extracted from [[SPEC#Overview]]
  markdownStatus: "todo" | "in_progress" | "done"; // [ ] | [~] | [x]
  milestoneCode: string | null; // e.g. "M1"
  milestoneTitle: string | null; // e.g. "M1 — v1.0 Initial Release"
};

export type ParsedMilestone = {
  code: string; // e.g. "M1"
  title: string; // e.g. "M1 — v1.0 Initial Release"
  doneWhen: string[]; // UAT items from "Done when:" lines/bullets under the milestone
  tasks: ParsedPlanTask[];
};

export type ParsedPlan = {
  milestones: ParsedMilestone[];
  tasks: ParsedPlanTask[];
};

export type PipelineTask = typeof tasks.$inferSelect & {
  description: string;
  milestoneCode: string | null;
  milestoneTitle: string | null;
};

export type SyncPlanResult = {
  milestones: ParsedMilestone[];
  tasks: PipelineTask[];
};

/**
 * Strip surrounding backticks if the entire command is enclosed in single backticks.
 * e.g. `pnpm test` -> pnpm test
 */
function cleanCheckCommand(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    if (!inner.includes("`")) {
      return inner.trim();
    }
  }
  return trimmed;
}

/**
 * Extract [[SPEC#Section]] links from a string and append unique section names to target array.
 */
function extractSpecLinks(text: string, target: string[]): void {
  const matches = text.matchAll(/\[\[SPEC#([^\]]+)\]\]/g);
  for (const m of matches) {
    const sec = m[1]?.trim();
    if (sec && !target.includes(sec)) {
      target.push(sec);
    }
  }
}

/**
 * Parse a PLAN.md markdown string into structured milestones and tasks.
 */
export function parsePlanMarkdown(content: string): ParsedPlan {
  const lines = content.split(/\r?\n/);
  const milestones: ParsedMilestone[] = [];
  const allTasks: ParsedPlanTask[] = [];

  let currentMilestone: ParsedMilestone | null = null;
  let inDoneWhen = false;

  let currentTask: ParsedPlanTask | null = null;
  let currentTaskDescLines: string[] = [];

  const flushTask = () => {
    if (currentTask) {
      currentTask.description = currentTaskDescLines.join("\n").trim();
      allTasks.push(currentTask);
      if (currentMilestone) {
        currentMilestone.tasks.push(currentTask);
      }
      currentTask = null;
      currentTaskDescLines = [];
    }
  };

  for (const line of lines) {
    // 1. Milestone heading: ^##\s+(M\d+)\b(.*)$
    const milestoneMatch = line.match(/^##\s+(M\d+)\b(.*)$/);
    if (milestoneMatch) {
      flushTask();
      inDoneWhen = false;
      const code = milestoneMatch[1]!;
      const title = line.replace(/^##\s+/, "").trim();
      currentMilestone = {
        code,
        title,
        doneWhen: [],
        tasks: [],
      };
      milestones.push(currentMilestone);
      continue;
    }

    // 2. Task item: ^-\s+\[([ x~X])\]\s+\*\*(T\d+(?:\.\d+)?)\s+([^*]+)\*\*(.*)$
    const taskMatch = line.match(/^-\s+\[([ x~X])\]\s+\*\*(T\d+(?:\.\d+)?)\s+([^*]+)\*\*(.*)$/);
    if (taskMatch) {
      flushTask();
      inDoneWhen = false;

      const rawMark = taskMatch[1]!.toLowerCase();
      const markdownStatus: "todo" | "in_progress" | "done" =
        rawMark === "x" ? "done" : rawMark === "~" ? "in_progress" : "todo";

      const code = taskMatch[2]!;
      const title = taskMatch[3]!.trim();
      const headerRest = taskMatch[4] ?? "";

      const tagMatch = headerRest.match(/`?\[(claude|gemini|you)\]`?/i);
      const tag = tagMatch ? (tagMatch[1]!.toLowerCase() as "claude" | "gemini" | "you") : null;

      const linkedSpecSections: string[] = [];
      extractSpecLinks(headerRest, linkedSpecSections);

      currentTask = {
        code,
        title,
        tag,
        description: "",
        checkCommand: null,
        linkedSpecSections,
        markdownStatus,
        milestoneCode: currentMilestone?.code ?? null,
        milestoneTitle: currentMilestone?.title ?? null,
      };
      currentTaskDescLines = [];
      continue;
    }

    // 3. If we are currently under a task, process continuation lines
    if (currentTask) {
      const checkMatch = line.match(/^\s*check:\s*(.+)$/i);
      if (checkMatch) {
        currentTask.checkCommand = cleanCheckCommand(checkMatch[1]!);
        extractSpecLinks(line, currentTask.linkedSpecSections);
      } else {
        extractSpecLinks(line, currentTask.linkedSpecSections);
        const trimmed = line.trim();
        if (trimmed.length > 0 || currentTaskDescLines.length > 0) {
          currentTaskDescLines.push(trimmed);
        }
      }
      continue;
    }

    // 4. Milestone "Done when:" section
    const doneWhenMatch = line.match(/^\s*Done when\s*:\s*(.*)$/i);
    if (doneWhenMatch) {
      inDoneWhen = true;
      const textAfter = doneWhenMatch[1]?.trim() ?? "";
      if (textAfter.length > 0 && currentMilestone) {
        currentMilestone.doneWhen.push(textAfter);
      }
      continue;
    }

    if (inDoneWhen && currentMilestone) {
      const bulletMatch = line.match(/^\s*-\s+(.+)$/);
      if (bulletMatch) {
        currentMilestone.doneWhen.push(bulletMatch[1]!.trim());
      } else if (line.trim().length > 0 && currentMilestone.doneWhen.length > 0) {
        // Continuation of previous Done when item
        currentMilestone.doneWhen[currentMilestone.doneWhen.length - 1] += ` ${line.trim()}`;
      } else if (line.trim().length === 0) {
        // Blank line ends single-line continuation, but bullets may still follow
      }
    }
  }

  flushTask();

  return {
    milestones,
    tasks: allTasks,
  };
}

/**
 * Sync tasks from docs/PLAN.md into the SQLite tasks table.
 */
export function syncPlanTasksToDb(
  db: DaedalusDb,
  projectId: number,
  localPath: string,
): SyncPlanResult {
  const planDoc = readShapingDoc(localPath, SHAPING_DOCS.plan);
  if (!planDoc.exists || !planDoc.content || isKitTemplateDoc(SHAPING_DOCS.plan, planDoc.content)) {
    return { milestones: [], tasks: [] };
  }

  const parsed = parsePlanMarkdown(planDoc.content);

  const existingRows = db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();
  const existingByCode = new Map(existingRows.map((r) => [r.code, r]));

  for (const t of parsed.tasks) {
    const prev = existingByCode.get(t.code);
    if (prev) {
      const newStatus = t.markdownStatus === "done" ? "done" : prev.status;
      db.update(tasks)
        .set({
          title: t.title,
          tag: t.tag,
          checkCommand: t.checkCommand,
          linkedSpecSections: t.linkedSpecSections,
          status: newStatus,
        })
        .where(eq(tasks.id, prev.id))
        .run();
    } else {
      const initialStatus: PipelineTaskStatus =
        t.markdownStatus === "done"
          ? "done"
          : t.markdownStatus === "in_progress"
            ? "running"
            : "queued";

      db.insert(tasks)
        .values({
          projectId,
          code: t.code,
          title: t.title,
          tag: t.tag,
          checkCommand: t.checkCommand,
          status: initialStatus,
          linkedSpecSections: t.linkedSpecSections,
          attempts: 0,
          branch: null,
        })
        .run();
    }
  }

  const updatedRows = db.select().from(tasks).where(eq(tasks.projectId, projectId)).all();
  const parsedByCode = new Map(parsed.tasks.map((pt) => [pt.code, pt]));
  const orderMap = new Map(parsed.tasks.map((pt, idx) => [pt.code, idx]));

  const enrichedTasks: PipelineTask[] = updatedRows.map((row) => {
    const pt = parsedByCode.get(row.code);
    return {
      ...row,
      description: pt?.description ?? "",
      milestoneCode: pt?.milestoneCode ?? null,
      milestoneTitle: pt?.milestoneTitle ?? null,
    };
  });

  enrichedTasks.sort((a, b) => {
    const idxA = orderMap.has(a.code) ? orderMap.get(a.code)! : 9999;
    const idxB = orderMap.has(b.code) ? orderMap.get(b.code)! : 9999;
    return idxA - idxB;
  });

  return {
    milestones: parsed.milestones,
    tasks: enrichedTasks,
  };
}
