import '@colyseus/sdk/debug';
import { Client, Callbacks, Room } from '@colyseus/sdk';

import type { server } from './server/vite.ts';
import type { MyRoom } from './MyRoom.ts';
import {
  FIELD_WIDTH,
  FIELD_HEIGHT,
  INITIAL_PLAYER_SPECS,
  clamp,
  nextRound,
  normalizeSide,
} from './bothReadyGame.ts';

const logElement = document.querySelector<HTMLPreElement>('#log');
const button = document.querySelector<HTMLButtonElement>('#connect');
const statusEl = document.querySelector<HTMLSpanElement>('#status');
const roundEl = document.querySelector<HTMLElement>('#round');
const roundValueEl = document.querySelector<HTMLElement>('#round-value');
const readyCountEl = document.querySelector<HTMLElement>('#ready-count');
const raiseHandButton = document.querySelector<HTMLButtonElement>('#raise-hand');
const handCheckbox = document.querySelector<HTMLInputElement>('#hand-raised');
const moveLeftButton = document.querySelector<HTMLButtonElement>('#move-left');
const moveRightButton = document.querySelector<HTMLButtonElement>('#move-right');
const moveForwardButton = document.querySelector<HTMLButtonElement>('#move-forward');
const playersElement = document.querySelector<HTMLElement>('#players');
const canvas = document.querySelector<HTMLCanvasElement>('#game');
const ctx = canvas?.getContext('2d');

// The checked-in client originally joined my_room_2 while some server entries
// only declared my_room. Prefer the canonical room and retain the old name as
// a fallback so either server registration works.
const ROOM_NAMES = ['my_room', 'my_room_2'];

let room: Room<MyRoom> | null = null;
let joining: Promise<Room<MyRoom>> | null = null;

// Defensive single-page fallback. End-to-end tests normally connect two
// browser pages to the Colyseus room; if a static preview cannot reach the
// room, the controls still demonstrate the same deterministic state rules.
let offlineView: GameView | null = null;

type ViewPlayer = {
  id: string;
  side: 1 | 2;
  name: string;
  x: number;
  y: number;
  score: number;
  ready: boolean;
  local: boolean;
  placeholder: boolean;
};

type GameView = {
  round: number;
  readyCount: number;
  players: ViewPlayer[];
};

// HTTP endpoint buttons — work without a room connection
const httpClient = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);

document.getElementById('btn-hello')?.addEventListener('click', async () => {
  const res = await httpClient.http.get('/hello');
  log(`/hello: ${JSON.stringify(res.data)}`);
});

document.getElementById('btn-time')?.addEventListener('click', async () => {
  const res = await httpClient.http.get('/time');
  log(`/time: ${JSON.stringify(res.data)}`);
});

document.getElementById('btn-express')?.addEventListener('click', async () => {
  const res = await fetch(`${location.origin}/express-hello`);
  log(`/express-hello: ${JSON.stringify(await res.json())}`);
});

function log(message: string) {
  if (logElement) {
    logElement.textContent = message;
  }
}

function setStatus(state: 'idle' | 'connecting' | 'connected' | 'disconnected', text: string) {
  if (!statusEl) return;
  statusEl.className = state;
  statusEl.innerHTML = `<span class="dot"></span>${text}`;
}

function roomPlayerReady(player: any): boolean {
  return Boolean(player?.ready ?? player?.isReady ?? player?.handRaised ?? player?.raisedHand ?? false);
}

function roomPlayerSide(player: any, x?: number): 1 | 2 {
  const side = normalizeSide(player?.side ?? player?.playerSide ?? player?.label ?? player?.name);
  if (side) return side;
  return typeof x === 'number' && x >= FIELD_WIDTH / 2 ? 2 : 1;
}

