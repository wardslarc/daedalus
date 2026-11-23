import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join, sep } from "node:path";
import { eq } from "drizzle-orm";
import type { DaedalusDb } from "@daedalus/db";
import { shapingState } from "@daedalus/db";
import { assertProviderAllowed, effectiveGeminiAllowed, rulesFor, type ProjectLike } from "@daedalus/core/profiles";
import { branchExists as gitBranchExists, createBranch as gitCreateBranch } from "@daedalus/git";
import { findDuplicateTaskCode, parsePlanMarkdown } from "./pipeline.js";

export class ShapingError extends Error {
  override name = "ShapingError";
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export type ShapingStepId = "intake" | "spec" | "mock" | "plan";

export type StepInfo = {
  id: ShapingStepId;
  label: string;
  doc: string;
  provider: string;
  isAi: boolean;
  status: "current" | "completed" | "locked";
  exists: boolean;
};

export type IntakeFields = {
  requester?: string;
  problem: string;
  users: string;
  mustHaves?: string;
  outOfScope?: string;
  constraints: string;
  deadline?: string;
};

export type SaveIntakeInput = {
  content?: string;
  fields?: Partial<IntakeFields>;
};

export type MockApproval = {
  artifactUrl: string;
  approvedBy: string;
  approvedAt: string;
  providerId?: "claude" | "antigravity";
};

export type MilestoneState = {
  version: string;
  branch: string;
  startedAt: string;
  frozen: true;
};

export type ShapingState = {
  currentStep: ShapingStepId;
  steps: StepInfo[];
  intake: {
    exists: boolean;
    content: string | null;
    fields: Partial<IntakeFields>;
  };
  spec: {
    exists: boolean;
    content: string | null;
    hasVerify: boolean;
    approved: boolean;
    approvedAt: string | null;
  };
  mock: {
    exists: boolean;
    content: string | null;
    approved: boolean;
    approval: MockApproval | null;
    allowedProviders: ("claude" | "antigravity")[];
  };
  plan: {
    exists: boolean;
    content: string | null;
    valid: boolean;
    approved: boolean;
    approvedAt: string | null;
    activeMilestone: MilestoneState | null;
  };
};

export type ShapingMeta = {
  intakeCompletedAt?: string | null;
  specApprovedAt?: string | null;
  mockApproval?: MockApproval | null;
  mockProviderId?: "claude" | "antigravity" | null;
  planApprovedAt?: string | null;
  activeMilestone?: MilestoneState | null;
};

export type ApproveSpecInput = {
  content?: string;
};

export type ApproveMockInput = {
  artifactUrl?: string;
  approvedBy?: string;
};

export type ApprovePlanInput = {
  content?: string;
};

export type StartMilestoneInput = {
  version?: string;
  defaultBranch?: string;
  milestoneCode?: string;
};

export const SHAPING_DOCS = {
  intake: "docs/INTAKE.md",
  spec: "docs/SPEC.md",
  mock: "docs/mock.html",
  plan: "docs/PLAN.md",
} as const;

function splitDocsRelPath(relPath: string): string[] {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "docs" || parts.some((p) => p === "." || p === "..")) {
    throw new ShapingError(`Invalid shaping doc path: ${relPath}`, 400);
  }
  return parts;
}

/**
 * Safely read a shaping document inside a project's local folder.
 * Ensures that docs/ and the target file exist, are regular files/directories,
 * and never follow symlinks or escape the repository root.
 */
