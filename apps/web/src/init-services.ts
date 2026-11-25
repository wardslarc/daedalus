/** Server-only: builds the services object (server.ts calls this before serving). */
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, projects, tasks as tasksTable, shapingState } from "@daedalus/db";
import { branchExists } from "@daedalus/git";
import { assertProviderAllowed, effectiveGeminiAllowed, ProfileRuleError, rulesFor, validateProjectSettings } from "@daedalus/core/profiles";
import { ackGate, approveMockDoc, approvePlanDoc, approveSpecDoc, approveTask, beginMockSession, beginPlanSession, beginSpecInterview, closeAllReviews, createProject, discardTask, getReview, getShapingState, ImportError, importProject, listFolders, listInReviewTasks, mergeKit, realGitOps, recoverReviewsOnStartup, saveIntakeDoc, sendBack, startCrossReview, startMilestoneRelease, syncPlanTasksToDb, TaskRunner } from "@daedalus/projects";
import { loadProviders, repoProvidersFile, SessionManager, syncProviders } from "@daedalus/providers";
import { SERVICES_KEY, type PipelineStage, type Services, type ServicesHolder } from "./services.js";
import { toSessionInfo } from "./ws/channel.js";
import { TerminalManager } from "./terminal.js";

export type ServicesOptions = { dataDir: string; repoRoot: string };

const holder = globalThis as ServicesHolder;