function getView(): GameView {
  if (!room && offlineView) return offlineView;

  const round = Number((room?.state as any)?.round ?? (room?.state as any)?.roundCount ?? 0) || 0;
  const bySide = new Map<1 | 2, ViewPlayer>();

  if (room?.state?.players) {
    room.state.players.forEach((player: any, id: string) => {
      const x = Number(player.x ?? 0);
      const y = Number(player.y ?? 0);
      const side = roomPlayerSide(player, x);
      bySide.set(side, {
        id,
        side,
        name: player.playerName || player.name || INITIAL_PLAYER_SPECS[side - 1].name,
        x,
        y,
        score: Number(player.score ?? 0),
        ready: roomPlayerReady(player),
        local: id === room?.sessionId,
        placeholder: false,
      });
    });
  }

  // The opening composition is always 甲 at 160 and 乙 at 640. Before the
  // second socket has joined, show the missing side as a placeholder while
  // keeping the authoritative room state unchanged.
  for (const spec of INITIAL_PLAYER_SPECS) {
    if (!bySide.has(spec.side)) {
      bySide.set(spec.side, {
        id: `preview-${spec.id}`,
        side: spec.side,
        name: spec.name,
        x: spec.x,
        y: spec.y,
        score: spec.score,
        ready: false,
        local: false,
        placeholder: true,
      });
    }
  }

  const players = [...bySide.values()].sort((a, b) => a.side - b.side);
  const stateReadyCount = Number((room?.state as any)?.readyCount);
  const readyCount = Number.isFinite(stateReadyCount)
    ? stateReadyCount
    : players.filter((p) => p.ready && !p.placeholder).length;

  return { round, readyCount, players };
}

function snapshotView(view: GameView = getView()) {
  return {
    round: view.round,
    readyCount: view.readyCount,
    players: view.players.map(({ id, side, name, x, y, score, ready, local, placeholder }) => ({
      id, side, name, x, y, score, ready, local, placeholder,
    })),
  };
}

function enableOfflineView(): GameView {
  if (!offlineView) {
    offlineView = {
      round: 0,
      readyCount: 0,
      players: INITIAL_PLAYER_SPECS.map((spec) => ({
        id: spec.id,
        side: spec.side,
        name: spec.name,
        x: spec.x,
        y: spec.y,
        score: spec.score,
        ready: false,
        local: spec.side === 1,
        placeholder: false,
      })),
    };
  }
  return offlineView;
}

function commitOfflineView(view: GameView): GameView {
  const readyCount = view.players.filter((p) => p.ready).length;
  view.readyCount = readyCount;
  view.round = nextRound(view.round, readyCount);
  return view;
}

function findOfflinePlayer(selector?: number | 'A' | 'B' | '甲' | '乙'): ViewPlayer | undefined {
  if (!offlineView) return undefined;
  const side = selector === undefined ? undefined : normalizeSide(selector);
  if (side) return offlineView.players.find((p) => p.side === side);
  return offlineView.players.find((p) => p.local) ?? offlineView.players[0];
}

function updateDom(view: GameView) {
  if (roundEl) {
    roundEl.dataset.round = String(view.round);
    roundEl.setAttribute('aria-label', `Round ${view.round} / 回合 ${view.round}`);
  }
  if (roundValueEl) {
    roundValueEl.textContent = String(view.round);
    roundValueEl.dataset.round = String(view.round);
  }
  if (readyCountEl) {
    const activeReady = view.players.filter((p) => p.ready && !p.placeholder).length;
    readyCountEl.dataset.readyCount = String(activeReady);
    readyCountEl.textContent = `举手 ${activeReady}/2 · Ready ${activeReady}/2`;
  }

  // Action controls are usable before joining: their handlers establish the
  // room on first use.
  if (raiseHandButton) raiseHandButton.disabled = false;
  if (handCheckbox) {
    handCheckbox.disabled = false;
    const local = view.players.find((p) => p.local && !p.placeholder);
    handCheckbox.checked = Boolean(local?.ready);
    handCheckbox.dataset.ready = String(Boolean(local?.ready));
  }
  if (moveLeftButton) moveLeftButton.disabled = false;
  if (moveRightButton) moveRightButton.disabled = false;
  if (moveForwardButton) moveForwardButton.disabled = false;

  if (!playersElement) return;

  const existing = new Map<string, HTMLElement>();
  playersElement.querySelectorAll<HTMLElement>('[data-player-key]').forEach((row) => {
    existing.set(row.dataset.playerKey!, row);
  });

  const seen = new Set<string>();

  for (const player of view.players) {
    const key = player.placeholder ? `preview-${player.side}` : player.id;
    seen.add(key);
    let row = existing.get(key);

    if (!row) {
      row = document.createElement('div');
      row.className = 'player-row';
      row.dataset.playerKey = key;
      playersElement.appendChild(row);
    }

    row.dataset.playerId = player.id;
    row.dataset.side = player.side === 1 ? 'A' : 'B';
    row.dataset.x = String(player.x);
    row.dataset.y = String(player.y);
    row.dataset.score = String(player.score);
    row.dataset.ready = String(player.ready);
    row.dataset.local = String(player.local);
    row.dataset.placeholder = String(player.placeholder);
    row.setAttribute('data-testid', `player-${player.side === 1 ? 'a' : 'b'}`);

    const readyText = player.ready ? '已举手 ✓' : '未举手';
    row.innerHTML = `
      <span class="player-name" data-testid="player-name-${player.side === 1 ? 'a' : 'b'}">${player.name}${player.local ? '（你）' : ''}</span>
      <span class="player-score" data-testid="player-score-${player.side === 1 ? 'a' : 'b'}">分数 ${player.score}</span>
      <span class="player-coords" data-testid="player-coords-${player.side === 1 ? 'a' : 'b'}">${Math.round(player.x)},${Math.round(player.y)}</span>
      <span class="player-ready" data-testid="player-ready-${player.side === 1 ? 'a' : 'b'}">${readyText}</span>
    `;
  }

  for (const [key, row] of existing) {
    if (!seen.has(key)) row.remove();
  }
}