export function readShapingDoc(root: string, relPath: string): { exists: boolean; content: string | null } {
  const parts = splitDocsRelPath(relPath);
  if (!existsSync(root)) return { exists: false, content: null };
  const realRoot = realpathSync(root);

  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i]!);
    let st: Stats | null;
    try {
      st = lstatSync(cur);
    } catch {
      st = null;
    }
    if (!st) return { exists: false, content: null };
    if (st.isSymbolicLink()) throw new ShapingError("Symlink detected in docs path.", 400);
    if (!st.isDirectory()) throw new ShapingError("docs path is not a directory.", 400);
    const realDir = realpathSync(cur);
    if (!realDir.startsWith(realRoot + sep)) {
      throw new ShapingError("docs path escapes repo root.", 400);
    }
  }

  const filePath = join(cur, parts[parts.length - 1]!);
  let fileSt: Stats | null;
  try {
    fileSt = lstatSync(filePath);
  } catch {
    fileSt = null;
  }
  if (!fileSt) return { exists: false, content: null };
  if (fileSt.isSymbolicLink()) throw new ShapingError(`Symlink detected for ${relPath}.`, 400);
  if (!fileSt.isFile()) throw new ShapingError(`${relPath} is not a regular file.`, 400);

  const realFile = realpathSync(filePath);
  if (!realFile.startsWith(realRoot + sep)) {
    throw new ShapingError(`${relPath} escapes repo root.`, 400);
  }

  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fdSt = fstatSync(fd);
    if (!fdSt.isFile()) {
      throw new ShapingError(`${relPath} is not a regular file.`, 400);
    }
    if (fdSt.nlink > 1) {
      throw new ShapingError(`Hardlink detected for ${relPath}.`, 400);
    }
    const content = readFileSync(fd, "utf8");
    return { exists: true, content };
  } finally {
    closeSync(fd);
  }
}

/**
 * Safely write a shaping document inside a project's docs folder.
 * Creates docs/ if needed, ensures no symlinks exist along the path,
 * verifies size limits and disallows ASCII control characters.
 */
export function writeShapingDoc(root: string, relPath: string, content: string): void {
  const parts = splitDocsRelPath(relPath);
  if (typeof content !== "string") throw new ShapingError("Content must be a string.", 400);
  if (Buffer.byteLength(content, "utf8") > 128 * 1024) {
    throw new ShapingError("Content is too large (128KB max).", 413);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
    throw new ShapingError("Content cannot contain control characters.", 400);
  }

  if (!existsSync(root)) throw new ShapingError("Repo folder does not exist.", 404);
  const realRoot = realpathSync(root);

  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = join(cur, parts[i]!);
    let st: Stats | null;
    try {
      st = lstatSync(cur);
    } catch {
      st = null;
    }
    if (st) {
      if (st.isSymbolicLink()) throw new ShapingError("docs directory cannot be a symbolic link.", 400);
      if (!st.isDirectory()) throw new ShapingError("docs must be a directory.", 400);
    } else {
      mkdirSync(cur);
    }
    const realDir = realpathSync(cur);
    if (!realDir.startsWith(realRoot + sep)) {
      throw new ShapingError("docs directory escapes repo root.", 400);
    }
  }

  const filePath = join(cur, parts[parts.length - 1]!);
  let fileSt: Stats | null;
  try {
    fileSt = lstatSync(filePath);
  } catch {
    fileSt = null;
  }
  if (fileSt) {
    if (fileSt.isSymbolicLink()) throw new ShapingError(`Refusing to overwrite symbolic link at ${relPath}.`, 400);
    if (!fileSt.isFile()) throw new ShapingError(`${relPath} is not a regular file.`, 400);
  }

  const tempName = `.tmp-${parts[parts.length - 1]!}-${randomBytes(8).toString("hex")}`;
  const tempPath = join(cur, tempName);
  try {
    const fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    try {
      writeSync(fd, content, null, "utf8");
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, filePath);
  } catch (err) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * True when a doc in docs/ is still the unedited scaffold from kit/.
 * A newly created project (or one that just merged daedalus/kit) has these template files on disk,
 * which should not mark Intake, Spec, or Plan as already completed.
 */
export function isKitTemplateDoc(relPath: string, content: string | null): boolean {
  if (!content) return false;
  switch (relPath) {
    case SHAPING_DOCS.intake:
      return (
        content.includes("- **Problem:** what is hard or missing today.") &&
        content.includes("- **Users:** who uses it, on what devices.")
      );
    case SHAPING_DOCS.spec:
      return (
        content.includes("- What the product does, in one or two lines.") &&
        content.includes("- How we know the whole thing works (the end-to-end check).")
      );
    case SHAPING_DOCS.plan:
      return (
        content.includes("What to build, in one or two lines.") &&
        content.includes("check: `<command that passes when this is done>`")
      );
    default:
      return false;
  }
}

/**
 * Parse an INTAKE.md markdown document into structured fields.
 */
