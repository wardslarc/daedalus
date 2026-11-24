export class NotImplementedError extends Error {
  override name = "NotImplementedError";
}

export type TaskStatus = "queued" | "running" | "check-failed" | "in-review" | "done";

export type TaskState = {
  status: TaskStatus;
  attempts: number;
};

export type TaskEvent =
  | { type: "start" }
  | { type: "check-passed" }
  | { type: "check-failed" }
  | { type: "approve" }
  | { type: "requeue" };

export type Transition = {
  state: TaskState;
  inbox: "failed_check" | null;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- T5.2: the owner implements the state machine
export function transition(_state: TaskState, _event: TaskEvent): Transition {
  throw new NotImplementedError("T5.2: the owner writes the task state machine (learning mode)");
}