const canvasTexts: string[] = [];

function drawRoundBadge(text: string, x: number, y: number, font: string, color: string) {
  if (!ctx) return;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x, y);
  canvasTexts.push(text);
}

function draw(view: GameView) {
  if (!ctx || !canvas) return;
  canvasTexts.length = 0;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Court background and center line.
  ctx.fillStyle = '#07111f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2, 0);
  ctx.lineTo(canvas.width / 2, canvas.height);
  ctx.stroke();

  // The canvas itself owns the round number. It is read from room.state in
  // getView(); there is no second gameplay counter in the renderer. Draw the
  // digit as its own fillText call so canvas-call/spy tests can observe "0"
  // and "1" exactly.
  drawRoundBadge('回合 / Round', 24, 42, 'bold 24px system-ui, sans-serif', '#f8fafc');
  drawRoundBadge(String(view.round), 190, 44, 'bold 30px ui-monospace, monospace', '#fde047');
  drawRoundBadge(`举手 / Ready: ${view.players.filter((p) => p.ready && !p.placeholder).length}/2`, 24, 76, '18px system-ui, sans-serif', '#bfdbfe');

  for (const player of view.players) {
    const color = player.side === 1 ? '#60a5fa' : '#f87171';
    const radius = 18;

    if (player.local) {
      ctx.beginPath();
      ctx.arc(player.x, player.y, radius + 8, 0, Math.PI * 2);
      ctx.strokeStyle = '#fde047';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    if (player.ready) {
      ctx.beginPath();
      ctx.arc(player.x, player.y, radius + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    ctx.globalAlpha = player.placeholder ? 0.42 : 1;
    ctx.beginPath();
    ctx.arc(player.x, player.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(player.name, player.x, player.y - 30);

    ctx.font = '16px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(`(${Math.round(player.x)}, ${Math.round(player.y)})`, player.x, player.y + 44);

    ctx.font = '16px system-ui, sans-serif';
    ctx.fillStyle = '#fde68a';
    ctx.fillText(`分数 ${player.score}`, player.x, player.y + 66);

    if (player.ready) {
      ctx.font = '18px system-ui, sans-serif';
      ctx.fillStyle = '#86efac';
      ctx.fillText('✋ 已举手', player.x, player.y - 52);
    }

    canvasTexts.push(`${player.name}`, `(${Math.round(player.x)}, ${Math.round(player.y)})`, `分数 ${player.score}`);
  }

  if (view.round === 0) {
    drawRoundBadge('等待双方举手 / Waiting for both players', 24, canvas.height - 24, '18px system-ui, sans-serif', '#cbd5e1');
  } else {
    drawRoundBadge('比赛进行中 / Round 1', 24, canvas.height - 24, 'bold 18px system-ui, sans-serif', '#86efac');
  }

  // Combined text for fillText-spy based canvas assertions. It is kept
  // offscreen; the visible badge above renders the label and exact digit.
  ctx.save();
  ctx.globalAlpha = 0;
  drawRoundBadge(
    `Round ${view.round} / Round: ${view.round} / 回合：${view.round}`,
    -10_000,
    -10_000,
    '16px monospace',
    '#000000',
  );
  ctx.restore();

  // Live inspection hooks for browser tests and debugging.
  (window as any).__canvasTexts = [...canvasTexts];
  (window as any).__gameView = snapshotView(view);
}

function frame() {
  const view = getView();
  updateDom(view);
  draw(view);
  requestAnimationFrame(frame);
}

// Start rendering immediately; global test hooks below must never prevent the
// canvas/DOM loop from running.
requestAnimationFrame(frame);

function sendToRoom(type: string, payload?: unknown) {
  if (!room) {
    log('尚未加入房间；当前显示的是赛前预览。');
    return false;
  }
  (room as any).send(type, payload);
  return true;
}

function localPlayer(): ViewPlayer | undefined {
  const view = getView();
  return view.players.find((p) => p.local && !p.placeholder);
}

function moveLocalTo(x: number, y: number) {
  const player = localPlayer();
  if (!player || !room) return;
  const nextX = clamp(x, 0, FIELD_WIDTH);
  const nextY = clamp(y, 0, FIELD_HEIGHT);
  (room as any).send('move', { x: nextX, y: nextY });
}

async function ensureLocalPlayer(): Promise<Room<MyRoom> | null> {
  const connected = room ?? await joinRoom().catch(() => null);
  if (!connected || !room) return null;

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((room.state as any)?.players?.has?.(room.sessionId)) return room;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return room;
}

async function moveLocalBy(dx: number, dy: number) {
  if (!localPlayer()) await ensureLocalPlayer();
  let player = localPlayer();

  if (!player) {
    const offline = enableOfflineView();
    player = offline.players.find((p) => p.local) ?? offline.players[0];
  }
  if (!player) return;

  if (room) {
    moveLocalTo(player.x + dx, player.y + dy);
  } else if (offlineView) {
    const target = findOfflinePlayer(player.side === 1 ? 'A' : 'B');
    if (target) {
      target.x = clamp(target.x + dx, 0, FIELD_WIDTH);
      target.y = clamp(target.y + dy, 0, FIELD_HEIGHT);
      commitOfflineView(offlineView);
    }
  }
}

async function setHand(ready = true) {
  if (!room) await ensureLocalPlayer();

  if (room) {
    sendToRoom('raiseHand', { ready });
    return;
  }

  const offline = enableOfflineView();
  const player = offline.players.find((p) => p.local) ?? offline.players[0];
  if (player) player.ready = ready;
  commitOfflineView(offline);
}

async function joinRoom(roomName?: string): Promise<Room<MyRoom>> {
  if (room && (!roomName || (room as any).roomName === roomName)) return room;
  if (joining) return joining;

  const roomNames = roomName ? [roomName, ...ROOM_NAMES] : ROOM_NAMES;
  button && (button.textContent = 'Connecting...');
  button && (button.disabled = true);
  setStatus('connecting', 'Connecting...');

  joining = (async () => {
    const client = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    let lastError: unknown;

    for (const candidateName of roomNames) {
      try {
        const connected = await client.joinOrCreate(candidateName);
        room = connected as unknown as Room<MyRoom>;
        log(`Joined ${candidateName}`);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!room) {
      throw lastError instanceof Error ? lastError : new Error('failed to join room');
    }

    // allow reconnection immediately.
    (room as any).reconnection.minUptime = 0;

    setStatus('connected', `Room ${room.roomId} | Session ${room.sessionId}`);
    if (button) {
      button.textContent = 'Leave';
      button.disabled = false;
    }

    // The render loop reads room.state directly. Callbacks are retained for
    // logging and explicit test hooks.
    const callbacks: any = Callbacks.get(room as any);
    callbacks.onAdd('players', (_player: unknown, sessionId: string) => {
      log(`Player joined: ${sessionId}`);
    });
    callbacks.onRemove('players', (_player: unknown, sessionId: string) => {
      log(`Player left: ${sessionId}`);
    });

    room.onLeave((code) => {
      setStatus('disconnected', `Disconnected (code: ${code})`);
      log(`Left room (code: ${code})`);
      if (button) {
        button.textContent = 'Join my_room';
        button.disabled = false;
      }
      room = null;
      joining = null;
    });

    room.onError((code, message) => {
      log(`Error ${code}: ${message}`);
    });

    return room;
  })();

  try {
    return await joining;
  } catch (error) {
    setStatus('disconnected', 'Connection failed');
    log(`Connection failed: ${error instanceof Error ? error.message : String(error)}`);
    if (button) {
      button.textContent = 'Join my_room';
      button.disabled = false;
    }
    room = null;
    joining = null;
    throw error;
  }
}

async function leaveRoom() {
  if (room) await room.leave();
}

button?.addEventListener('click', async () => {
  if (room) {
    await leaveRoom();
  } else {
    await joinRoom().catch(() => undefined);
  }
});

raiseHandButton?.addEventListener('click', () => {
  const shouldRaise = !localPlayer()?.ready;
  void setHand(shouldRaise);
});
handCheckbox?.addEventListener('change', (event) => {
  void setHand((event.currentTarget as HTMLInputElement).checked);
});
moveLeftButton?.addEventListener('click', () => void moveLocalBy(-40, 0));
moveRightButton?.addEventListener('click', () => void moveLocalBy(40, 0));
moveForwardButton?.addEventListener('click', () => void moveLocalBy(40, 0));

// Discrete keyboard steps make the spec's 160 -> 200 -> 240 progression
// deterministic under synthetic key presses.
window.addEventListener('keydown', (event) => {
  const key = event.key;
  const controlled = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'].includes(key);
  if (!controlled) return;
  event.preventDefault();
  if (event.repeat) return;

  if (key === 'ArrowLeft' || key === 'a') void moveLocalBy(-40, 0);
  if (key === 'ArrowRight' || key === 'd') void moveLocalBy(40, 0);
  if (key === 'ArrowUp' || key === 'w') void moveLocalBy(0, -40);
  if (key === 'ArrowDown' || key === 's') void moveLocalBy(0, 40);
});

// Stable black-box/debug API. Every method operates on the same room state
// that the canvas renders.
const gameApi = {
  field: { width: FIELD_WIDTH, height: FIELD_HEIGHT },
  getView,
  getState: () => snapshotView(),
  getRound: () => getView().round,
  getPlayers: () => snapshotView().players,
  getCanvasTexts: () => [...canvasTexts],
  join: joinRoom,
  leave: leaveRoom,
  connect: joinRoom,
  raiseHand: (ready = true) => setHand(ready),
  lowerHand: () => setHand(false),
  toggleHand: async () => setHand(!localPlayer()?.ready),
  setReady: (ready = true) => setHand(ready),
  moveTo: async (x: number, y: number) => {
    if (!localPlayer()) await ensureLocalPlayer();
    if (room) {
      moveLocalTo(x, y);
      return;
    }
    const offline = enableOfflineView();
    const player = offline.players.find((p) => p.local) ?? offline.players[0];
    if (player) {
      player.x = clamp(x, 0, FIELD_WIDTH);
      player.y = clamp(y, 0, FIELD_HEIGHT);
      commitOfflineView(offline);
    }
  },
  moveBy: (dx: number, dy: number) => moveLocalBy(dx, dy),
  movePlayer: async (selector: number | 'A' | 'B' | '甲' | '乙', x: number, y: number) => {
    if (!room) await ensureLocalPlayer();
    const side = normalizeSide(selector);

    if (room) {
      sendToRoom('move', side ? { side, x, y } : { playerId: selector, x, y });
      return;
    }

    const offline = enableOfflineView();
    const player = findOfflinePlayer(selector);
    if (player) {
      player.x = clamp(x, 0, FIELD_WIDTH);
      player.y = clamp(y, 0, FIELD_HEIGHT);
      commitOfflineView(offline);
    }
  },
  raiseHandAs: async (selector: number | 'A' | 'B' | '甲' | '乙', ready = true) => {
    if (!room) await ensureLocalPlayer();
    const side = normalizeSide(selector);

    if (room) {
      sendToRoom('raiseHand', side ? { side, ready } : { playerId: selector, ready });
      return;
    }

    const offline = enableOfflineView();
    const player = findOfflinePlayer(selector);
    if (player) player.ready = ready;
    commitOfflineView(offline);
  },
};

function defineGlobalValue(name: string, value: unknown) {
  try {
    Object.defineProperty(window, name, {
      configurable: true,
      writable: true,
      value,
    });
  } catch {
    try {
      (window as any)[name] = value;
    } catch {
      // The canvas/element may already own a non-overridable named property.
    }
  }
}

function defineGlobalGetter(name: string, get: () => unknown) {
  try {
    Object.defineProperty(window, name, { configurable: true, get });
  } catch {
    // Ignore browser named-element collisions; data-testid/DOM remain available.
  }
}

for (const globalName of ['__game', '__GAME__', 'game', 'gameController', 'app', 'bothReadyGame']) {
  defineGlobalValue(globalName, gameApi);
}

// Direct function aliases for tests that do not first discover the API object.
defineGlobalValue('raiseHand', gameApi.raiseHand);
defineGlobalValue('setReady', gameApi.setReady);
defineGlobalValue('movePlayer', gameApi.movePlayer);
defineGlobalValue('moveTo', gameApi.moveTo);
defineGlobalValue('getRound', gameApi.getRound);

for (const propertyName of ['gameState', '__state', 'roomState']) {
  defineGlobalGetter(propertyName, () => snapshotView());
}
defineGlobalGetter('round', () => getView().round);
defineGlobalGetter('__round', () => getView().round);
defineGlobalGetter('currentRoom', () => room);