export function parseIntakeMarkdown(content: string): Partial<IntakeFields> {
  const fields: Partial<IntakeFields> = {};
  const lines = content.split(/\r?\n/);
  let currentKey: keyof IntakeFields | null = null;
  const buffer: string[] = [];

  const flush = () => {
    if (currentKey) {
      fields[currentKey] = buffer.join("\n").trim();
      buffer.length = 0;
    }
  };

  const keyMap: Record<string, keyof IntakeFields> = {
    requester: "requester",
    problem: "problem",
    users: "users",
    "must-haves": "mustHaves",
    "out of scope": "outOfScope",
    "out of scope for 1.0": "outOfScope",
    constraints: "constraints",
    deadline: "deadline",
  };

  for (const line of lines) {
    const match = line.match(/^-\s+\*\*([^:]+):\*\*(.*)$/);
    if (match) {
      flush();
      const rawHeader = match[1]?.trim().toLowerCase() ?? "";
      currentKey = keyMap[rawHeader] ?? null;
      if (currentKey) {
        buffer.push(match[2]?.trim() ?? "");
      }
    } else if (currentKey) {
      if (line.startsWith("Started ") || line.startsWith("# ") || line.startsWith("- **")) {
        flush();
        currentKey = null;
      } else {
        buffer.push(line.replace(/^\s{2,4}/, ""));
      }
    }
  }
  flush();
  return fields;
}

/**
 * Render structured intake fields into a clean INTAKE.md markdown string.
 */
export function renderIntakeMarkdown(
  projectName: string,
  fields: Partial<IntakeFields>,
  meta?: { today?: string; profile?: string },
): string {
  const today = meta?.today ?? new Date().toISOString().slice(0, 10);
  const profile = meta?.profile ?? "Personal";
  return [
    `# Intake — ${projectName}`,
    "",
    `- **Requester:** ${fields.requester || "Owner"}`,
    `- **Problem:** ${fields.problem || ""}`,
    `- **Users:** ${fields.users || ""}`,
    `- **Must-haves:** ${fields.mustHaves || ""}`,
    `- **Out of scope:** ${fields.outOfScope || ""}`,
    `- **Constraints:** ${fields.constraints || ""}`,
    `- **Deadline:** ${fields.deadline || "[OPEN]"}`,
    "",
    `Started ${today} · profile: ${profile}`,
    "",
  ].join("\n");
}

/**
 * Check whether a SPEC.md document contains a non-empty `## Verify` section
 * (and is not the unedited kit template).
 */
export function hasVerifySection(content: string | null): boolean {
  if (!content || isKitTemplateDoc(SHAPING_DOCS.spec, content)) return false;
  const lines = content.split(/\r?\n/);
  let inVerify = false;
  const verifyLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^##\s+verify\b/i.test(line)) {
      inVerify = true;
      continue;
    }
    if (inVerify) {
      if (/^#{1,2}\s+\S/.test(line)) {
        break;
      }
      if (
        line.length > 0 &&
        line !== "- How we know the whole thing works (the end-to-end check)."
      ) {
        verifyLines.push(line);
      }
    }
  }

  return verifyLines.length > 0;
}

/**
 * Build the guided kickoff prompt for the Claude Spec interview from docs/INTAKE.md.
 */
export function buildSpecInterviewPrompt(projectName: string, intakeContent: string): string {
  return [
    `[Spec interview] Project: ${projectName}`,
    "",
    "You are running the Daedalus Spec interview for this project.",
    "Read the intake below (from docs/INTAKE.md), draft or update docs/SPEC.md live in the project folder with linkable `## <Section>` headings (`[[SPEC#<Section>]]`), ask the owner focused clarifying questions, and finish docs/SPEC.md with a `## Verify` section listing concrete end-to-end checks.",
    "",
    "--- docs/INTAKE.md ---",
    intakeContent.trim(),
  ].join("\n");
}

function readShapingStateRow(db: DaedalusDb, projectId: number) {
  return db.select().from(shapingState).where(eq(shapingState.projectId, projectId)).get() ?? null;
}

function writeShapingStateRow(
  db: DaedalusDb,
  projectId: number,
  patch: Partial<typeof shapingState.$inferInsert>,
) {
  const existing = readShapingStateRow(db, projectId);
  if (existing) {
    db.update(shapingState).set(patch).where(eq(shapingState.projectId, projectId)).run();
  } else {
    db.insert(shapingState).values({ projectId, ...patch }).run();
  }
}

