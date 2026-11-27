/**
 * Framework-agnostic rules for the two-player pre-round room.
 *
 * The room may store either a per-player ready flag or a ready count. These
 * helpers keep the transition rule in one place so server, canvas and tests
 * all observe the same 0 -> 1 transition.
 */

export const FIELD_WIDTH = 800;
export const FIELD_HEIGHT = 600;

export const PLAYER_A_X = 160;
export const PLAYER_B_X = 640;
export const PLAYER_Y = 420;
export const INITIAL_SCORE = 4;
export const REQUIRED_READY_PLAYERS = 2;

export type SideId = "A" | "B";

export interface InitialPlayerSpec {
  side: 1 | 2;
  id: SideId;
  name: string;
  x: number;
  y: number;
  score: number;
  ready: boolean;
}

export const INITIAL_PLAYER_SPECS: readonly InitialPlayerSpec[] = [
  {
    side: 1,
    id: "A",
    name: "甲",
    x: PLAYER_A_X,
    y: PLAYER_Y,
    score: INITIAL_SCORE,
    ready: false,
  },
  {
    side: 2,
    id: "B",
    name: "乙",
    x: PLAYER_B_X,
    y: PLAYER_Y,
    score: INITIAL_SCORE,
    ready: false,
  },
] as const;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function initialRound(): 0 {
  return 0;
}

/**
 * Round is monotonic. Reaching two ready players changes the same batch/tick
 * to round 1; later movement or readiness changes must never move it back.
 */
export function nextRound(currentRound: number, readyCount: number): number {
  if (currentRound >= 1) return currentRound;
  return readyCount >= REQUIRED_READY_PLAYERS ? 1 : 0;
}

export function normalizeSide(value: unknown): 1 | 2 | undefined {
  if (value === 1 || value === "1" || value === "A" || value === "a" || value === "甲") {
    return 1;
  }
  if (value === 2 || value === "2" || value === "B" || value === "b" || value === "乙") {
    return 2;
  }
  return undefined;
}

export function parseReadyValue(message: unknown, toggle = false): boolean | undefined {
  if (toggle && (message === undefined || message === null)) {
    return undefined;
  }

  if (typeof message === "boolean") return message;
  if (message === 1 || message === "true" || message === "ready") return true;
  if (message === 0 || message === "false" || message === "not-ready") return false;

  if (message && typeof message === "object") {
    const m = message as Record<string, unknown>;
    for (const key of ["ready", "isReady", "handRaised", "raised", "raisedHand", "hasRaisedHand"]) {
      if (typeof m[key] === "boolean") return m[key] as boolean;
    }
    if (m.ready === 1 || m.handRaised === 1) return true;
    if (m.ready === 0 || m.handRaised === 0) return false;
  }

  // A bare "raise hand" message is an affirmative action.
  return true;
}

function asFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export interface MoveInstruction {
  x?: number;
  y?: number;
}

/**
 * Accepts the conventional {x,y} message plus common alternatives used by
 * clients/tests: {position:{x,y}}, {dx,dy}, {direction:'right'}.
 */
export function parseMoveInstruction(
  message: unknown,
  current: { x: number; y: number },
): MoveInstruction {
  if (typeof message === "number") {
    return { x: message };
  }
  if (!message || typeof message !== "object") return {};

  const m = message as Record<string, any>;
  const nested = m.position ?? m.coordinates ?? m.coords ?? m.to ?? m.target ?? m.point;
  const n = nested && typeof nested === "object" ? nested : {};

  let x = asFiniteNumber(m.x) ?? asFiniteNumber(n.x) ?? asFiniteNumber(m.left);
  let y = asFiniteNumber(m.y) ?? asFiniteNumber(n.y) ?? asFiniteNumber(m.top);

  const dx = asFiniteNumber(m.dx) ?? asFiniteNumber(m.deltaX) ?? asFiniteNumber(m.offsetX);
  const dy = asFiniteNumber(m.dy) ?? asFiniteNumber(m.deltaY) ?? asFiniteNumber(m.offsetY);

  if (x === undefined && dx !== undefined) x = current.x + dx;
  if (y === undefined && dy !== undefined) y = current.y + dy;

  const direction = String(m.direction ?? m.dir ?? m.key ?? "").toLowerCase();
  const step = Math.abs(asFiniteNumber(m.step) ?? 40);

  if (x === undefined) {
    if (["right", "arrowright", "d", "forward", "front", "+x"].includes(direction)) {
      x = current.x + step;
    } else if (["left", "arrowleft", "a", "back", "backward", "-x"].includes(direction)) {
      x = current.x - step;
    }
  }

  if (y === undefined) {
    if (["down", "arrowdown", "s", "+y"].includes(direction)) {
      y = current.y + step;
    } else if (["up", "arrowup", "w", "-y"].includes(direction)) {
      y = current.y - step;
    }
  }

  return { x, y };
}

export function resolveMove(
  message: unknown,
  current: { x: number; y: number },
  bounds: { width: number; height: number } = { width: FIELD_WIDTH, height: FIELD_HEIGHT },
): { x: number; y: number } {
  const instruction = parseMoveInstruction(message, current);
  return {
    x: instruction.x === undefined ? current.x : clamp(instruction.x, 0, bounds.width),
    y: instruction.y === undefined ? current.y : clamp(instruction.y, 0, bounds.height),
  };
}