export function initServices({ dataDir, repoRoot }: ServicesOptions): Services {
  const existing = holder[SERVICES_KEY];
  if (existing) return existing;
  // The providers file is the list of programs Daedalus may launch (T3.1). Validate it
  // before anything else: a broken file stops the server instead of half-loading.
  const providers = loadProviders(process.env.DAE_PROVIDERS_FILE || repoProvidersFile());
  const db = openDb(join(dataDir, "daedalus.db"));
  syncProviders(db, providers);
  const home = process.env.DAE_PROJECTS_HOME || homedir();
  // Run logs (T3.6) live with the database, outside the repo; folders 0700, files 0600.
  const sessions = new SessionManager({ providers, runLogDir: join(dataDir, "runs") });
  const terminals = new TerminalManager();
  const runner = new TaskRunner({
    db,
    dataDir,
    sessions,
    providers,
  });
  runner.recoverOnStartup();
  recoverReviewsOnStartup(db);
  const services: Services = {
    db,
    dataDir,
    repoRoot,
    providers,
    sessions,
    runner,
    runTask: (projectId, taskCode) => runner.runTask(projectId, taskCode),
    listRunning: () => runner.listRunning(),
    startSession: async (projectId, providerId) => {
      // The folder and profile come from the database, never from the browser.
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      return toSessionInfo(await sessions.start(project, providerId));
    },
    listSessions: () => sessions.list().map(toSessionInfo),
    stopSession: async (id) => {
      const s = sessions.get(id);
      if (!s) throw new ImportError("That session isn't running.", 404);
      await s.stop();
    },
    terminals,
    openTerminal: async (projectId) => {
      // The folder comes from the database, never from the browser.
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      return terminals.open(project);
    },
    listTerminals: () => terminals.list(),
    closeTerminal: (id) => terminals.close(id),
    importProject: (input) =>
      importProject(input, {
        db,
        git: realGitOps,
        home,
        forbiddenRoots: [repoRoot, dataDir],
        tmpRoot: tmpdir(),
        today: new Date().toISOString().slice(0, 10),
      }),
    createProject: (input) =>
      createProject(input, {
        db,
        git: realGitOps,
        home,
        today: new Date().toISOString().slice(0, 10),
      }),
    listProjects: async () => {
      const rows = db.select().from(projects).all();
      return Promise.all(
        rows.map(async (p) => {
          let kitPending = false;
          if (existsSync(p.localPath)) {
            try {
              kitPending = await branchExists(p.localPath, "daedalus/kit");
            } catch {
              kitPending = false;
            }
          }
          return {
            ...p,
            kitPending,
          };
        }),
      );
    },
    mergeKit: async (projectId) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      return mergeKit(project, { tmpRoot: tmpdir() });
    },
    browseFolders: (opts) =>
      listFolders({
        path: opts?.path,
        home,
        showHidden: opts?.showHidden,
      }),
    updateProjectSettings: async (id, input) => {
      const project = db.select().from(projects).where(eq(projects.id, id)).get();
      if (!project) throw new ImportError("No such project.", 404);
      const requestedGemini = input.geminiAllowed !== undefined ? input.geminiAllowed : project.geminiAllowed;
      const settings = validateProjectSettings(input.profile, { geminiAllowed: requestedGemini });
      const updated = db
        .update(projects)
        .set({
          profile: settings.profile,
          geminiAllowed: settings.geminiAllowed,
        })
        .where(eq(projects.id, id))
        .returning()
        .get();
      // An agent already running on this project must not outlive a setting that forbids it.
      const stoppedSessions: string[] = [];
      for (const session of services.sessions.list()) {
        if (session.project.id !== id) continue;
        try {
          assertProviderAllowed(updated, session.providerId);
        } catch (err) {
          if (!(err instanceof ProfileRuleError)) throw err;
          await session.stop();
          stoppedSessions.push(session.id);
        }
      }
      return { project: updated, stoppedSessions };
    },
    getProjectChat: async (projectId) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      const rules = rulesFor(project.profile);
      const effectiveGemini = effectiveGeminiAllowed(project);
      const state = getShapingState(db, projectId, project.localPath, project);
      return {
        ...state,
        project,
        rules: { ...rules, effectiveGemini },
      };
    },
    saveIntake: async (projectId, input) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      return saveIntakeDoc(db, projectId, project.localPath, input, project);
    },
    startSpecInterview: async (projectId) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      const { prompt, state } = beginSpecInterview(db, projectId, project.localPath, project);
      let session = sessions.list().find((s) => s.project.id === projectId && s.providerId === "claude");
      if (!session) {
        session = await sessions.start(project, "claude");
      }
      if (session.backlog().length === 0 && !session.isBusy) {
        const turn = session.prompt(prompt);
        turn.catch(() => undefined);
      }
      return { session: toSessionInfo(session), prompt, state };
    },
    approveSpec: async (projectId, input) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      const result = approveSpecDoc(db, projectId, project.localPath, input, project);
      // Stop any running spec interview session on this project to free the session slot for Mock.
      for (const s of sessions.list()) {
        if (s.project.id === projectId && s.providerId === "claude") {
          await s.stop();
        }
      }
      return result;
    },
    startMockSession: async (projectId, providerId) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      const { prompt, state } = beginMockSession(db, projectId, project.localPath, providerId, project);
      for (const s of sessions.list()) {
        if (s.project.id === projectId && s.providerId !== providerId) {
          await s.stop();
        }
      }
      let session = sessions.list().find((s) => s.project.id === projectId && s.providerId === providerId);
      if (!session) {
        session = await sessions.start(project, providerId);
      }
      if (session.backlog().length === 0 && !session.isBusy) {
        const turn = session.prompt(prompt);
        turn.catch(() => undefined);
      }
      return { session: toSessionInfo(session), prompt, state };
    },
    approveMock: async (projectId, input) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      const result = approveMockDoc(db, projectId, project.localPath, input, project);
      // Stop any running mock session on this project to free the session slot for Step 4 (Plan).
      for (const s of sessions.list()) {
        if (s.project.id === projectId) {
          await s.stop();
        }
      }
      return result;
    },
    startPlanSession: async (projectId) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      const { prompt, state } = beginPlanSession(db, projectId, project.localPath, project);
      for (const s of sessions.list()) {
        if (s.project.id === projectId && s.providerId !== "claude") {
          await s.stop();
        }
      }
      let session = sessions.list().find((s) => s.project.id === projectId && s.providerId === "claude");
      if (!session) {
        session = await sessions.start(project, "claude");
      }
      if (session.backlog().length === 0 && !session.isBusy) {
        const turn = session.prompt(prompt);
        turn.catch(() => undefined);
      }
      return { session: toSessionInfo(session), prompt, state };
    },
    approvePlan: async (projectId, input) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      const result = approvePlanDoc(db, projectId, project.localPath, input, project);
      syncPlanTasksToDb(db, projectId, project.localPath);
      for (const s of sessions.list()) {
        if (s.project.id === projectId) {
          await s.stop();
        }
      }
      return result;
    },
    startMilestone: async (projectId, input) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      const result = await startMilestoneRelease(
        db,
        projectId,
        project.localPath,
        {
          version: input?.version,
          defaultBranch: input?.defaultBranch || project.defaultBranch,
        },
        project,
      );
      syncPlanTasksToDb(db, projectId, project.localPath);
      return result;
    },
    getProjectPipeline: async (projectId) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      const rules = rulesFor(project.profile);
      const effectiveGemini = effectiveGeminiAllowed(project);
      const shaping = getShapingState(db, projectId, project.localPath, project);
      const { milestones, tasks } = syncPlanTasksToDb(db, projectId, project.localPath);

      let stage: PipelineStage;
      if (!shaping.plan.approved && !shaping.plan.activeMilestone) {
        switch (shaping.currentStep) {
          case "intake": stage = "Intake"; break;
          case "spec": stage = "Spec"; break;
          case "mock": stage = "Mock"; break;
          case "plan": stage = "Plan"; break;
        }
      } else {
        let activeTasks = tasks;
        if (shaping.plan.activeMilestone?.version) {
          const v = shaping.plan.activeMilestone.version.toLowerCase();
          const matchedMilestone = milestones.find(
            (m) => m.code.toLowerCase() === v || m.title.toLowerCase().includes(v),
          );
          if (matchedMilestone) {
            const codes = new Set(matchedMilestone.tasks.map((t) => t.code));
            activeTasks = tasks.filter((t) => codes.has(t.code));
          }
        } else if (milestones.length > 0) {
          const firstM = milestones[0]!;
          const codes = new Set(firstM.tasks.map((t) => t.code));
          activeTasks = tasks.filter((t) => codes.has(t.code));
        }

        if (activeTasks.length > 0 && activeTasks.every((t) => t.status === "done")) {
          stage = "Verify";
        } else if (activeTasks.some((t) => t.status === "in-review")) {
          stage = "Review";
        } else {
          stage = "Build";
        }
      }

      const totalRunning = db.select().from(tasksTable).where(eq(tasksTable.status, "running")).all().length;
      const shapingRow = db.select().from(shapingState).where(eq(shapingState.projectId, projectId)).get();
      const activeVer = shapingRow?.activeMilestoneVersion?.toLowerCase();
      const activeCode = shapingRow?.activeMilestoneCode?.toLowerCase();

      const enrichedTasks = tasks.map((t) => {
        const lastCheckOutput = runner.getLastCheckOutput(projectId, t.code);
        const taskMilestone = t.milestoneCode?.toLowerCase();
        const matchesActive = Boolean(
          shapingRow?.activeMilestoneFrozen &&
          taskMilestone &&
          ((activeVer && taskMilestone === activeVer) ||
            (activeCode && taskMilestone === activeCode))
        );

        let disabledReason: string | null = null;
        if (t.tag === "you") {
          disabledReason = "Owner task";
        } else if (!t.frozenAt) {
          disabledReason = "Not frozen";
        } else if (!matchesActive) {
          disabledReason = "Not active milestone";
        } else if (totalRunning >= 2) {
          disabledReason = "2 of 2 running";
        }

        const runnable = t.status === "queued" && disabledReason === null;

        return {
          ...t,
          lastCheckOutput,
          runnable,
          disabledReason,
        };
      });

      return {
        project,
        rules: { ...rules, effectiveGemini },
        stage,
        activeMilestone: shaping.plan.activeMilestone,
        milestones,
        tasks: enrichedTasks,
        runningTasksCount: totalRunning,
      };
    },
    getReview: async (projectId, taskCode) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      return getReview(db, project, taskCode, { dataDir });
    },
    listInReviewTasks: async (projectId) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      return listInReviewTasks(db, projectId);
    },
    approveTask: async (projectId, taskCode, headSha) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      return approveTask(db, project, taskCode, headSha, { dataDir });
    },
    sendBack: async (projectId, taskCode, notes, headSha) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      return sendBack(db, project, taskCode, notes, headSha, { dataDir });
    },
    discardTask: async (projectId, taskCode, headSha) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      return discardTask(db, project, taskCode, headSha, { dataDir });
    },
    ackGate: async (projectId, taskCode, gateId, note, headSha, fingerprint) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      return ackGate(db, project, taskCode, gateId, note, headSha, fingerprint);
    },
    startCrossReview: async (projectId, taskCode) => {
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) throw new ImportError("No such project.", 404);
      const res = await startCrossReview(
        {
          db,
          dataDir,
          sessions,
          providers,
        },
        projectId,
        taskCode,
      );
      return { reviewId: res.reviewId };
    },
  };
  holder[SERVICES_KEY] = services;
  return services;
}

/** Stop every agent, close the database and forget the instance (shutdown and tests). */
export async function closeServices(): Promise<void> {
  const services = holder[SERVICES_KEY];
  delete holder[SERVICES_KEY];
  if (!services) return;
  try {
    await Promise.all([
      services.terminals.closeAll(),
      services.runner.stopAll(),
      closeAllReviews(services.db),
    ]);
  } finally {
    services.db.$client.close();
  }
}