/**
 * Inspect the shaping state for a project.
 */
export function getShapingState(
  db: DaedalusDb,
  projectId: number,
  localPath: string,
  project: ProjectLike,
): ShapingState {
  const intakeDoc = readShapingDoc(localPath, SHAPING_DOCS.intake);
  const specDoc = readShapingDoc(localPath, SHAPING_DOCS.spec);
  const mockDoc = readShapingDoc(localPath, SHAPING_DOCS.mock);
  const planDoc = readShapingDoc(localPath, SHAPING_DOCS.plan);
  const row = readShapingStateRow(db, projectId);

  const intakeReady = intakeDoc.exists && !isKitTemplateDoc(SHAPING_DOCS.intake, intakeDoc.content);
  const specExists = specDoc.exists && !isKitTemplateDoc(SHAPING_DOCS.spec, specDoc.content);
  const specHasVerify = hasVerifySection(specDoc.content);
  const specApproved = Boolean(row?.specApprovedAt) && specExists;
  const mockApproved = Boolean(row?.mockApprovedAt && row?.mockArtifactUrl) && mockDoc.exists;
  const planExists = planDoc.exists && !isKitTemplateDoc(SHAPING_DOCS.plan, planDoc.content);
  const planValid = isValidPlanMarkdown(planDoc.content);
  const planApproved = Boolean(row?.planApprovedAt) && planExists;

  let mockApproval: MockApproval | null = null;
  if (row?.mockArtifactUrl && row?.mockApprovedBy && row?.mockApprovedAt) {
    mockApproval = {
      artifactUrl: row.mockArtifactUrl,
      approvedBy: row.mockApprovedBy,
      approvedAt: row.mockApprovedAt,
      ...(row.mockProviderId ? { providerId: row.mockProviderId as "claude" | "antigravity" } : {}),
    };
  }

  let activeMilestone: MilestoneState | null = null;
  if (row?.activeMilestoneVersion && row?.activeMilestoneBranch && row?.activeMilestoneStartedAt) {
    activeMilestone = {
      version: row.activeMilestoneVersion,
      ...(row.activeMilestoneCode ? { milestoneCode: row.activeMilestoneCode } : {}),
      branch: row.activeMilestoneBranch,
      startedAt: row.activeMilestoneStartedAt,
      frozen: true,
    };
  }

  let currentStep: ShapingStepId;
  if (!intakeReady) {
    currentStep = "intake";
  } else if (!specApproved) {
    currentStep = "spec";
  } else if (!mockApproved) {
    currentStep = "mock";
  } else {
    currentStep = "plan";
  }

  const geminiAllowed = effectiveGeminiAllowed(project);
  const mockProvider = geminiAllowed ? "Claude / Antigravity" : "Claude";
  const allowedProviders: ("claude" | "antigravity")[] = geminiAllowed ? ["claude", "antigravity"] : ["claude"];

  const steps: StepInfo[] = [
    {
      id: "intake",
      label: "Intake",
      doc: SHAPING_DOCS.intake,
      provider: "Owner",
      isAi: false,
      status: intakeReady ? "completed" : currentStep === "intake" ? "current" : "locked",
      exists: intakeReady,
    },
    {
      id: "spec",
      label: "Spec",
      doc: SHAPING_DOCS.spec,
      provider: "Claude",
      isAi: true,
      status: specApproved ? "completed" : currentStep === "spec" ? "current" : "locked",
      exists: specExists,
    },
    {
      id: "mock",
      label: "Mock",
      doc: SHAPING_DOCS.mock,
      provider: mockProvider,
      isAi: true,
      status: mockApproved ? "completed" : currentStep === "mock" ? "current" : "locked",
      exists: mockDoc.exists,
    },
    {
      id: "plan",
      label: "Plan",
      doc: SHAPING_DOCS.plan,
      provider: "Claude",
      isAi: true,
      status: planApproved ? "completed" : currentStep === "plan" ? "current" : "locked",
      exists: planExists,
    },
  ];

  return {
    currentStep,
    steps,
    intake: {
      exists: intakeReady,
      content: intakeReady ? intakeDoc.content : null,
      fields: intakeReady && intakeDoc.content ? parseIntakeMarkdown(intakeDoc.content) : {},
    },
    spec: {
      exists: specExists,
      content: specExists ? specDoc.content : null,
      hasVerify: specHasVerify,
      approved: specApproved,
      approvedAt: row?.specApprovedAt ?? null,
    },
    mock: {
      exists: mockDoc.exists,
      content: mockDoc.exists ? mockDoc.content : null,
      approved: mockApproved,
      approval: mockApproval,
      allowedProviders,
    },
    plan: {
      exists: planExists,
      content: planExists ? planDoc.content : null,
      valid: planValid,
      approved: planApproved,
      approvedAt: row?.planApprovedAt ?? null,
      activeMilestone,
    },
  };
}

/**
 * Save INTAKE.md safely into project docs folder and return the new shaping state.
 */
export function saveIntakeDoc(
  db: DaedalusDb,
  projectId: number,
  localPath: string,
  input: SaveIntakeInput,
  project: ProjectLike,
): ShapingState & { ok: true; content: string } {
  let content: string;
  if (typeof input.content === "string" && input.content.trim().length > 0) {
    content = input.content;
  } else if (input.fields) {
    const profileLabel = rulesFor(project.profile).label;
    content = renderIntakeMarkdown(project.name, input.fields, { profile: profileLabel });
  } else {
    throw new ShapingError("No intake content or fields provided.", 400);
  }

  writeShapingDoc(localPath, SHAPING_DOCS.intake, content);
  const existingRow = readShapingStateRow(db, projectId);
  writeShapingStateRow(db, projectId, {
    intakeCompletedAt: new Date().toISOString(),
    specApprovedAt: existingRow?.specApprovedAt ?? null,
  });
  const state = getShapingState(db, projectId, localPath, project);
  return {
    ...state,
    ok: true,
    content,
  };
}

/**
 * Prepare a project for the guided Claude Spec interview (T4.2).
 * Verifies docs/INTAKE.md is completed, marks spec as unapproved draft in shaping_state,
 * and returns the kickoff prompt built from docs/INTAKE.md.
 */
export function beginSpecInterview(
  db: DaedalusDb,
  projectId: number,
  localPath: string,
  project: ProjectLike,
): { prompt: string; state: ShapingState } {
  const intakeDoc = readShapingDoc(localPath, SHAPING_DOCS.intake);
  if (!intakeDoc.exists || !intakeDoc.content || isKitTemplateDoc(SHAPING_DOCS.intake, intakeDoc.content)) {
    throw new ShapingError("Complete and save the Intake form before starting the Spec interview.", 400);
  }
  const existingRow = readShapingStateRow(db, projectId);
  writeShapingStateRow(db, projectId, {
    intakeCompletedAt: existingRow?.intakeCompletedAt ?? new Date().toISOString(),
    specApprovedAt: null,
  });
  return {
    prompt: buildSpecInterviewPrompt(project.name, intakeDoc.content),
    state: getShapingState(db, projectId, localPath, project),
  };
}

/**
 * Approve docs/SPEC.md (T4.2).
 * Requires docs/INTAKE.md to exist and docs/SPEC.md to include a non-empty `## Verify` section.
 * Advances the shaping step from Spec to Mock.
 */
export function approveSpecDoc(
  db: DaedalusDb,
  projectId: number,
  localPath: string,
  input: ApproveSpecInput | undefined,
  project: ProjectLike,
): ShapingState & { ok: true; content: string } {
  const intakeDoc = readShapingDoc(localPath, SHAPING_DOCS.intake);
  if (!intakeDoc.exists || !intakeDoc.content || isKitTemplateDoc(SHAPING_DOCS.intake, intakeDoc.content)) {
    throw new ShapingError("Complete the Intake step before approving the spec.", 400);
  }

  if (typeof input?.content === "string" && input.content.trim().length > 0) {
    writeShapingDoc(localPath, SHAPING_DOCS.spec, input.content);
  }

  const specDoc = readShapingDoc(localPath, SHAPING_DOCS.spec);
  if (!specDoc.exists || !specDoc.content || isKitTemplateDoc(SHAPING_DOCS.spec, specDoc.content)) {
    throw new ShapingError("docs/SPEC.md does not exist yet. Run the Spec interview first.", 400);
  }

  if (!hasVerifySection(specDoc.content)) {
    throw new ShapingError("docs/SPEC.md must include a ## Verify section before it can be approved.", 400);
  }

  const existingRow = readShapingStateRow(db, projectId);
  writeShapingStateRow(db, projectId, {
    intakeCompletedAt: existingRow?.intakeCompletedAt ?? new Date().toISOString(),
    specApprovedAt: new Date().toISOString(),
  });

  const state = getShapingState(db, projectId, localPath, project);
  return {
    ...state,
    ok: true,
    content: specDoc.content,
  };
}

/**
 * Build the kickoff prompt for the agent to build the clickable HTML mock from docs/SPEC.md (T4.3).
 */
export function buildMockPrompt(projectName: string, specContent: string): string {
  return [
    `[Mock build] Project: ${projectName}`,
    "",
    "You are building a clickable HTML mock for this project based on docs/SPEC.md.",
    "Create or update docs/mock.html in the project root as a complete, self-contained, clickable HTML mock with inline styling and interaction.",
    "Keep it self-contained in docs/mock.html so it can be previewed directly and published as an artifact.",
    "",
    "--- docs/SPEC.md ---",
    specContent.trim(),
  ].join("\n");
}

/**
 * Prepare a project for the mock building session (T4.3).
 * Enforces profile rules on the server via assertProviderAllowed(project, providerId).
 * Verifies docs/SPEC.md exists and is approved, records unapproved mock state in shaping_state,
 * and returns the kickoff prompt and updated shaping state.
 */
export function beginMockSession(
  db: DaedalusDb,
  projectId: number,
  localPath: string,
  providerId: string,
  project: ProjectLike,
): { providerId: "claude" | "antigravity"; prompt: string; state: ShapingState } {
  if (providerId !== "claude" && providerId !== "antigravity") {
    throw new ShapingError(`Invalid providerId: ${providerId}. Must be 'claude' or 'antigravity'.`, 400);
  }
  assertProviderAllowed(project, providerId);

  const specDoc = readShapingDoc(localPath, SHAPING_DOCS.spec);
  const row = readShapingStateRow(db, projectId);
  const specApproved = Boolean(row?.specApprovedAt) && specDoc.exists && hasVerifySection(specDoc.content);

  if (!specApproved || !specDoc.content) {
    throw new ShapingError("docs/SPEC.md must exist and be approved before starting the mock session.", 400);
  }

  writeShapingStateRow(db, projectId, {
    mockArtifactUrl: null,
    mockApprovedBy: null,
    mockApprovedAt: null,
    mockProviderId: providerId,
  });

  return {
    providerId,
    prompt: buildMockPrompt(project.name, specDoc.content),
    state: getShapingState(db, projectId, localPath, project),
  };
}

/**
 * Approve docs/mock.html and record the published Claude artifact link, approver, and timestamp (T4.3).
 * Requires docs/mock.html to exist with content.
 * Advances the shaping step from Mock to Plan.
 */
export function approveMockDoc(
  db: DaedalusDb,
  projectId: number,
  localPath: string,
  input: ApproveMockInput,
  project: ProjectLike,
): ShapingState & { ok: true; approval: MockApproval } {
  const mockDoc = readShapingDoc(localPath, SHAPING_DOCS.mock);
  if (!mockDoc.exists || !mockDoc.content || mockDoc.content.trim().length === 0) {
    throw new ShapingError("docs/mock.html does not exist yet or is empty. Build the mock first.", 400);
  }

  const rawUrl = input.artifactUrl?.trim() ?? "";
  if (!rawUrl) {
    throw new ShapingError("artifactUrl is required to approve the mock.", 400);
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ShapingError("artifactUrl must be a valid http or https URL.", 400);
    }
  } catch {
    throw new ShapingError("artifactUrl must be a valid http or https URL.", 400);
  }

  const approvedBy = input.approvedBy?.trim() ?? "";
  if (!approvedBy) {
    throw new ShapingError("approvedBy is required to approve the mock.", 400);
  }

  const approvedAt = new Date().toISOString();
  const row = readShapingStateRow(db, projectId);
  const approval: MockApproval = {
    artifactUrl: rawUrl,
    approvedBy,
    approvedAt,
    ...(row?.mockProviderId ? { providerId: row.mockProviderId as "claude" | "antigravity" } : {}),
  };

  writeShapingStateRow(db, projectId, {
    mockArtifactUrl: rawUrl,
    mockApprovedBy: approvedBy,
    mockApprovedAt: approvedAt,
  });

  const state = getShapingState(db, projectId, localPath, project);
  return {
    ...state,
    ok: true,
    approval,
  };
}

/**
 * Check whether a PLAN.md document contains at least one milestone heading (`## M...`),
 * a "Done when" UAT line, and at least one task with a provider tag (`[claude]`, `[gemini]`, or `[you]`),
 * a `[[SPEC#...]]` link, and a `check:` line (T4.4).
 */
export function isValidPlanMarkdown(content: string | null): boolean {
  if (!content || isKitTemplateDoc(SHAPING_DOCS.plan, content)) return false;
  const hasMilestone = /^##\s+M\d+\b/m.test(content);
  const hasDoneWhen = /done when\s*:/i.test(content);
  const hasTaskWithTagAndSpec =
    /^-\s+\[[ x~]\]\s+\*\*T\d+(?:\.\d+)?[^*\n]*\*\*[^\n]*`?\[(?:claude|gemini|you)\]`?[^\n]*\[\[SPEC#[^\]]+\]\]/im.test(
      content,
    );
  const hasCheck = /^\s*check\s*:\s*\S+/im.test(content);
  if (!hasMilestone || !hasDoneWhen || !hasTaskWithTagAndSpec || !hasCheck) return false;
  const parsed = parsePlanMarkdown(content);
  if (findDuplicateTaskCode(parsed.tasks)) return false;
  return true;
}

/**
 * Build the kickoff prompt for Claude to generate docs/PLAN.md from docs/SPEC.md (T4.4).
 */
export function buildPlanPrompt(
  projectName: string,
  specContent: string,
  mockApproval?: MockApproval | null,
): string {
  return [
    `[Plan generation] Project: ${projectName}`,
    "",
    "You are writing docs/PLAN.md for this project based on the approved docs/SPEC.md and docs/mock.html.",
    "Group the plan into milestones (one milestone = one release, e.g. `## M1 — v1.0 ...`).",
    "Each milestone must include:",
    "- `Done when:` items that become the release's UAT checklist",
    "- Tasks (`- [ ] **T1.1 Title** `[claude]` — [[SPEC#Section]]`) tagged `[claude]`, `[gemini]`, or `[you]`, linking spec sections as `[[SPEC#...]]`, each with a `check:` line.",
    ...(mockApproval ? [`- Approved mock artifact: ${mockApproval.artifactUrl}`] : []),
    "",
    "--- docs/SPEC.md ---",
    specContent.trim(),
  ].join("\n");
}

/**
 * Prepare a project for the Claude Plan generation session (T4.4).
 * Requires mock approval to be recorded first and refuses if a milestone scope is already frozen.
 */
export function beginPlanSession(
  db: DaedalusDb,
  projectId: number,
  localPath: string,
  project: ProjectLike,
): { prompt: string; state: ShapingState } {
  const row = readShapingStateRow(db, projectId);
  if (row?.activeMilestoneFrozen) {
    throw new ShapingError("Milestone scope is frozen. Submit a change request to modify the plan.", 409);
  }

  const stateBefore = getShapingState(db, projectId, localPath, project);
  if (!stateBefore.mock.approved) {
    throw new ShapingError("Approve the mock before starting plan generation.", 400);
  }
  if (!stateBefore.spec.content) {
    throw new ShapingError("docs/SPEC.md is required before starting plan generation.", 400);
  }

  writeShapingStateRow(db, projectId, {
    planApprovedAt: null,
  });

  return {
    prompt: buildPlanPrompt(project.name, stateBefore.spec.content, stateBefore.mock.approval),
    state: getShapingState(db, projectId, localPath, project),
  };
}

/**
 * Approve and save docs/PLAN.md (T4.4).
 * Approving the plan only saves it; Start milestone creates the release branch and freezes scope.
 */
export function approvePlanDoc(
  db: DaedalusDb,
  projectId: number,
  localPath: string,
  input: ApprovePlanInput | undefined,
  project: ProjectLike,
): ShapingState & { ok: true; content: string } {
  const row = readShapingStateRow(db, projectId);
  if (row?.activeMilestoneFrozen) {
    throw new ShapingError("Milestone scope is frozen. Submit a change request to modify the plan.", 409);
  }

  const stateBefore = getShapingState(db, projectId, localPath, project);
  if (!stateBefore.mock.approved) {
    throw new ShapingError("Approve the mock before approving the plan.", 400);
  }

  if (typeof input?.content === "string" && input.content.trim().length > 0) {
    writeShapingDoc(localPath, SHAPING_DOCS.plan, input.content);
  }

  const planDoc = readShapingDoc(localPath, SHAPING_DOCS.plan);
  if (!planDoc.exists || !planDoc.content || isKitTemplateDoc(SHAPING_DOCS.plan, planDoc.content)) {
    throw new ShapingError("docs/PLAN.md does not exist yet. Generate the plan first.", 400);
  }

  const parsed = parsePlanMarkdown(planDoc.content);
  const dupCode = findDuplicateTaskCode(parsed.tasks);
  if (dupCode) {
    throw new ShapingError(`docs/PLAN.md has task code ${dupCode} more than once.`, 400);
  }

  if (!isValidPlanMarkdown(planDoc.content)) {
    throw new ShapingError(
      "docs/PLAN.md must include at least one milestone (## M1...), a 'Done when:' UAT checklist, tasks tagged [claude]/[gemini]/[you] with [[SPEC#...]] links, and check: commands.",
      400,
    );
  }

  writeShapingDoc(localPath, SHAPING_DOCS.plan, planDoc.content);
  writeShapingStateRow(db, projectId, {
    planApprovedAt: new Date().toISOString(),
  });

  const state = getShapingState(db, projectId, localPath, project);
  return {
    ...state,
    ok: true,
    content: planDoc.content,
  };
}

/**
 * Normalize a release version string (e.g. "1.0" or "v1.0" -> "v1.0") and validate it.
 */
export function normalizeReleaseVersion(raw?: string): string {
  const trimmed = (raw ?? "").trim() || "v1.0";
  if (!/^v?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) {
    throw new ShapingError(
      `Invalid release version "${trimmed}". Use a version like v1.0 or v1.1.`,
      400,
    );
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

/**
 * Start a milestone (T4.4): creates the release branch `daedalus/release-<version>` from the
 * project's default branch in git and freezes that milestone's scope.
 */
export async function startMilestoneRelease(
  db: DaedalusDb,
  projectId: number,
  localPath: string,
  input: StartMilestoneInput | undefined,
  project: ProjectLike,
  gitOps: {
    branchExists: (dir: string, name: string) => Promise<boolean>;
    createBranch: (dir: string, name: string, opts?: { from?: string }) => Promise<void>;
  } = { branchExists: gitBranchExists, createBranch: gitCreateBranch },
): Promise<ShapingState & { ok: true; milestone: MilestoneState }> {
  const stateBefore = getShapingState(db, projectId, localPath, project);
  if (!stateBefore.plan.approved || !stateBefore.plan.exists) {
    throw new ShapingError("Approve docs/PLAN.md before starting a milestone.", 400);
  }

  const version = normalizeReleaseVersion(input?.version);
  const branch = `daedalus/release-${version}`;
  const fromBranch = (input?.defaultBranch ?? "").trim() || "main";

  if (await gitOps.branchExists(localPath, branch)) {
    throw new ShapingError(`Release branch ${branch} already exists.`, 409);
  }

  await gitOps.createBranch(localPath, branch, { from: fromBranch });

  const milestone: MilestoneState = {
    version,
    branch,
    startedAt: new Date().toISOString(),
    frozen: true,
  };

  writeShapingStateRow(db, projectId, {
    activeMilestoneVersion: version,
    activeMilestoneCode: input?.milestoneCode ?? null,
    activeMilestoneBranch: branch,
    activeMilestoneStartedAt: milestone.startedAt,
    activeMilestoneFrozen: true,
  });

  const state = getShapingState(db, projectId, localPath, project);
  return {
    ...state,
    ok: true,
    milestone,
  };
}
